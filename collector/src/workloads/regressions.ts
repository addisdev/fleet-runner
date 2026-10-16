/**
 * Regression tests from fixed findings, as the ui-test workload runs them.
 *
 * Night QA files a finding with a Maestro flow that replays its steps. A
 * person marks it real (the collector keeps the flow as a candidate), then
 * fixed once a fix has merged (the flow becomes active). A ui-test job with
 * `params.regressions` asks the collector for the app's active flows at run
 * time and runs each on every device it tests, after the suite's own flow:
 *
 *   params.regressions: "greenfolio"   the explore app key the findings are filed under
 *   params.regressions: true           the same as job.app.name
 *
 * Pulled at run time rather than copied into the lab's flows directory
 * because that directory is outside git: a flow written there by the
 * collector would be a file nobody reviews and nothing backs up, on one
 * machine. The flow text lives in the collector's database instead, and a
 * nightly that already exists picks up every newly fixed finding without
 * anyone editing its schedule.
 *
 * ## What a run can assert
 *
 * A replay flow repeats the steps that led to the bug. For a crash or an ANR
 * that is enough: on Android the crash buffer (`logcat -b crash`, and
 * `am_anr` in the events buffer) is read before and after the flow, and a new
 * crash of the package during it is the bug coming back -- `reproduced`,
 * which reopens the finding. For every other check (frozen, dead_control,
 * goal, visual...) the oracle that found it is a model or a heuristic the
 * flow does not carry, so the honest claim is weaker: the flow replays
 * without error. A flow that fails is reported `failed` and fails the device's
 * row, but does not reopen anything, because a step that no longer replays
 * may be the bug or may be a redesigned screen. On iOS there is no crash
 * buffer read here, so a crash finding's flow is also "replays without
 * error" there, and the result says so.
 *
 * tvloop flows (a Roku's) are kept by the collector but not run by ui-test,
 * which drives Maestro; they are reported `skipped`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, exec, post } from "../fleet-client.js";
import { parseCrashLogcat } from "../soak-samples.js";
import { redact } from "../secrets.js";
import { parseAnrEvents } from "./explore/actuators/android.js";
import { ADB } from "./device.js";
import { FLOWS_DIR, runFlow } from "./flows.js";
import type { Job, Target } from "./types.js";

/** One regression as `GET /findings/regressions` returns it (the fields this needs). */
export type RegressionFlow = {
  finding_id: number;
  app: string;
  platform: string;
  check: string;
  kind: "maestro" | "tvloop";
  flow: string;
};

export type RegressionResult = {
  finding_id: number;
  outcome: "passed" | "reproduced" | "failed" | "skipped";
  detail: string;
};

/** Checks whose absence a replay can show: the crash buffer says whether it happened again. */
const ABSENCE = new Set(["crash", "anr"]);

/**
 * Which app's regressions the job asks for, or null when it asks for none.
 * Throws on a value that cannot name one, so a typo fails the job instead of
 * quietly running nothing.
 */
export function regressionApp(job: Pick<Job, "params" | "app">): string | null {
  const v = job.params?.regressions;
  if (v === undefined || v === false || v === null) return null;
  if (v === true) {
    if (!job.app?.name) throw new Error("params.regressions: true needs job.app.name; or name the app: params.regressions: \"<app>\"");
    return job.app.name;
  }
  if (typeof v === "string" && /^[\w.@:+-]{1,200}$/.test(v)) return v;
  throw new Error("params.regressions must be true or the app name its findings are filed under");
}

