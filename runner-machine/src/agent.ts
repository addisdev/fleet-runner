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
import { routeFor } from "./routes.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What `startAgent` needs, and what every field falls back to. */
export type AgentOptions = {
  /**
   * The collectors to register with.
   *
   * A list from the outset, though exactly one is accepted today -- see
   * startAgent. The shape is decided here so that multi-homing is a loop over
   * something that already exists rather than a change of signature.
   */
  collectors?: string[];
  deviceId?: string;
  pools?: string[];
  /** Seconds; see ttlFromEnv for what sending one means. */
  ttlS?: number;
  log?: (msg: string) => void;
};

/** A running agent, and the handle that stops it. */
export type RunningAgent = {
  deviceId: string;
  capabilities: string[];
  collector: string;
  /**
   * Whether this agent was in the registry by the time startAgent resolved.
   * False means the collector was not reachable yet and the claim loop is still
   * trying -- the agent is running, it is simply not yet known.
   */
  registered: boolean;
  stop: () => void;
};

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
function holdAwake(log: (msg: string) => void): () => void {
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

/**
 * How long this agent asks to be remembered for, or undefined.
 *
 * Undefined is a permanent shelf machine: a laptop that is asleep is still a
 * laptop and should stay in the registry reading offline. A value says the
 * opposite -- that this process is temporary and its absence is the end of it
 * rather than a fault.
 *
 * Read from the environment rather than inferred from `kind: "ci"`, because
 * those are different questions: a CI runner is certainly ephemeral, but so is
 * a container somebody started by hand, and a self-hosted runner that lives on
 * a real box is not. The thing that knows is whoever launched the process.
 */
export function ttlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = (m) => console.log(m),
): number | undefined {
  const raw = env.FLEET_DEVICE_TTL_S;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  // A malformed value registers as permanent rather than as some default: an
  // agent that silently picked its own TTL would expire out from under a job
  // for a reason nobody wrote down.
  if (!Number.isInteger(n) || n < 1) {
    log(`FLEET_DEVICE_TTL_S=${JSON.stringify(raw)} is not a positive integer; registering as a permanent device`);
    return undefined;
  }
  return n;
}

/**
 * Start the agent: register, beacon, and claim work until stopped.
 *
 * This used to be a `main()` at the bottom of the file reading `process.env` at
 * module scope, which made the agent a script and nothing else. `fleet up`
 * needs to start one beside a collector; a test needs one pointed at a
 * throwaway. So the identity, the pools and the collector are arguments with
 * the old environment variables as their defaults -- nothing deployed today
 * changes behaviour, and nothing new has to set an environment variable to
 * configure a process it is already holding a reference to.
 *
 * Resolves once the agent has registered for the first time, so a caller can
 * enqueue work without polling the registry. It keeps running after that.
 */
