// tvloop: run tvloop's hardware suite on a Roku this host can reach.
//
// tvloop is the Roku development CLI, and it already has a hardware nightly --
// .github/workflows/hardware.yml -- aimed at a self-hosted runner labelled
// `tvloop-lab`. No runner has ever carried that label, so the job has queued
// and never run. The Roku it needs is on fleet-host's network, and fleet-host
// is not an Actions runner and should not become one.
//
// So the fleet runs the same steps, and tvloop stays the thing that knows how
// to talk to a Roku: this file checks a device out, hands tvloop its address
// and password, and files what came back. "tvloop drives, fleet lends." The
// lending is the part only the fleet can do -- a Roku holds exactly one dev
// channel, so two things sideloading onto it at once is a corrupted run, and
// `exclusive: true` puts the collector's device lock around the whole suite.
//
// The steps are the workflow's, run from a built checkout on the host:
//
//   doctor    tvloop doctor --json          stop here if it fails
//   install   tvloop install --force        sideload the checkout's channel
//   spike     tools/m0-spike.mjs --full     opt-in: ten sideloads, slow
//   hardware  vitest --testNamePattern hardware   (pnpm test:hardware)
//   replay    tvloop replay --reporter junit     JUnit becomes the row's counts
//
// `install` is the one step tvloop's own workflow does not have. Its flows
// launch "the sideloaded app", and the workflow assumed a lab Roku that only
// ever held tvloop's sample channel. This one is shared -- its single dev slot
// held another channel when the fleet first found it -- so the run puts the
// channel it is about to test there itself. `--force` because tvloop skips an
// install whose package is unchanged since ITS last one, and cannot know that
// something else was sideloaded in between. Which channel is the checkout's
// tvloop.toml `[project] source`; fleet-host's points at the sample channel.
//
// Every step's output is uploaded, scrubbed of the password first, because the
// artifact store is readable by anyone who can open the dashboard.
//
// ## Fire TV and Android TV
//
// tvloop has an Android TV adapter too (adb underneath, the same Platform
// interface as the Roku one), so a flow written once can be replayed on a
// Fire TV. A job opts in with `params.androidtv: { package }`; then the adb
// targets it selects that declare leanback -- AndroidActuator.isTv(), the same
// test the explore workload uses -- are run alongside the Rokus. Without that
// param nothing about this workload changes: an existing job selects Rokus
// and only Rokus, exactly as before.
//
// Three differences, each forced by tvloop rather than chosen:
//
//   - tvloop takes an Android device from a tvloop.toml, not from `--device`
//     (a bare `--device` is assumed to be a Roku's address). So each TV gets a
//     generated config in its own run directory, pointing at the checkout's
//     flows and goldens, and is addressed as `--cwd <run dir> --device fleet`.
//   - Only doctor and replay mean anything there. tvloop's `install` builds a
//     ROKU package from the checkout's channel source and hands that zip to
//     `adb install`; the spike and the hardware suite are the Roku adapter's.
//     Those steps are skipped on a TV, and the row says which.
//   - No password. adb is the trust boundary; nothing is read from the
//     Keychain for a TV, and a host with no Roku password still runs its TVs.
//
// Two things about tvloop's Android TV adapter that a TV row does NOT catch,
// both seen on the dozehound-tv AVD (and written up in explore/replay-tvloop.ts):
// a flow's `launch` is `monkey -p <pkg> 1`, whose one event is random, so a
// replay can start with a stray key; and `assert noErrors` never fails there,
// because tvloop reads no logcat. A green TV row says the flows' keys went in,
// not that nothing crashed. And a flow asserting focus or visibility always
// FAILS there (tvloop has no Android tree) -- the checkout's own smoke flow
// asserts `visible: PlayButton` -- which is what params.androidtv.flows is for.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { NoTargetsError } from "../../fleet-client.js";
import { targetHost } from "../../drivers/roku.js";
import { AndroidActuator } from "../explore/actuators/android.js";
import type { Job, Target, WorkloadCtx } from "../types.js";

