/**
 * Replaying a TV finding with tvloop.
 *
 * A finding is not believed until it happens again on a clean start (T1 in the
 * plan). On a phone the replay is a Maestro flow; on a TV it is a tvloop flow,
 * because tvloop already has a flow format, a runner, a JUnit reporter and
 * `tvloop replay` -- and because a flow file is something a person can run by
 * hand at their desk, which a fleet-internal format would not be.
 *
 * Two halves:
 *
 *   tvloopFlow()     pure: the key presses and waits of a trajectory into a
 *                    flow document (packages/flow/src/model.ts's format).
 *   runTvloopFlow()  runs such a file through the tvloop CLI against one
 *                    device and says whether it passed, and if not, where.
 *
 * ## Deterministic, which means waits and not "wait until it settles"
 *
 * tvloop has a `waitStable` step that polls screenshots until two match. It is
 * the right tool for a person recording a flow, and the wrong one here: the
 * screens an explorer finds bugs on are the ones that animate (a player, a
 * spinner, a channel dip), where waitStable times out and the replay fails for
 * a reason that has nothing to do with the bug. A fixed wait after each press
 * is what the explorer actually did, so it is what the replay does.
 *
 * ## Pass and fail mean what tvloop means
 *
 * The flow ends with `assert: { noErrors: true }` -- no error-level log event
 * since the flow started, which on a Roku includes every crash (tvloop's
 * console parser makes a crash one error event). So a crash finding
 * REPRODUCES when the replay FAILS on that assertion. The runner reports the
 * failing step and its message, and the caller -- which knows what it was
 * trying to reproduce -- decides.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, deviceToml, TV_ALIAS, type TvloopDevice } from "../tvloop/index.js";
import { TVLOOP_KEYS, tvloopCheckout, type TvloopKey } from "./actuators/roku.js";
import type { Action } from "./types.js";

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

/** One step of a tvloop flow, as the YAML/JSON document spells it. */
export type TvloopFlowStep =
  | "launch"
  | { launch: { deeplink: Record<string, string> } }
  | { press: TvloopKey[] }
  | { type: string }
  | { wait: string }
  | { assert: { noErrors?: boolean; focus?: string } };

/** A flow document: what `tvloop replay` reads from a .json or .yaml file. */
export type TvloopFlowDoc = {
  name: string;
  description?: string;
  /** "any": the flow is not tied to one configured device alias. */
  device: "any";
  steps: TvloopFlowStep[];
};

export type TvloopFlowOptions = {
  /** Becomes the file's flow name and the JUnit test name. */
  name: string;
  description?: string;
  /**
   * Start with a launch (default true), with these launch parameters if
   * given. The replay is meant to start where the mission started: the app,
   * just opened.
   */
  launch?: boolean | Record<string, string>;
  /** Wait after the launch, for the first scene. Default 3000ms. */
  launchSettleMs?: number;
  /** Wait after each press when the trajectory did not say. Default 800ms. */
  settleMs?: number;
  /** End by asserting no error-level log events (default true). */
  noErrors?: boolean;
  /**
   * End by asserting the focused node. Roku with the agent only: tvloop's
   * Android TV adapter has no inspect, so this assertion fails there.
   */
  focus?: string;
};

/**
 * A trajectory's actions as a tvloop flow.
 *
 * Keys become presses, typing becomes a `type` step (preceded by backspaces
 * when the explorer overwrote the field, followed by enter when it pressed
 * it), and waits are kept. A wait right after a press replaces the default
 * settle rather than adding to it, so a trajectory that says exactly how long
 * it waited is replayed exactly.
 *
 * Anything else -- a tap, a swipe -- cannot be a TV replay, and is refused by
 * name rather than dropped: a replay with a step missing reproduces a
 * different path, and "did not reproduce" would then be a lie about the bug.
 */
export function tvloopFlow(actions: Action[], opts: TvloopFlowOptions): TvloopFlowDoc {
  const settle = `${Math.max(0, Math.round(opts.settleMs ?? 800))}ms`;
  const steps: TvloopFlowStep[] = [];
  const launch = opts.launch ?? true;
  if (launch) {
    steps.push(launch === true || Object.keys(launch).length === 0 ? "launch" : { launch: { deeplink: launch } });
    steps.push({ wait: `${Math.max(0, Math.round(opts.launchSettleMs ?? 3000))}ms` });
  }
  actions.forEach((a, i) => {
    const nextIsWait = actions[i + 1]?.kind === "wait";
    switch (a.kind) {
      case "key":
        steps.push({ press: [TVLOOP_KEYS[a.key]] });
        if (!nextIsWait) steps.push({ wait: settle });
        return;
      case "type":
        if (a.x !== undefined || a.y !== undefined) {
          throw new Error(`action ${i + 1} types at a screen position; a TV replay can only press keys`);
        }
        if (a.overwrite) steps.push({ press: Array(40).fill("backspace") as TvloopKey[] });
        if (a.text) steps.push({ type: a.text });
        if (a.enter) steps.push({ press: ["enter"] });
        if (!nextIsWait) steps.push({ wait: settle });
        return;
      case "wait":
        steps.push({ wait: `${Math.max(0, Math.round(a.ms))}ms` });
        return;
      default:
        throw new Error(`action ${i + 1} is a ${a.kind}; a TV replay can only press keys, type and wait`);
    }
  });
  const asserts: { noErrors?: boolean; focus?: string } = {};
  if (opts.noErrors ?? true) asserts.noErrors = true;
  if (opts.focus) asserts.focus = opts.focus;
  // One assertion per step: tvloop reports the first failing step, and a
  // focus mismatch and a crash are different findings.
  if (asserts.focus) steps.push({ assert: { focus: asserts.focus } });
  if (asserts.noErrors) steps.push({ assert: { noErrors: true } });
  return {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    device: "any",
    steps,
  };
}

