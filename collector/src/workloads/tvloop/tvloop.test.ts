/**
 * The `tvloop` workload's decisions, without a Roku.
 *
 * No test here talks to a device or runs tvloop. The step runner is faked to
 * the extent of an exit code and some output, which is enough to pin what this
 * file is actually responsible for: which steps run, what they are handed, what
 * stops the run, that the password never reaches an artifact, that a locked
 * Roku is left alone, and that the lock is always given back.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoTargetsError } from "../../fleet-client.js";
import type { Job, Target, WorkloadCtx } from "../types.js";
import { CLI, commandFor, junitCounts, runWith, stepsFor, type Deps, type StepRunner } from "./index.js";

type Check = (name: string, cond: boolean, detail?: string) => void;
type Row = Record<string, unknown>;

const SECRET = "hunter2-roku";
const roku = (id = "roku-X1"): Target => ({ id, platform: "roku", kind: "device", driver: "roku" });

function fakeCtx(opts: {
  targets?: Target[];
  password?: "ok" | "missing" | "denied";
  granted?: (ids: string[]) => string[];
}) {
  const rows: Row[] = [];
  const uploads: { name: string; text: string }[] = [];
  const lockCalls: string[] = [];
  const ctx: WorkloadCtx = {
    host: "test-host",
    log: () => {},
    postResult: async (row) => {
      rows.push(row);
    },
    postBeacon: async () => {},
    fetchArtifact: async () => {
      throw new Error("tvloop fetches nothing");
    },
    uploadArtifact: async (file, name) => {
      uploads.push({ name, text: readFileSync(file, "utf8") });
      return `sha-${uploads.length}`;
    },
    listTargets: async () => opts.targets ?? [roku()],
    selectTargets: async (_job, all) => all,
    leaseBudgetS: () => 600,
    locks: {
      acquire: async (_j, ids) => {
        lockCalls.push("acquire");
        return new Set(opts.granted ? opts.granted(ids) : ids);
      },
      release: async () => {
        lockCalls.push("release");
      },
    },
    secrets: {
      credentialsFor: async () => null,
      // The real redact, in miniature: every occurrence, replaced.
      redact: (s, secrets) => secrets.reduce((acc, x) => acc.split(x).join("[redacted]"), s),
      rokuDevPassword: async () =>
        opts.password === "missing"
          ? { ok: false, reason: "missing", detail: "not found" }
          : opts.password === "denied"
            ? { ok: false, reason: "denied", detail: "keychain locked" }
            : { ok: true, password: SECRET },
    },
  };
  return { ctx, rows, uploads, lockCalls };
}

/** A built checkout: just the file whose presence means "built". */
function checkout(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tvloop-test-"));
  mkdirSync(path.join(dir, path.dirname(CLI)), { recursive: true });
  writeFileSync(path.join(dir, CLI), "");
  return dir;
}