export const STEPS = ["doctor", "install", "spike", "hardware", "replay"] as const;
export type Step = (typeof STEPS)[number];
const DEFAULT_STEPS: Step[] = ["doctor", "install", "hardware", "replay"];

/** The built CLI, relative to the checkout. Its presence is what "built" means here. */
export const CLI = "packages/cli/dist/bin.js";

export type StepOutcome = { code: number; output: string };

/**
 * How a step is run. Injected so a test can decide exit codes and watch what
 * was asked for; the real one is `spawnStep` below. It is the one seam in this
 * file that stands in for a shell-out, and it is thin on purpose -- it fakes
 * an exit code, not tvloop.
 */
export type StepRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<StepOutcome>;

export type Deps = {
  runStep: StepRunner;
  /** A Roku's address. Discovery, in the real one; a test has no network. */
  hostOf: (t: Target) => Promise<string>;
  env: NodeJS.ProcessEnv;
  /**
   * Whether an adb target is a TV. adb in the real one; absent means "no adb
   * target is a TV", which is what every test written before Fire TV support
   * gets, so none of them changed.
   */
  isTv?: (t: Target) => Promise<boolean>;
};

/** The steps that mean anything on an Android TV; the rest are the Roku adapter's. */
export const ANDROIDTV_STEPS: readonly Step[] = ["doctor", "replay"];

/** The alias every generated config names its one device by. */
export const TV_ALIAS = "fleet";

/** What `params.androidtv` asked for, or why it is not usable. Null when absent. */
export function androidTvParams(job: Job): { package: string; flows: string[] | null } | string | null {
  const raw = job.params?.androidtv;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "params.androidtv must be an object: { package, flows? }";
  const o = raw as Record<string, unknown>;
  if (typeof o.package !== "string" || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(o.package)) {
    return "params.androidtv.package must be an Android application id, like com.taylab.dozehound";
  }
  if (o.flows !== undefined && !(Array.isArray(o.flows) && o.flows.every((f) => typeof f === "string"))) {
    return "params.androidtv.flows must be a list of flow names or paths";
  }
  return { package: o.package, flows: Array.isArray(o.flows) ? (o.flows as string[]) : null };
}

/** One device tvloop can be pointed at. */
export type TvloopDevice =
  | { platform: "roku"; host: string; ports?: { ecp?: number; dev?: number; console?: number; agent?: number } }
  | { platform: "androidtv"; serial: string; package: string };

/**
 * A tvloop.toml naming exactly one device, `fleet`.
 *
 * Pure, so the tests pin it. Strings are written as JSON strings, which TOML's
 * basic strings accept as-is for everything an adb serial, a package or a
 * path can contain. The Roku password is a reference (`env:TVLOOP_PASSWORD`)
 * and never the value, because this file sits in a temp directory and tvloop's
 * own doctor flags a literal.
 */
export function deviceToml(device: TvloopDevice, dirs: { flows?: string; goldens?: string } = {}): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ["# Written by the fleet for one run. Do not edit; it is regenerated each time.", ""];
  if (dirs.flows) lines.push("[flows]", `dir = ${q(dirs.flows)}`, "");
  if (dirs.goldens) lines.push("[goldens]", `dir = ${q(dirs.goldens)}`, "");
  lines.push(`[device.${TV_ALIAS}]`);
  if (device.platform === "roku") {
    lines.push('platform = "roku"', `host = ${q(device.host)}`, 'password = "env:TVLOOP_PASSWORD"');
    const p = device.ports ?? {};
    if (p.ecp) lines.push(`ecp_port = ${p.ecp}`);
    if (p.dev) lines.push(`dev_port = ${p.dev}`);
    if (p.console) lines.push(`console_port = ${p.console}`);
    if (p.agent) lines.push(`agent_port = ${p.agent}`);
  } else {
    // host is what tvloop shows; serial is what it passes to `adb -s`.
    lines.push('platform = "androidtv"', `host = ${q(device.serial)}`, `serial = ${q(device.serial)}`,
      `package = ${q(device.package)}`);
  }
  lines.push("default = true", "");
  return lines.join("\n");
}

