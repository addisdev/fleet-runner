/**
 * The agent loop: register, long-poll, run, report — plus a beacon every 60 s
 * that is also how this machine learns a job was cancelled.
 *
 * This is a registering device, not a host executor. It claims
 * `executor: "device"` work through `/devices/:id/next-job` exactly as the
 * phones do; it drives no other device and holds no device locks.
 */
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CollectorClient, DEFAULT_BASE } from "./collector.js";
import { describe, APP_VER } from "./descriptor.js";
import { beacon } from "./telemetry.js";
import { probeCapabilities } from "./capabilities.js";
import { runBenchmark } from "./workloads/benchmark.js";
import { runBuild } from "./workloads/build.js";
import { runSelfCheck } from "./workloads/selfcheck.js";
import { runModelConvert } from "./workloads/modelconvert.js";
import { runDatasetPrep } from "./workloads/datasetprep.js";
import { runServe } from "./workloads/serve.js";
import { runShell } from "./workloads/shell.js";
import { SCHEMA, type Descriptor, type JobSpec } from "./protocol.js";
import * as JobCancellation from "./cancellation.js";

const BEACON_INTERVAL_MS = 60_000;
const ERROR_BACKOFF_MS = 5_000;
/** A beacon tick this late means the machine was asleep, not merely busy. */
const WAKE_GAP_MS = BEACON_INTERVAL_MS * 3;

/**
 * The device id, which must be the same string after a reboot: it is what the
 * registry keys on, what job specs pin with `targets.device_id`, and what every
 * historical result row is filed under. A hostname is the machine's own answer
 * to "who are you", so it is derived from that rather than generated — a random
 * id persisted to a file would fork the device's history the first time someone
 * cleared a cache directory.
 */
