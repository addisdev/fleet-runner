/**
 * The ui-test side of regression tests, with no device: which app a job asks
 * for, how a stored flow is made runnable, what a run is judged, and what is
 * reported -- against fake crash readings and a fake Maestro.
 *
 * Run from scripts/smoke.ts like the other decision checks. What it cannot
 * show is Maestro and adb themselves, which only a device can.
 */
import path from "node:path";
import { flowAppId, judgeRegression, prepareFlow, regressionApp, runRegressions, type CrashReading, type RegressionDeps } from "./regressions.js";
import type { Target } from "./types.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

export async function runRegressionChecks(check: Check) {
  // Which app.
  check("regressions: no param, no regressions", regressionApp({ params: {} }) === null);
  check("regressions: a name is the app", regressionApp({ params: { regressions: "greenfolio" } }) === "greenfolio");
  check("regressions: true is job.app.name",
    regressionApp({ params: { regressions: true }, app: { name: "greenfolio-android", build: "1", sha256: "latest" } }) === "greenfolio-android");
  check("regressions: true with no app, or a nonsense value, fails the job",
    throws(() => regressionApp({ params: { regressions: true } })) && throws(() => regressionApp({ params: { regressions: 7 } })));

  // Making a stored flow runnable.
  const root = path.resolve("/lab/flows");
  const flow = 'appId: com.example.app.debug\nname: "x"\n---\n- launchApp:\n    clearState: true\n- runFlow: "greenfolio/login.yaml"\n- tapOn:\n    point: "50%,50%"\n';
  const ready = prepareFlow(flow, { appId: "com.example.app.smoke", flowsDir: root });
  check("prepare: the job's appId replaces the recorded one", /^appId: com\.example\.app\.smoke$/m.test(ready) && !ready.includes(".debug"), ready);
  check("prepare: a relative runFlow is resolved under the flows dir",
    ready.includes(`- runFlow: ${JSON.stringify(path.join(root, "greenfolio/login.yaml"))}`), ready);
  check("prepare: without an appId the flow keeps its own", flowAppId(prepareFlow(flow, { flowsDir: root })) === "com.example.app.debug");
  check("prepare: a runFlow escaping the flows dir is refused",
    throws(() => prepareFlow('appId: a\n---\n- runFlow: "../../etc/x.yaml"\n', { flowsDir: root })));
  check("prepare: a parameterised appId is not a package", flowAppId("appId: ${APP_ID}\n---\n") === null);

  // Judging.
  const none = { count: 0, signatures: [], problem: null };
  const one = { count: 1, signatures: ["java.lang.NullPointerException: boom"], problem: null };
  const r1 = judgeRegression({ check: "crash", platform: "android", flowError: "Element not found", before: none, after: one });
  check("judge: a new crash during a crash finding's flow is reproduced", r1.outcome === "reproduced" && r1.detail.includes("NullPointerException"), r1.detail);
  const r2 = judgeRegression({ check: "anr", platform: "android", flowError: null, before: one, after: one });
  check("judge: no new crash and a clean flow passes", r2.outcome === "passed");
  const r3 = judgeRegression({ check: "crash", platform: "android", flowError: "Assertion failed", before: none, after: none });
  check("judge: a failing flow with no crash is failed, not reproduced", r3.outcome === "failed" && /no crash/.test(r3.detail));
  const r4 = judgeRegression({ check: "crash", platform: "ios", flowError: null, before: null, after: null });
  check("judge: on iOS a crash finding's clean replay passes and says the crash was not checked", r4.outcome === "passed" && /not checked/.test(r4.detail), r4.detail);
  const r5 = judgeRegression({ check: "dead_control", platform: "android", flowError: "Element not found", before: none, after: none });
  check("judge: other checks never reproduce; a failing flow is failed with the honest caveat", r5.outcome === "failed" && /cannot tell/.test(r5.detail));
  const r6 = judgeRegression({ check: "visual", platform: "android", flowError: null, before: none, after: one });
  check("judge: a crash during a visual finding's flow does not count as that finding", r6.outcome === "passed" && /replayed without error/.test(r6.detail));
  const r7 = judgeRegression({ check: "crash", platform: "android", flowError: null, before: { count: 0, signatures: [], problem: "logcat could not be read" }, after: none });
  check("judge: an unreadable crash log is said, not guessed", r7.outcome === "passed" && /logcat could not be read/.test(r7.detail));

  // Running: the right flows, the readings around each, and a report for each.
  const android: Target = { id: "pixel", platform: "android", kind: "device" } as Target;
  const crashes: CrashReading[] = [none, one, one, one];
  const ran: { file: string; env: Record<string, string> }[] = [];
  const reports: { id: number; body: Record<string, unknown> }[] = [];
  const deps: RegressionDeps = {
    runFlow: async (_t, file, _cwd, env) => { ran.push({ file, env }); return ran.length === 2 ? "maestro failed: password=hunter2 Element not found" : null; },
    readCrashes: async () => crashes.shift() ?? one,
    report: async (id, body) => { reports.push({ id, body }); },
  };
  const out = await runRegressions({
    job: { job_id: "nightly-1", app: { name: "app", build: "2.0 (7)", sha256: "x" } }, target: android, appId: "com.example.app",
    env: { TEST_PASSWORD: "hunter2" }, secrets: ["hunter2"], flowsDir: root,
    flows: [
      { finding_id: 1, app: "app", platform: "android", check: "crash", kind: "maestro", flow: "appId: com.example.app\n---\n- launchApp\n" },
      { finding_id: 2, app: "app", platform: "android", check: "goal", kind: "maestro", flow: "appId: com.example.app\n---\n- launchApp\n" },
      { finding_id: 3, app: "app", platform: "ios", check: "crash", kind: "maestro", flow: "appId: com.example.app\n---\n" },
      { finding_id: 4, app: "app", platform: "android", check: "crash", kind: "tvloop", flow: "{}" },
    ],
  }, deps);
  check("run: only this platform's flows, in order", out.map((r) => r.finding_id).join(",") === "1,2,4", JSON.stringify(out));
  check("run: the crash during flow 1 is reproduced", out[0].outcome === "reproduced");
  check("run: the goal flow that failed is failed, and the password is redacted", out[1].outcome === "failed" && !out[1].detail.includes("hunter2"), out[1].detail);
  check("run: a tvloop flow is skipped, not run", out[2].outcome === "skipped" && ran.length === 2);
  check("run: the flow gets APP_ID and the sign-in env", ran[0].env.APP_ID === "com.example.app" && ran[0].env.TEST_PASSWORD === "hunter2");
  check("run: each is reported with the job, device and build",
    reports.length === 3 && reports[0].id === 1 && reports[0].body.outcome === "reproduced" && reports[0].body.build === "2.0 (7)"
      && reports[0].body.device_id === "pixel" && reports[0].body.job_id === "nightly-1", JSON.stringify(reports[0]));
}