/** The appId a flow declares, if it declares a literal one. */
export function flowAppId(flow: string): string | null {
  const m = /^appId:\s*(\S+)/m.exec(flow);
  return m && !/\$\{/.test(m[1]) ? m[1] : null;
}

/**
 * Make a stored flow runnable here.
 *
 * - `appId` is replaced by the job's suite.app_id when it sets one: the flow
 *   was recorded against whatever variant night QA explored (often `.debug`),
 *   and the nightly may be testing another.
 * - `runFlow: "relative/path.yaml"` (the mission's sign-in flow) is resolved
 *   against the flows directory, because the stored flow is written to a temp
 *   file and Maestro resolves a relative runFlow against the file it is in. A
 *   path that escapes the flows directory is refused, as resolveFlow does for
 *   job specs.
 */
export function prepareFlow(flow: string, opts: { appId?: string | null; flowsDir?: string } = {}): string {
  const root = path.resolve(opts.flowsDir ?? FLOWS_DIR);
  let out = flow;
  if (opts.appId) out = out.replace(/^appId:\s*\S+/m, `appId: ${opts.appId}`);
  return out.replace(/^(\s*-\s*runFlow:\s*)(["']?)([^"'\n]+?)\2\s*$/gm, (_m, lead: string, _q: string, rel: string) => {
    if (path.isAbsolute(rel)) return `${lead}${JSON.stringify(rel)}`;
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`the flow's runFlow ${rel} escapes the flows dir`);
    return `${lead}${JSON.stringify(abs)}`;
  });
}

/** Crashes and ANRs of `pkg` in the device's buffers so far; null where nothing here can read them. */
export type CrashReading = { count: number; signatures: string[]; problem: string | null } | null;

/**
 * Decide one run. Pure: everything it needs is passed in.
 *
 * `before`/`after` are crash readings around the flow; null means the
 * platform has no crash log this reads (anything but Android).
 */
export function judgeRegression(o: {
  check: string; platform: string; flowError: string | null; before: CrashReading; after: CrashReading;
}): Omit<RegressionResult, "finding_id"> {
  const flowFailed = o.flowError ? `the flow failed: ${o.flowError.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}` : null;
  if (ABSENCE.has(o.check)) {
    if (o.before && o.after && !o.before.problem && !o.after.problem) {
      const fresh = Math.max(0, o.after.count - o.before.count);
      if (fresh > 0) {
        const sig = o.after.signatures.slice(-fresh)[0] ?? "crash";
        return { outcome: "reproduced", detail: `the app crashed again during the flow: ${sig}` };
      }
      return flowFailed ? { outcome: "failed", detail: `${flowFailed} (no crash of the app during it)` } : { outcome: "passed", detail: "no crash of the app during the flow" };
    }
    const why = o.before?.problem ?? o.after?.problem ?? `no crash log is read on ${o.platform}`;
    return flowFailed
      ? { outcome: "failed", detail: `${flowFailed}; crash not checked (${why})` }
      : { outcome: "passed", detail: `replayed without error; crash not checked (${why})` };
  }
  return flowFailed
    ? { outcome: "failed", detail: `${flowFailed}. A ${o.check} finding's flow cannot tell the bug from a changed screen; look before reopening it` }
    : { outcome: "passed", detail: `replayed without error (a ${o.check} finding's flow cannot assert the bug's absence, only that the steps still run)` };
}

/** The Android crash and ANR count for `pkg`, the way the explore actuator reads it. */
export async function readCrashes(target: Target, pkg: string): Promise<CrashReading> {
  if (target.platform !== "android") return null;
  try {
    const crash = await exec(ADB, ["-s", target.id, "logcat", "-b", "crash", "-d", "-t", "4000"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const c = parseCrashLogcat(crash.stdout, pkg);
    if (c.problem) return { count: 0, signatures: [], problem: c.problem };
    const events = await exec(ADB, ["-s", target.id, "logcat", "-b", "events", "-d", "-t", "4000"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
      .then((r) => parseAnrEvents(r.stdout, pkg))
      .catch(() => [] as string[]);
    return { count: c.count + events.length, signatures: [...c.signatures, ...events], problem: null };
  } catch (e) {
    return { count: 0, signatures: [], problem: `logcat could not be read: ${(e as Error).message.slice(0, 120)}` };
  }
}

/** The app's active regression flows, from the collector. */
export async function fetchRegressions(app: string): Promise<RegressionFlow[]> {
  const res = await fetch(`${BASE}/findings/regressions?app=${encodeURIComponent(app)}&state=active`);
  if (!res.ok) throw new Error(`GET /findings/regressions -> ${res.status}`);
  return ((await res.json()) as { regressions: RegressionFlow[] }).regressions;
}

export type RegressionDeps = {
  runFlow: (t: Target, file: string, cwd: string, env: Record<string, string>, timeoutMs: number) => Promise<string | null>;
  readCrashes: (t: Target, pkg: string) => Promise<CrashReading>;
  report: (findingId: number, body: Record<string, unknown>) => Promise<void>;
};

const LIVE: RegressionDeps = {
  runFlow,
  readCrashes,
  report: (id, body) => post(`/findings/${id}/regression`, body),
};

/**
 * Run the regressions that apply to this target, report each to the
 * collector, and return them for the device's result row.
 */
export async function runRegressions(o: {
  job: Pick<Job, "job_id" | "app">; target: Target; flows: RegressionFlow[];
  appId?: string | null; env?: Record<string, string>; secrets?: string[]; flowsDir?: string; timeoutMs?: number;
}, deps: RegressionDeps = LIVE): Promise<RegressionResult[]> {
  const out: RegressionResult[] = [];
  const build = o.job.app?.build ?? "installed";
  const mine = o.flows.filter((f) => f.platform === o.target.platform);
  if (!mine.length) return out;
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-regressions-"));
  for (const f of mine) {
    let result: Omit<RegressionResult, "finding_id">;
    if (f.kind !== "maestro") {
      result = { outcome: "skipped", detail: `a ${f.kind} flow; ui-test runs Maestro flows only` };
    } else {
      try {
        const text = prepareFlow(f.flow, { appId: o.appId, flowsDir: o.flowsDir });
        const pkg = flowAppId(text) ?? o.appId ?? "";
        const file = path.join(dir, `finding-${f.finding_id}.yaml`);
        writeFileSync(file, text);
        const before = pkg ? await deps.readCrashes(o.target, pkg) : null;
        let flowError = await deps.runFlow(o.target, file, path.join(dir, `run-${f.finding_id}`),
          { ...(o.appId ? { APP_ID: o.appId } : {}), ...(o.env ?? {}) }, o.timeoutMs ?? 300_000);
        if (flowError && o.secrets?.length) flowError = redact(flowError, o.secrets);
        const after = pkg ? await deps.readCrashes(o.target, pkg) : null;
        result = judgeRegression({ check: f.check, platform: o.target.platform, flowError, before, after });
      } catch (e) {
        result = { outcome: "failed", detail: `could not run the flow: ${(e as Error).message.slice(0, 300)}` };
      }
    }
    out.push({ finding_id: f.finding_id, ...result });
    await deps.report(f.finding_id, {
      job_id: o.job.job_id, device_id: o.target.id, build, outcome: result.outcome, detail: result.detail,
    }).catch(() => { /* the device row still carries it; a missed report is not a failed test */ });
  }
  return out;
}