export function defaultDeviceId(hostname: string = os.hostname()): string {
  const clean = hostname
    .toLowerCase()
    .replace(/\.(local|lan|home|internal)$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `machine-${clean || "unknown"}`;
}

const deviceId = process.env.FLEET_DEVICE_ID || defaultDeviceId();
const pools = (process.env.FLEET_POOLS ?? "machines").split(",").map((s) => s.trim()).filter(Boolean);
const log = (msg: string) => console.log(`[${deviceId}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let currentJobId: string | null = null;

/**
 * Holds the machine awake for the duration of a claimed job.
 *
 * A benchmark that runs for twenty minutes on a closed laptop measures the
 * sleep, not the silicon — and worse, the collector sees a lease lapse and
 * requeues work that was never going to finish. `caffeinate -i -w <pid>`
 * asserts the idle sleep prevention against this process, so if the agent dies
 * the assertion dies with it rather than leaving a machine that will not sleep.
 * Non-macOS gets no assertion, which is the honest state of things: there is no
 * portable equivalent, and pretending otherwise would hide the gap.
 */
function holdAwake(): () => void {
  if (process.platform !== "darwin") return () => {};
  let child: ChildProcess;
  try {
    child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  } catch {
    return () => {};
  }
  child.on("error", () => log("caffeinate unavailable; the machine may sleep mid-job"));
  return () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
}

/**
 * The job's device-state contract, enforced here against live state rather
 * than against the collector's copy of a beacon up to a minute old — the same
 * split the phone runners use. A desktop with no battery satisfies both: it has
 * no battery to be low and it is on mains by construction, and failing it for
 * having reported null would take every desktop out of the fleet.
 */
async function constraintError(job: JobSpec): Promise<string | null> {
  const c = job.constraints;
  if (!c) return null;
  const s = await beacon();
  if (c.require_charging === true && s.charging !== true && s.on_ac !== true && s.battery_pct !== null) {
    return "constraint not met: require_charging (machine is on battery)";
  }
  if (typeof c.min_battery_pct === "number" && s.battery_pct !== null && s.battery_pct < c.min_battery_pct) {
    return `constraint not met: min_battery_pct ${c.min_battery_pct} (at ${s.battery_pct}%)`;
  }
  return null;
}

async function beaconLoop(client: CollectorClient): Promise<void> {
  let last = Date.now();
  for (;;) {
    const now = Date.now();
    // A laptop that was asleep wakes with a dead socket on the other end and a
    // registry row that has gone stale. Re-registering on the first tick after
    // a suspend is what makes the machine reconnect without a restart; the
    // long-poll's own 40 s deadline handles the socket.
    if (now - last > WAKE_GAP_MS) {
      log(`resumed after ${Math.round((now - last) / 1000)}s asleep; re-registering`);
      await register(client).catch(() => {});
    }
    last = now;

    try {
      // A beacon for a device the collector has never seen updates no row and
      // is simply lost, so the first one waits for the agent loop's
      // registration rather than racing it.
      if (descriptor === null) {
        await sleep(1000);
        continue;
      }
      const jobId = currentJobId;
      const renewed = await client.postBeacon({
        schema: SCHEMA, kind: "beacon", device_id: deviceId,
        job_id: jobId ?? undefined, // renews the running job's lease
        beacon: await beacon(),
      });
      // An explicit false means the claim is gone — cancelled from the
      // dashboard, or swept — so tell the workload to stop. Only that answer
      // counts: an unreachable collector or a non-2xx throws to the catch
      // below, and a throw is not a cancellation.
      if (jobId !== null && !renewed) {
        log(`lease not renewed for ${jobId}; cancelling at the next iteration boundary`);
        JobCancellation.cancel(jobId);
      }
    } catch {
      // Best-effort: the agent loop owns error reporting.
    }
    await sleep(BEACON_INTERVAL_MS);
  }
}

let descriptor: Descriptor | null = null;
let capabilities: string[] = ["benchmark"];

async function register(client: CollectorClient): Promise<void> {
  descriptor = await describe();
  await client.register({ device_id: deviceId, descriptor, pools, capabilities });
}

async function agentLoop(client: CollectorClient): Promise<void> {
  for (;;) {
    try {
      log(`registering with ${client.base}`);
      await register(client);
      log(`registered; capabilities: ${capabilities.join(", ")}`);

      for (;;) {
        const job = await client.nextJob(deviceId);
        if (!job) continue;
        log(`claimed ${job.job_id} (${job.workload}/${job.backend ?? "synthetic"})`);

        const refusal = await constraintError(job);
        if (refusal) {
          await client.postResult({
            schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
            iter: 0, final: true, ok: false, device: descriptor ?? undefined, error: refusal,
          });
          log(`rejected ${job.job_id}: ${refusal}`);
          continue;
        }

        currentJobId = job.job_id;
        const release = holdAwake();
        try {
          await dispatch(job, client);
        } finally {
          release();
          currentJobId = null;
          JobCancellation.clear(job.job_id);
        }
        log(`finished ${job.job_id}`);
      }
    } catch (e) {
      log(`error: ${(e as Error).message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

/**
 * Dispatch. The list here is the one `capabilities.ts` declares; a workload
 * that reaches this agent anyway gets an honest error row rather than silence,
 * which is what the collector's job detail needs in order to say why.
 */
async function dispatch(job: JobSpec, client: CollectorClient): Promise<void> {
  const device = descriptor ?? (await describe());
  if (job.workload === "benchmark") {
    await runBenchmark(job, client, deviceId, device);
    return;
  }
  if (job.workload === "build") {
    await runBuild(job, client, deviceId, device);
    return;
  }
  if (job.workload === "self-check") {
    await runSelfCheck(job, client, deviceId, device);
    return;
  }
  if (job.workload === "model-convert") {
    await runModelConvert(job, client, deviceId, device);
    return;
  }
  if (job.workload === "dataset-prep") {
    await runDatasetPrep(job, client, deviceId, device);
    return;
  }
  if (job.workload === "serve") {
    await runServe(job, client, deviceId, device);
    return;
  }
  if (job.workload === "shell") {
    await runShell(job, client, deviceId, device);
    return;
  }
  await client.postResult({
    schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
    iter: 0, final: true, ok: false, device: descriptor ?? undefined,
    error: `workload '${job.workload}' not supported by this runner yet`,
  });
}

async function main(): Promise<void> {
  const client = new CollectorClient();
  log(`fleet-runner-machine ${APP_VER} on ${process.platform}/${process.arch}, collector ${client.base}`);
  if (client.base === DEFAULT_BASE && !process.env.FLEET_URL) {
    log("FLEET_URL unset; using the loopback default");
  }
  capabilities = await probeCapabilities();
  void beaconLoop(client);
  await agentLoop(client);
}

// Only when run as the program, so the tests can import anything here.
// pathToFileURL rather than a template literal: this repo's own checkout sits
// under a directory with a space in it, and `file://.../Fleet Runner/...` is
// not a URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
