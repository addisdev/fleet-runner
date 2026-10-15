// cold-start: how long an app takes to put its first frame on screen, N times
// over, in each launch state. Why only Android gets a number is on run() below.
import { amStartProblem, parseAmStart } from "../../am-start.js";
import { exec, NoTargetsError } from "../../fleet-client.js";
import { ADB, hasApp } from "../device.js";
import type { Job, Target, WorkloadCtx } from "../types.js";

const LAUNCH_STATES = ["cold", "warm", "hot"] as const;
type LaunchState = (typeof LAUNCH_STATES)[number];

/** The launcher activity `am start -n` needs, resolved the same way launchApp does. */
async function androidLaunchComponent(target: Target, appId: string): Promise<string> {
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "cmd", "package", "resolve-activity", "--brief", appId],
    { timeout: 15_000 },
  );
  const component = stdout.replace(/\r/g, "").trim().split("\n").pop()?.trim();
  if (!component || !component.includes("/")) {
    throw new Error(`no launcher activity for ${appId}: ${stdout.trim().slice(0, 160)}`);
  }
  return component;
}

/**
 * Put the app into `state`, then launch it once and ask the framework how long
 * that took.
 *
 * The three states are three different pieces of choreography, and the
 * difference between them is the whole measurement:
 *
 *   cold -- force-stop first, so the process is gone and Android builds it from
 *           nothing. This is the number a user feels after a reboot.
 *   warm -- launch again with the process still around. No force-stop, by
 *           definition: warm IS "the app is still in memory".
 *   hot  -- HOME first, so the activity is merely backgrounded, then return to
 *           it. The cheapest launch there is.
 *
 * `am start -W` blocks until the activity reports it is displayed and prints
 * TotalTime, which is the framework's own time-to-first-frame. That is why this
 * path exists and the iOS ones below do not: nothing in simctl or devicectl
 * answers the same question.
 */
