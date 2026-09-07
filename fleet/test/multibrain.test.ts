/**
 * Two brains, one device, and the rule that it never holds two claims.
 *
 * This is the test the multi-homing work exists for, and it is written as an
 * adversarial race rather than a sequence: both collectors are handed a job for
 * the same device in the same millisecond, which is precisely the window that
 * cannot be closed on the agent's side alone.
 *
 * It has already caught the design being wrong. The first version of the claim
 * gate aborted every other collector's in-flight poll the moment a claim was
 * taken, on the theory that a shorter window is a smaller race. This test
 * showed the opposite: one job ran and the other sat `claimed` forever with no
 * runner, because the abort landed between the brain's claim transaction and
 * its response, and threw away a job nobody knew had been handed out.
 *
 * What it asserts, in order of how much each one matters:
 *
 * 1. The two jobs are never both `claimed`. That is the invariant.
 * 2. Both of them eventually finish. A gate that never released would satisfy
 *    (1) perfectly and be useless.
 * 3. Neither burns an attempt. Being handed a job you could not take is not
 *    evidence that the job is flaky, and three such races would otherwise
 *    retire a perfectly good job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const TSX = path.join(ROOT, "collector/node_modules/tsx/dist/cli.mjs");
const ready = existsSync(TSX) && existsSync(path.join(ROOT, "runner-machine/node_modules"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (typeof a === "string" || a === null) return reject(new Error("no port"));
      srv.close(() => resolve(a.port));
    });
  });
}

/** A throwaway collector with its own database, on its own port. */
function startBrain(dir: string, name: string, port: number): ChildProcess {
  return spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: path.join(ROOT, "collector"),
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_BIND: "127.0.0.1",
      FLEET_DATA_DIR: path.join(dir, name, "data"),
      FLEET_ARTIFACT_DIR: path.join(dir, name, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, name, "collector.log"),
      FLEET_DASH_DIST: path.join(dir, "no-dash"),
      // No sweeper and no scheduler: a tick firing mid-assertion is a flake
      // nobody enjoys diagnosing, and neither is what this is about.
      FLEET_SWEEP_MS: "600000",
      FLEET_SCHEDULER_TICK_MS: "600000",
      FLEET_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(base: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`${base} never answered /api/health`);
}

test(
  "a device registered with two brains never holds two claims",
  { timeout: 240_000, skip: ready ? false : "collector/ and runner-machine/ dependencies are not installed" },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fleet-multibrain-"));
    const [portA, portB] = [await freePort(), await freePort()];
    const A = `http://127.0.0.1:${portA}`;
    const B = `http://127.0.0.1:${portB}`;
    let brainA: ChildProcess | null = null;
    let brainB: ChildProcess | null = null;
    let agent: { stop: () => void } | null = null;

    try {
      brainA = startBrain(dir, "A", portA);
      brainB = startBrain(dir, "B", portB);
      const healthA = await waitForHealth(A);
      const healthB = await waitForHealth(B);
      // Two data directories, so two identities. A shared one would be one
      // brain answering on two ports, which is not what is under test.
      assert.notEqual(healthA.collector, healthB.collector, "the two brains have different ids");

      // pathToFileURL, not the bare path. On Windows an absolute path is
      // `D:\\a\\...`, and the ESM loader reads the drive letter as a URL scheme:
      // "Only URLs with a scheme in: file, data, and node are supported ...
      // Received protocol 'd:'". This repository already knew that trap -- it is
      // why every direct-run guard in the tree uses pathToFileURL -- and this
      // test was written on a machine where it cannot happen.
      const { startAgent } = (await import(
        pathToFileURL(path.join(ROOT, "runner-machine/src/agent.ts")).href
      )) as typeof import("../../runner-machine/src/agent.js");
      agent = await startAgent({
        collectors: [A, B],
        deviceId: "multibrain-device",
        pools: ["machines"],
        log: () => {},
      });

      for (const base of [A, B]) {
        const devices = (await fetch(`${base}/api/devices`).then((r) => r.json())) as {
          devices: { device_id: string }[];
        };
        assert.ok(
          devices.devices.some((d) => d.device_id === "multibrain-device"),
          `${base} has the device in its registry`,
        );
      }

      // Long enough that the two would visibly overlap if they ran together.
      const spec = (jobId: string) => ({
        schema: 1,
        job_id: jobId,
        workload: "benchmark",
        executor: "device",
        backend: "synthetic",
        params: { prompt_tokens: 2048, gen_tokens: 512, warmup_iters: 0, measure_iters: 2 },
        targets: { device_id: "multibrain-device" },
      });
      const post = (base: string, jobId: string) =>
        fetch(`${base}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(spec(jobId)),
        });
      // In parallel, deliberately: the race is the subject.
      const [resA, resB] = await Promise.all([post(A, "from-A"), post(B, "from-B")]);
      assert.equal(resA.status, 201);
      assert.equal(resB.status, 201);

      type Job = { status: string; attempts: number; last_error: string | null };
      const read = (base: string, id: string) =>
        fetch(`${base}/jobs/${id}`).then((r) => r.json()) as Promise<Job>;

      let bothClaimed = 0;
      let jobA: Job | null = null;
      let jobB: Job | null = null;
      for (let i = 0; i < 300; i++) {
        [jobA, jobB] = await Promise.all([read(A, "from-A"), read(B, "from-B")]);
        if (jobA.status === "claimed" && jobB.status === "claimed") bothClaimed += 1;
        const settled = (j: Job) => j.status === "done" || j.status === "failed";
        if (settled(jobA) && settled(jobB)) break;
        await sleep(400);
      }

      // (1) The invariant.
      assert.equal(bothClaimed, 0, "the device was never claimed by both brains at once");
      // (2) A gate that never let go would pass (1) and be useless.
      assert.equal(jobA?.status, "done", `A: ${jobA?.last_error ?? ""}`);
      assert.equal(jobB?.status, "done", `B: ${jobB?.last_error ?? ""}`);
      // (3) A release is not a failed attempt.
      assert.equal(jobA?.attempts, 1, "the winner ran once");
      assert.equal(jobB?.attempts, 1, "and the released job was not charged for the race");
    } finally {
      agent?.stop();
      for (const brain of [brainA, brainB]) {
        if (!brain) continue;
        const gone = new Promise<void>((r) => brain.once("exit", () => r()));
        brain.kill("SIGTERM");
        await Promise.race([gone, sleep(10_000)]);
        if (brain.exitCode === null && brain.signalCode === null) brain.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