/** The checkout, by the same precedence as every other path a host is told about. */
export function tvloopDir(job: Job, env: NodeJS.ProcessEnv = process.env): string {
  const fromParams = job.params?.dir;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  return env.FLEET_TVLOOP_DIR || path.join(os.homedir(), "tvloop");
}

/** The steps a job asked for, or why it asked for something that is not one. */
export function stepsFor(job: Job): Step[] | string {
  const raw = job.params?.steps;
  if (raw === undefined) return DEFAULT_STEPS;
  if (!Array.isArray(raw) || raw.length === 0) return "params.steps must be a non-empty list";
  const bad = raw.filter((s) => !(STEPS as readonly string[]).includes(s as string));
  if (bad.length) return `params.steps has ${bad.map((b) => JSON.stringify(b)).join(", ")}; the steps are ${STEPS.join(", ")}`;
  return raw as Step[];
}

/**
 * One step as a command line. Pure, so the argv is what the tests pin.
 *
 * `configDir` is set for a device that needs a generated tvloop.toml (an
 * Android TV); the device is then the config's `fleet` rather than an address.
 */
export function commandFor(
  step: Step,
  opts: { host: string; outDir: string; flows: string[]; node?: string; configDir?: string },
): { cmd: string; args: string[]; env?: Record<string, string> } {
  const node = opts.node ?? process.execPath;
  const device = opts.configDir ? ["--cwd", opts.configDir, "--device", TV_ALIAS] : ["--device", opts.host];
  switch (step) {
    case "doctor":
      return { cmd: node, args: [CLI, "doctor", "--json", ...device] };
    case "install":
      return { cmd: node, args: [CLI, "install", "--force", ...device] };
    case "spike":
      return {
        cmd: node,
        args: ["tools/m0-spike.mjs", "--host", opts.host, "--full", "--out", path.join(opts.outDir, "roku.md")],
      };
    case "hardware":
      // `pnpm test:hardware`, without needing pnpm on the service's PATH:
      // pnpm is how the checkout gets built, not something a nightly should
      // depend on finding at 9am under launchd.
      return {
        cmd: node,
        args: ["node_modules/vitest/vitest.mjs", "run", "--testNamePattern", "hardware"],
        env: { TVLOOP_HARDWARE: "1" },
      };
    case "replay":
      return {
        cmd: node,
        args: [CLI, "replay", ...opts.flows, "--reporter", "junit", "--out", path.join(opts.outDir, "flows.xml"),
          ...device],
      };
  }
}

/** Test counts from a JUnit report. An unreadable one counts as one failure, never as a pass. */
export function junitCounts(xml: string): { passed: number; failed: number } {
  const m = /<testsuites?\b[^>]*?\btests="(\d+)"[^>]*>/.exec(xml);
  if (!m) return { passed: 0, failed: 1 };
  const attr = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(m[0])?.[1] ?? 0);
  const tests = Number(m[1]);
  const failed = attr("failures") + attr("errors");
  return { passed: Math.max(0, tests - failed), failed };
}

/**
 * The real step runner: output captured, a hard timeout, no shell.
 *
 * Output is capped rather than buffered whole. A vitest run that loops can
 * print without end, and the part worth keeping is the tail.
 */
export const spawnStep: StepRunner = (cmd, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    const CAP = 2 * 1024 * 1024;
    let output = "";
    const keep = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > CAP) output = output.slice(-CAP);
    };
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += `\n[fleet] timed out after ${Math.round(timeoutMs / 1000)}s; stopping it`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n[fleet] could not start ${cmd}: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), output });
    });
  });

const REAL: Deps = { runStep: spawnStep, hostOf: targetHost, env: process.env, isTv: AndroidActuator.isTv };

export function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  return runWith(job, ctx, REAL);
}