async function androidLaunchOnce(target: Target, component: string, appId: string, state: LaunchState) {
  if (state === "cold") {
    await exec(ADB, ["-s", target.id, "shell", "am", "force-stop", appId], { timeout: 20_000 });
    // Force-stop returns before the process is reaped; measuring into that
    // window times a launch that is still racing the teardown.
    await new Promise((r) => setTimeout(r, 800));
  } else if (state === "hot") {
    await exec(ADB, ["-s", target.id, "shell", "input", "keyevent", "KEYCODE_HOME"], { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const { stdout } = await exec(
    ADB, ["-s", target.id, "shell", "am", "start", "-W", "-n", component],
    { timeout: 90_000 },
  );
  return parseAmStart(stdout);
}

/**
 * cold-start: how long the app takes to put its first frame on screen, N times
 * over, in each launch state.
 *
 * One result row per launch — never a pre-averaged one. The collector computes
 * p50 and p95 from the rows, split by launch_state, because a percentile mixing
 * cold and hot launches describes nothing that ever happens to a person holding
 * the phone.
 *
 * Android is the only platform this can measure honestly, and that is a
 * statement about the tooling rather than about the app:
 *
 *   Android      -- `am start -W` reports TotalTime, the framework's own
 *                   time-to-first-frame. Real measurement.
 *   iOS simulator-- `simctl launch` returns once the process is SPAWNED. That
 *                   is not time to first frame, it is a much smaller number
 *                   that would sit in a field documented as time to first
 *                   frame and be read as one. Reported as a failed row naming
 *                   the limitation.
 *   iOS device   -- devicectl has the same gap and one more: no force-stop by
 *                   bundle id, so the cold state cannot even be established.
 *
 * The honest iOS path is on-device (XCTApplicationLaunchMetric in an XCUITest
 * run, or the runner app reporting its own first frame) — it needs a runner
 * change in another repo, not a number invented here.
 */
export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const appId = (job.params?.app_id as string | undefined) ?? job.suite?.app_id;
  if (!appId) throw new Error("cold-start job needs params.app_id");
  const launches = Math.max(1, Number(job.params?.launches ?? 10));
  const asked = job.params?.states;
  const states = (Array.isArray(asked) ? asked.map(String) : [...LAUNCH_STATES]) as LaunchState[];
  for (const s of states) {
    if (!LAUNCH_STATES.includes(s)) {
      throw new Error(`params.states has ${JSON.stringify(s)}; launch states are ${LAUNCH_STATES.join(", ")}`);
    }
  }
  if (states.length === 0) throw new Error("params.states is empty; nothing to measure");

  const platform = job.app?.platform ?? "android";
  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new NoTargetsError(`no ${platform} targets matched this job`);

  let allOk = true;
  for (const target of targets) {
    // iOS, both kinds: say what is missing and stop. A spawn time filed as
    // launch_ms would be indistinguishable downstream from an Android
    // time-to-first-frame, and every comparison drawn from the pair would be
    // wrong in the app's favour.
    if (target.platform === "ios") {
      allOk = false;
      const why = target.kind === "device"
        ? "devicectl cannot time an iOS device's first frame (and cannot force-stop by bundle id, " +
          "so the cold state cannot be established); measure it on-device with XCTApplicationLaunchMetric"
        : "simctl launch returns when the process is spawned, not when the first frame is presented, " +
          "so there is no honest time-to-first-frame here; measure it with XCTApplicationLaunchMetric in a ui-test job";
      await ctx.postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: why });
      ctx.log(`cold-start on ${target.id}: unsupported — ${why}`);
      continue;
    }

    if (!(await hasApp(target, appId))) {
      await ctx.postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: `skipped: ${appId} not installed` });
      ctx.log(`cold-start on ${target.id}: skipped (${appId} not installed)`);
      continue;
    }

    let component: string;
    try {
      component = await androidLaunchComponent(target, appId);
    } catch (e) {
      allOk = false;
      await ctx.postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: false, error: (e as Error).message.slice(0, 300) });
      ctx.log(`cold-start on ${target.id}: ${(e as Error).message}`);
      continue;
    }

    let iter = 0;
    for (const state of states) {
      // The lease is renewed per state, not per job: ten launches of a heavy
      // app in three states outlives a default lease comfortably, and a swept
      // job would be re-claimed and re-run on the same phone.
      await ctx.postBeacon(job.job_id, target.id, {}).catch(() => {});

      // One discarded warm-up launch per state, and it is not optional. Each
      // state is defined by what the OS is holding when the launch starts, and
      // the launch before the first measured one is what puts it there: the
      // first "warm" launch after a cold start would otherwise be measured
      // against a process that was never warm, and the first launch of the run
      // as a whole carries one-time work (dexopt, first-run migrations) that no
      // user pays twice.
      try {
        await androidLaunchOnce(target, component, appId, state);
      } catch (e) {
        allOk = false;
        iter += 1;
        await ctx.postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: false,
          error: `${state} warm-up launch failed: ${(e as Error).message.slice(0, 240)}`,
        });
        ctx.log(`cold-start ${appId} on ${target.id}: ${state} warm-up failed, skipping the state`);
        continue;
      }

      const measured: number[] = [];
      for (let i = 0; i < launches; i++) {
        iter += 1;
        let parsed;
        try {
          parsed = await androidLaunchOnce(target, component, appId, state);
        } catch (e) {
          allOk = false;
          await ctx.postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1} failed: ${(e as Error).message.slice(0, 240)}`,
          });
          continue;
        }
        const problem = amStartProblem(parsed);
        if (problem || parsed.totalMs === null) {
          allOk = false;
          await ctx.postResult({
            job_id: job.job_id, device_id: target.id, iter, ok: false,
            error: `${state} launch ${i + 1}: ${problem ?? "no TotalTime"}`,
          });
          continue;
        }
        // LaunchState (Android 10+) is the framework's verdict on what that
        // launch actually was, and it beats our choreography's intent: a
        // force-stopped app the OS still had warm really did launch warm, and
        // filing it as cold is how a p95 stops meaning anything. When the
        // platform is too old to say, the state we drove is the best available.
        const reported = parsed.launchState ?? state;
        if (parsed.launchState && parsed.launchState !== state) {
          ctx.log(`cold-start ${appId} on ${target.id}: asked for ${state}, the framework reported ${parsed.launchState} — filing it as ${parsed.launchState}`);
        }
        measured.push(parsed.totalMs);
        await ctx.postResult({
          job_id: job.job_id, device_id: target.id, iter, ok: true,
          metrics: { launch_ms: parsed.totalMs, launch_state: reported },
        });
      }
      const mean = measured.length > 0 ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null;
      ctx.log(`cold-start ${appId} on ${target.id}: ${state} — ${measured.length}/${launches} launches, mean ${mean ?? "?"} ms`);
    }
  }
  await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk });
}
