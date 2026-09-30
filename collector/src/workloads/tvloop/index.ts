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
//   spike     tools/m0-spike.mjs --full     opt-in: ten sideloads, slow
//   hardware  vitest --testNamePattern hardware   (pnpm test:hardware)
//   replay    tvloop replay --reporter junit     JUnit becomes the row's counts
//
// Every step's output is uploaded, scrubbed of the password first, because the
// artifact store is readable by anyone who can open the dashboard.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { NoTargetsError } from "../../fleet-client.js";
import { targetHost } from "../../drivers/roku.js";
import type { Job, Target, WorkloadCtx } from "../types.js";

export const STEPS = ["doctor", "spike", "hardware", "replay"] as const;
export type Step = (typeof STEPS)[number];
const DEFAULT_STEPS: Step[] = ["doctor", "hardware", "replay"];

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
};

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

/** One step as a command line. Pure, so the argv is what the tests pin. */
export function commandFor(
  step: Step,
  opts: { host: string; outDir: string; flows: string[]; node?: string },
): { cmd: string; args: string[]; env?: Record<string, string> } {
  const node = opts.node ?? process.execPath;
  switch (step) {
    case "doctor":
      return { cmd: node, args: [CLI, "doctor", "--json", "--device", opts.host] };
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
          "--device", opts.host],
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

const REAL: Deps = { runStep: spawnStep, hostOf: targetHost, env: process.env };

export function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  return runWith(job, ctx, REAL);
}

export async function runWith(job: Job, ctx: WorkloadCtx, deps: Deps): Promise<void> {
  const steps = stepsFor(job);
  if (typeof steps === "string") throw new Error(steps);
  const flows = Array.isArray(job.params?.flows) ? (job.params.flows as unknown[]).map(String) : [];

  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === "roku"));
  if (targets.length === 0) throw new NoTargetsError("no Roku targets matched this job");

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

  const pw = await ctx.secrets.rokuDevPassword();
  if (!pw.ok) {
    if (pw.reason === "denied") {
      throw new Error(`could not read the Roku developer password from the Keychain: ${pw.detail}`);
    }
    await ctx.postResult({
      job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: true,
      error: "skipped: no Roku developer password on this host; add it with " +
        "`security add-generic-password -s fleet-roku-dev -a rokudev -w`",
    });
    ctx.log("tvloop: skipped, no Roku developer password in the Keychain");
    return;
  }
  const password = pw.password;
  const scrub = (text: string) => ctx.secrets.redact(text, [password]);

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

      let host: string;
      try {
        host = await deps.hostOf(target);
      } catch (e) {
        allOk = false;
        await ctx.postResult({
          job_id: job.job_id, device_id: target.id, iter: 0, ok: false,
          error: (e as Error).message.slice(0, 300),
        });
        continue;
      }

      const outDir = mkdtempSync(path.join(os.tmpdir(), "fleet-tvloop-"));
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

      for (const step of steps) {
        // Each step renews the lease. A replay of every flow can outlast the
        // TTL on its own, and a lease that lapses mid-run requeues a job that
        // is still holding the Roku.
        await ctx.postBeacon(job.job_id, target.id, { step }).catch(() => {});
        const { cmd, args, env } = commandFor(step, { host, outDir, flows });
        const t0 = Date.now();
        const res = await deps.runStep(cmd, args, {
          cwd: dir,
          env: { ...deps.env, ...env, TVLOOP_PASSWORD: password, NO_COLOR: "1", CI: "1" },
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
          if (step === "doctor") break;
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
                ? "tvloop doctor failed, so nothing after it ran: the device is asleep, unreachable, or out of developer mode"
                : `tvloop step(s) failed: ${failedSteps.join(", ")}`,
            }
          : {}),
        metrics: { steps: steps.length, failed_steps: failedSteps.length },
      });
    }
  } finally {
    if (granted) await ctx.locks.release(job.job_id);
  }
  await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk });
}