/** A runner that records each call and answers from `codes` by step name. */
function fakeRunner(codes: Record<string, number>, junit?: string) {
  const calls: { step: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runStep: StepRunner = async (_cmd, args, { env }) => {
    const step = args.includes("doctor") ? "doctor" : args.includes("replay") ? "replay"
      : args.some((a) => a.includes("vitest")) ? "hardware" : "spike";
    calls.push({ step, args, env });
    if (step === "replay" && junit !== undefined) {
      writeFileSync(args[args.indexOf("--out") + 1], junit);
    }
    // A tool that echoes its environment, which is what makes redaction matter.
    return { code: codes[step] ?? 0, output: `ran ${step} with TVLOOP_PASSWORD=${env.TVLOOP_PASSWORD}` };
  };
  return { runStep, calls };
}

const job = (params: Record<string, unknown> = {}, exclusive = true): Job =>
  ({ job_id: "tv-1", workload: "tvloop", params, targets: { exclusive } }) as unknown as Job;

const deps = (dir: string, runStep: StepRunner): Deps => ({
  runStep,
  hostOf: async () => "192.168.50.218",
  env: { FLEET_TVLOOP_DIR: dir },
});

const JUNIT_PASS = '<?xml version="1.0"?><testsuites tests="1" failures="0" errors="0"><testsuite/></testsuites>';
const JUNIT_FAIL = '<testsuites name="tvloop" tests="3" failures="1" errors="1"></testsuites>';

export async function runTvloopChecks(check: Check): Promise<void> {
  // --- pure pieces --------------------------------------------------------
  check("tvloop: default steps are doctor, hardware, replay",
    JSON.stringify(stepsFor(job())) === '["doctor","hardware","replay"]');
  check("tvloop: an unknown step is refused by name", String(stepsFor(job({ steps: ["doctor", "reboot"] }))).includes('"reboot"'));
  const doctor = commandFor("doctor", { host: "10.0.0.9", outDir: "/o", flows: [], node: "node" });
  check("tvloop: doctor is pointed at the locked Roku by address",
    doctor.args.join(" ") === `${CLI} doctor --json --device 10.0.0.9`, doctor.args.join(" "));
  const replay = commandFor("replay", { host: "10.0.0.9", outDir: "/o", flows: ["smoke"], node: "node" });
  check("tvloop: replay writes JUnit into the run's own directory",
    replay.args.includes("--reporter") && replay.args.includes("/o/flows.xml") && replay.args.includes("smoke"));
  check("tvloop: hardware is test:hardware without pnpm",
    commandFor("hardware", { host: "h", outDir: "/o", flows: [] }).env?.TVLOOP_HARDWARE === "1");
  check("tvloop: junit counts, errors included", JSON.stringify(junitCounts(JUNIT_FAIL)) === '{"passed":1,"failed":2}');
  check("tvloop: unreadable junit is a failure, not a pass", junitCounts("garbage").failed === 1);

  // --- no Roku ------------------------------------------------------------
  {
    const { ctx } = fakeCtx({ targets: [{ id: "emulator-5554", platform: "android", driver: "adb" }] });
    let err: unknown;
    try {
      await runWith(job(), ctx, deps(checkout(), fakeRunner({}).runStep));
    } catch (e) {
      err = e;
    }
    check("tvloop: no Roku is a NoTargetsError (a skip, not a failure)", err instanceof NoTargetsError);
  }

  // --- no checkout --------------------------------------------------------
  {
    const { ctx } = fakeCtx({});
    let msg = "";
    try {
      await runWith(job(), ctx, deps(path.join(os.tmpdir(), "no-such-tvloop"), fakeRunner({}).runStep));
    } catch (e) {
      msg = (e as Error).message;
    }
    check("tvloop: a missing checkout fails and says how to build one", /corepack pnpm/.test(msg), msg);
  }

  // --- no password --------------------------------------------------------
  {
    const { ctx, rows, lockCalls } = fakeCtx({ password: "missing" });
    const r = fakeRunner({});
    await runWith(job(), ctx, deps(checkout(), r.runStep));
    const last = rows.at(-1) ?? {};
    check("tvloop: a missing password is a skip with the command to fix it",
      last.final === true && last.ok === true && /^skipped: .*add-generic-password/.test(String(last.error)), JSON.stringify(last));
    check("tvloop: ...and runs nothing and locks nothing", r.calls.length === 0 && lockCalls.length === 0);
  }
  {
    const { ctx } = fakeCtx({ password: "denied" });
    let threw = false;
    try {
      await runWith(job(), ctx, deps(checkout(), fakeRunner({}).runStep));
    } catch {
      threw = true;
    }
    check("tvloop: a locked Keychain is a failure, not a skip", threw);
  }

  // --- the happy path -----------------------------------------------------
  {
    const { ctx, rows, uploads, lockCalls } = fakeCtx({});
    const r = fakeRunner({}, JUNIT_PASS);
    await runWith(job(), ctx, deps(checkout(), r.runStep));
    const dev = rows.find((x) => x.device_id === "roku-X1") ?? {};
    check("tvloop: runs the three default steps in order",
      r.calls.map((c) => c.step).join(",") === "doctor,hardware,replay", r.calls.map((c) => c.step).join(","));
    check("tvloop: hands tvloop the password in its env", r.calls.every((c) => c.env.TVLOOP_PASSWORD === SECRET));
    check("tvloop: the password never reaches an artifact",
      uploads.length > 0 && uploads.every((u) => !u.text.includes(SECRET)), uploads.map((u) => u.name).join(","));
    check("tvloop: a passing replay is an ok row with its counts",
      dev.ok === true && (dev.test as { passed?: number })?.passed === 1, JSON.stringify(dev));
    check("tvloop: lock taken and given back", lockCalls.join(",") === "acquire,release");
    check("tvloop: closes with an ok final row", rows.at(-1)?.final === true && rows.at(-1)?.ok === true);
  }

  // --- a failed doctor stops the run --------------------------------------
  {
    const { ctx, rows, lockCalls } = fakeCtx({});
    const r = fakeRunner({ doctor: 1 });
    await runWith(job(), ctx, deps(checkout(), r.runStep));
    const dev = rows.find((x) => x.device_id === "roku-X1") ?? {};
    check("tvloop: nothing runs after a failed doctor", r.calls.length === 1);
    check("tvloop: ...and the row says why", dev.ok === false && /doctor failed/.test(String(dev.error)), JSON.stringify(dev));
    check("tvloop: ...and the lock is still released", lockCalls.at(-1) === "release");
    check("tvloop: ...and the job is not ok", rows.at(-1)?.ok === false);
  }

  // --- a failing flow fails the row even if replay's exit code lied -------
  {
    const { ctx, rows } = fakeCtx({});
    await runWith(job(), ctx, deps(checkout(), fakeRunner({}, JUNIT_FAIL).runStep));
    const dev = rows.find((x) => x.device_id === "roku-X1") ?? {};
    check("tvloop: failures in the JUnit fail the row", dev.ok === false, JSON.stringify(dev));
  }

  // --- someone else holds the Roku ----------------------------------------
  {
    const { ctx, rows } = fakeCtx({ granted: () => [] });
    const r = fakeRunner({});
    await runWith(job(), ctx, deps(checkout(), r.runStep));
    const dev = rows.find((x) => x.device_id === "roku-X1") ?? {};
    check("tvloop: a Roku locked by another job is skipped, not touched",
      r.calls.length === 0 && dev.ok === true && /^skipped: device locked/.test(String(dev.error)), JSON.stringify(dev));
  }

  // --- not exclusive: no lock calls at all --------------------------------
  {
    const { ctx, lockCalls } = fakeCtx({});
    await runWith(job({}, false), ctx, deps(checkout(), fakeRunner({}, JUNIT_PASS).runStep));
    check("tvloop: a non-exclusive job takes no locks", lockCalls.length === 0);
  }
}