export async function startAgent(opts: AgentOptions = {}): Promise<RunningAgent> {
  const deviceId = opts.deviceId ?? process.env.FLEET_DEVICE_ID ?? defaultDeviceId();
  const pools =
    opts.pools ?? (process.env.FLEET_POOLS ?? "machines").split(",").map((s) => s.trim()).filter(Boolean);
  const log = opts.log ?? ((msg: string) => console.log(`[${deviceId}] ${msg}`));
  const bases = opts.collectors ?? [process.env.FLEET_URL ?? DEFAULT_BASE];

  // Multi-homing is a real feature with a protocol change behind it -- an
  // agent registered with two brains must never hold two claims, which needs a
  // way to hand a job back that neither the collector nor this agent has yet.
  // Until that exists, a second collector here would be silently ignored, and
  // an agent that quietly does half of what it was asked is worse than one that
  // says it cannot.
  if (bases.length !== 1) {
    throw new Error(
      `this agent registers with exactly one collector, not ${bases.length}` +
        " (multi-homing needs the claim gate and POST /jobs/:id/release)",
    );
  }
  const client = new CollectorClient(bases[0]);

  let descriptor: Descriptor | null = null;
  let capabilities: string[] = ["benchmark"];
  let currentJobId: string | null = null;
  let stopped = false;

  async function register(): Promise<void> {
    descriptor = await describe();
    await client.register({
      device_id: deviceId,
      descriptor,
      pools,
      capabilities,
      ttl_s: opts.ttlS ?? ttlFromEnv(process.env, log),
    });
  }

  async function beaconLoop(): Promise<void> {
    let last = Date.now();
    while (!stopped) {
      const now = Date.now();
      // A laptop that was asleep wakes with a dead socket on the other end and a
      // registry row that has gone stale. Re-registering on the first tick after
      // a suspend is what makes the machine reconnect without a restart; the
      // long-poll's own 40 s deadline handles the socket.
      if (now - last > WAKE_GAP_MS) {
        log(`resumed after ${Math.round((now - last) / 1000)}s asleep; re-registering`);
        await register().catch(() => {});
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

  /**
   * Dispatch, through the same table that produced the capability list.
   *
   * A workload that reaches this agent anyway -- because the collector's
   * registry still has an older registration's capabilities, say -- gets an
   * honest error row rather than silence, which is what the job detail page
   * needs in order to say why nothing happened.
   */
  async function dispatch(job: JobSpec): Promise<void> {
    const device = descriptor ?? (await describe());
    const route = routeFor(job.workload);
    if (route) {
      await route.run(job, client, deviceId, device);
      return;
    }
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device,
      error: `workload '${job.workload}' not supported by this runner yet`,
    });
  }

  async function claimLoop(alreadyRegistered: boolean): Promise<void> {
    // startAgent may have registered already, so that it could resolve only
    // after this agent exists in the registry. Re-registering here on the first
    // pass would then be a harmless upsert and a confusing pair of identical log
    // lines; every LATER pass is a reconnect, where re-registering is the point.
    // When the initial attempts all failed, this loop owns the first one too.
    let registered = alreadyRegistered;
    while (!stopped) {
      try {
        if (!registered) {
          log(`re-registering with ${client.base}`);
          await register();
          log(`registered; capabilities: ${capabilities.join(", ")}`);
        }
        registered = false;

        while (!stopped) {
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
          const release = holdAwake(log);
          try {
            await dispatch(job);
          } finally {
            release();
            currentJobId = null;
            JobCancellation.clear(job.job_id);
          }
          log(`finished ${job.job_id}`);
        }
      } catch (e) {
        if (stopped) return;
        log(`error: ${(e as Error).message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  log(`fleet-runner-machine ${APP_VER} on ${process.platform}/${process.arch}, collector ${client.base}`);
  if (client.base === DEFAULT_BASE && !process.env.FLEET_URL && !opts.collectors) {
    log("FLEET_URL unset; using the loopback default");
  }
  capabilities = await probeCapabilities();

  // Register before returning, so a caller that is about to enqueue work does
  // not have to poll the registry to find out whether this agent exists yet.
  //
  // Retried rather than awaited once, and this is not a nicety. Under `fleet
  // up` the brain and the agent start in the same instant, and the agent
  // reliably wins the race to the first request -- so a single attempt would
  // mean the agent exits on every boot, the supervisor restarts it, and it
  // exits again, until it hits the crash-loop ceiling and gives up on a fleet
  // that is working perfectly. It also covers the ordinary case of a laptop
  // whose brain is a machine that has not finished booting.
  //
  // A failure at the end of this is still not fatal: the claim loop retries
  // forever, which is the behaviour a shelf device has always had. What the
  // caller loses is the guarantee that registration has already happened, and
  // it is told so rather than left to infer it.
  let registeredNow = false;
  for (const wait of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
    if (wait) await sleep(wait);
    try {
      await register();
      registeredNow = true;
      break;
    } catch (e) {
      if (wait === 8_000) {
        log(`could not register with ${client.base} yet (${(e as Error).message}); the claim loop keeps trying`);
      }
    }
  }
  if (registeredNow) log(`registered; capabilities: ${capabilities.join(", ")}`);
  void beaconLoop();
  void claimLoop(registeredNow);

  return {
    deviceId,
    capabilities,
    collector: client.base,
    registered: registeredNow,
    /**
     * Stop claiming and stop beaconing.
     *
     * Both loops check the flag at their next boundary rather than being torn
     * down, which means a job already running finishes -- the same contract the
     * collector has for cancellation, and for the same reason: a half-run
     * workload that never posts a final row leaves a job to be swept, which
     * looks like a crash rather than a shutdown.
     */
    stop: () => {
      stopped = true;
    },
  };
}

// Only when run as the program, so the tests can import anything here.
// pathToFileURL rather than a template literal: this repo's own checkout sits
// under a directory with a space in it, and `file://.../Fleet Runner/...` is
// not a URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent()
    .then((agent) => {
      // A supervisor stops a child with SIGTERM. Standing down at the next
      // boundary rather than dying mid-job is what keeps a restart from
      // leaving a claimed job for the sweep to find.
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
          agent.stop();
          process.exit(0);
        });
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