/**
 * The flow as file text. JSON, which `tvloop replay` reads by its .json
 * extension: exact, with no YAML quoting rules to get wrong for a channel
 * name full of colons.
 */
export function tvloopFlowFile(doc: TvloopFlowDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** What one replay came to. */
export type TvloopReplayResult = {
  status: "passed" | "failed" | "error";
  /** The first failing step's label ("assert no errors") and tvloop's message. */
  failedStep: string | null;
  message: string | null;
  durationMs: number;
  /** tvloop's own JSON result, when it produced one. */
  raw: unknown;
};

/**
 * `tvloop replay --json` output into a result.
 *
 * The CLI prints `{ "results": [FlowResult] }` and nothing else on stdout in
 * JSON mode, but it is found by its opening key rather than parsed whole, so
 * a stray warning on stdout from a future version does not turn a real result
 * into an "error".
 */
export function parseReplayOutput(stdout: string, exitCode: number): TvloopReplayResult {
  const at = stdout.search(/\{\s*"results"\s*:/);
  if (at < 0) {
    return {
      status: "error", failedStep: null, durationMs: 0, raw: null,
      message: `tvloop replay exited ${exitCode} without a result: ${stdout.trim().slice(-300) || "(no output)"}`,
    };
  }
  let parsed: { results?: { status: string; durationMs: number; steps: { label: string; status: string; message?: string }[] }[] };
  try {
    parsed = JSON.parse(stdout.slice(at));
  } catch (e) {
    return { status: "error", failedStep: null, durationMs: 0, raw: null, message: `unreadable tvloop result: ${(e as Error).message}` };
  }
  const results = parsed.results ?? [];
  const failed = results.flatMap((r) => r.steps).find((s) => s.status === "failed");
  return {
    status: results.length > 0 && results.every((r) => r.status === "passed") ? "passed" : "failed",
    failedStep: failed?.label ?? null,
    message: failed?.message ?? null,
    durationMs: results.reduce((n, r) => n + (r.durationMs ?? 0), 0),
    raw: parsed,
  };
}

// ---------------------------------------------------------------------------
// The running half
// ---------------------------------------------------------------------------

export type RunTvloopFlowOptions = {
  device: TvloopDevice;
  /** Roku only: the developer password, passed to tvloop's environment and nowhere else. */
  password?: string;
  /** The tvloop checkout. Default: FLEET_TVLOOP_DIR, then ~/tvloop, as the tvloop workload finds it. */
  dir?: string;
  timeoutMs?: number;
};

/**
 * Run one flow file through `tvloop replay` against one device.
 *
 * The device comes from a generated tvloop.toml in a fresh directory rather
 * than from flags, for both platforms: an Android TV can only be named that
 * way, and a Roku named that way never picks up whatever device the
 * checkout's own tvloop.toml happens to configure. `--no-daemon` keeps it off
 * any tvloop daemon somebody left running on the host, and `--no-lease` off
 * tvloop's advisory leases -- the fleet's device lock is the one that counts.
 */
export async function runTvloopFlow(file: string, opts: RunTvloopFlowOptions): Promise<TvloopReplayResult> {
  const dir = tvloopCheckout(opts.dir);
  const cwd = mkdtempSync(path.join(os.tmpdir(), "fleet-tvloop-replay-"));
  writeFileSync(path.join(cwd, "tvloop.toml"), deviceToml(opts.device));
  const args = [path.join(dir, CLI), "replay", path.resolve(file), "--json", "--no-daemon", "--no-lease",
    "--cwd", cwd, "--device", TV_ALIAS];
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CI: "1" };
  delete env.TVLOOP_PASSWORD;
  if (opts.device.platform === "roku") {
    if (!opts.password) throw new Error("replaying on a Roku needs its developer password (screenshots and logs go through it)");
    env.TVLOOP_PASSWORD = opts.password;
  }
  const t0 = Date.now();
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 300_000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, stdout: `${out}\n${e.message}` }); });
    child.on("close", (c) => {
      clearTimeout(timer);
      // stderr only matters when there was no result; it is where tvloop
      // prints why it could not start (no device, bad config).
      resolve({ code: c ?? 1, stdout: /"results"/.test(out) ? out : `${out}\n${err}` });
    });
  });
  const r = parseReplayOutput(stdout, code);
  return { ...r, durationMs: r.durationMs || Date.now() - t0 };
}