export async function runWith(job: Job, ctx: WorkloadCtx, deps: Deps): Promise<void> {
  const steps = stepsFor(job);
  if (typeof steps === "string") throw new Error(steps);
  const flows = Array.isArray(job.params?.flows) ? (job.params.flows as unknown[]).map(String) : [];
  const tv = androidTvParams(job);
  if (typeof tv === "string") throw new Error(tv);

  const all = await ctx.listTargets();
  // Android TVs only when the job asked for them AND the host can tell a TV
  // from a phone. A job without params.androidtv sees exactly the Rokus it
  // always saw.
  const tvCandidates = tv && deps.isTv
    ? all.filter((t) => t.driver === "adb" || (t.driver === undefined && t.platform === "android"))
    : [];
  const tvs: Target[] = [];
  for (const t of tvCandidates) if (await deps.isTv!(t)) tvs.push(t);
  const targets = await ctx.selectTargets(job, [...all.filter((t) => t.platform === "roku"), ...tvs]);
  if (targets.length === 0) {
    throw new NoTargetsError(tv ? "no Roku or Android TV targets matched this job" : "no Roku targets matched this job");
  }
  const isAndroidTv = (t: Target) => t.platform !== "roku";
  const rokus = targets.filter((t) => !isAndroidTv(t));

  // A host told to run tvloop and not given a built checkout is misconfigured,
  // which is a failure somebody should see -- unlike a missing password below,
  // which is a setup step nobody has done yet.
  const dir = tvloopDir(job, deps.env);
  if (!existsSync(path.join(dir, CLI))) {
    throw new Error(
      `no built tvloop checkout at ${dir} (looked for ${CLI}): git clone addisdev/tvloop there, then ` +
        "`corepack pnpm install --frozen-lockfile && corepack pnpm build`, or set FLEET_TVLOOP_DIR",
    );
  }

  // The password is the Rokus' alone. A job with no Roku in it never asks the
  // Keychain, and a job whose Rokus cannot run (no password yet) still runs
  // its TVs; only a job that is ALL Rokus skips whole, as it always did.
  const NO_PASSWORD = "skipped: no Roku developer password on this host; add it with " +
    "`security add-generic-password -s fleet-roku-dev -a rokudev -w`";
  let password: string | null = null;
  if (rokus.length > 0) {
    const pw = await ctx.secrets.rokuDevPassword();
    if (pw.ok) password = pw.password;
    else if (pw.reason === "denied") {
      throw new Error(`could not read the Roku developer password from the Keychain: ${pw.detail}`);
    } else if (rokus.length === targets.length) {
      await ctx.postResult({
        job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: true, error: NO_PASSWORD,
      });
      ctx.log("tvloop: skipped, no Roku developer password in the Keychain");
      return;
    }
  }
  const scrub = (text: string) => (password ? ctx.secrets.redact(text, [password]) : text);

  const granted = job.targets?.exclusive ? await ctx.locks.acquire(job.job_id, targets.map((t) => t.id)) : null;
  let allOk = true;
  try {
    for (const target of targets) {
      if (granted && !granted.has(target.id)) {
        await ctx.postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: true,
          error: "skipped: device locked by another job",
        });
        continue;
      }
      const androidTv = isAndroidTv(target);
      if (!androidTv && password === null) {
        await ctx.postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok: true, error: NO_PASSWORD });
        continue;
      }

      let host: string;
      try {
        // An adb serial is its own address; only a Roku needs discovery.
        host = androidTv ? target.id : await deps.hostOf(target);
      } catch (e) {
        allOk = false;
        await ctx.postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: false,
          error: (e as Error).message.slice(0, 300),
        });
        continue;
      }

      const outDir = mkdtempSync(path.join(os.tmpdir(), "fleet-tvloop-"));
      if (androidTv && tv) {
        writeFileSync(path.join(outDir, "tvloop.toml"), deviceToml(
          { platform: "androidtv", serial: target.id, package: tv.package },
          // Absolute, so a config living in a temp directory still finds the
          // checkout's flows and goldens.
          { flows: path.join(dir, "tests", "flows"), goldens: path.join(dir, "tests", "goldens") },
        ));
      }
      const targetSteps = androidTv ? steps.filter((s) => ANDROIDTV_STEPS.includes(s)) : steps;
      const skippedSteps = steps.filter((s) => !targetSteps.includes(s));
      if (skippedSteps.length) {
        ctx.log(`tvloop: ${skippedSteps.join(", ")} skipped on ${target.id}: Roku-only steps, and this is an Android TV`);
      }
      // A flow name resolves against the flows directory; a relative PATH has
      // to be made absolute here, because a TV's tvloop runs with --cwd set to
      // its own run directory rather than the checkout.
      const absolute = (f: string) => (/[\\/]/.test(f) && !path.isAbsolute(f) ? path.join(dir, f) : f);
      const targetFlows = androidTv ? (tv?.flows ?? flows).map(absolute) : flows;
      const artifacts: string[] = [];
      const failedSteps: string[] = [];
      let counts: { passed: number; failed: number } | null = null;
      const upload = async (file: string, name: string) => {
        try {
          artifacts.push(await ctx.uploadArtifact(file, `${job.job_id}-${target.id}-${name}`));
        } catch (e) {
          ctx.log(`tvloop: could not upload ${name}: ${(e as Error).message.slice(0, 160)}`);
        }
      };

      for (const step of targetSteps) {
        // Each step renews the lease. A replay of every flow can outlast the
        // TTL on its own, and a lease that lapses mid-run requeues a job that
        // is still holding the Roku.
        await ctx.postBeacon(job.job_id, target.id, { step }).catch(() => {});
        const { cmd, args, env } = commandFor(step, {
          host, outDir, flows: targetFlows, ...(androidTv ? { configDir: outDir } : {}),
        });
        const t0 = Date.now();
        const res = await deps.runStep(cmd, args, {
          cwd: dir,
          env: {
            ...deps.env, ...env, NO_COLOR: "1", CI: "1",
            ...(androidTv ? {} : { TVLOOP_PASSWORD: password! }),
          },
          timeoutMs: ctx.leaseBudgetS(job, 1800) * 1000,
        });
        const logFile = path.join(outDir, `${step}.log`);
        writeFileSync(logFile, scrub(res.output));
        await upload(logFile, `${step}.log`);
        ctx.log(`tvloop ${step} on ${target.id} (${host}): exit ${res.code} in ${Math.round((Date.now() - t0) / 1000)}s`);

        if (step === "replay") {
          const report = path.join(outDir, "flows.xml");
          if (existsSync(report)) {
            const xml = scrub(readFileSync(report, "utf8"));
            writeFileSync(report, xml);
            counts = junitCounts(xml);
            await upload(report, "flows.xml");
          }
        }
        if (step === "spike" && existsSync(path.join(outDir, "roku.md"))) {
          await upload(path.join(outDir, "roku.md"), "roku.md");
        }
        if (res.code !== 0) {
          failedSteps.push(step);
          // Nothing after a failed doctor or install is about this build:
          // replay would drive whatever channel was already there.
          if (step === "doctor" || step === "install") break;
        }
      }

      const ok = failedSteps.length === 0 && (counts === null || counts.failed === 0);
      if (!ok) allOk = false;
      await ctx.postResult({
        job_id: job.job_id, device_id: target.id, iter: 0, ok,
        ...(counts ? { test: { ...counts, artifacts } } : { artifacts }),
        ...(failedSteps.length
          ? {
              error: failedSteps[0] === "doctor"
                ? androidTv
                  ? "tvloop doctor failed, so nothing after it ran: see doctor.log -- adb cannot reach the TV, " +
                    "or the app is not installed"
                  : "tvloop doctor failed, so nothing after it ran: see doctor.log -- the device is asleep, " +
                    "unreachable, out of developer mode, or the password is wrong"
                : failedSteps[0] === "install"
                  ? "tvloop could not sideload the channel, so nothing after it ran: see install.log"
                  : `tvloop step(s) failed: ${failedSteps.join(", ")}`,
            }
          : {}),
        metrics: {
          steps: targetSteps.length, failed_steps: failedSteps.length,
          ...(skippedSteps.length ? { skipped_steps: skippedSteps.length } : {}),
        },
      });
    }
  } finally {
    if (granted) await ctx.locks.release(job.job_id);
  }
  await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk });
}
