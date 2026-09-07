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
  /** Every brain this agent registered with, in the order it was given them. */
  collectors: string[];
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
  const bases = [
    ...new Set(
      (opts.collectors ?? (process.env.FLEET_URL ?? DEFAULT_BASE).split(",").map((b) => b.trim()).filter(Boolean)),
    ),
  ];
  if (bases.length === 0) throw new Error("an agent needs at least one collector to register with");
  const clients = bases.map((b) => new CollectorClient(b));

  let descriptor: Descriptor | null = null;
  let capabilities: string[] = ["benchmark"];
  let stopped = false;

  /**
   * The claim gate: this agent runs one job at a time, whoever asked.
   *
   * A device can belong to several fleets -- that is the point of registering
   * with more than one brain -- but it is one piece of hardware, and two
   * benchmarks running at once produce two numbers that are both wrong. So
   * everything below funnels through this.
   *
   * `heldBy` is the collector whose job is running, and `busy` is what every
   * OTHER collector is told on its next beacon so that its queue stops offering
   * work. The collector-side half of that is `busyElsewhere` in server.ts;
   * neither half is sufficient alone, because the beacon is up to a minute old
   * and the gate here is instantaneous.
   */
  const gate: {
    heldBy: CollectorClient | null;
    jobId: string | null;
    /** Aborted once, at shutdown, so no poll outlives `stop()`. */
    polls: AbortController;
  } = { heldBy: null, jobId: null, polls: new AbortController() };

  async function register(client: CollectorClient): Promise<void> {
    descriptor = await describe();
    await client.register({
      device_id: deviceId,
      descriptor,
      pools,
      capabilities,
      ttl_s: opts.ttlS ?? ttlFromEnv(process.env, log),
    });
  }

  /**
   * One beacon loop per collector.
   *
   * Every brain this agent knows gets told the same three things every sixty
   * seconds: how the hardware is, whether its own job's lease should be
   * renewed, and -- if this agent is working for somebody else -- who.
   *
   * The last of those is what keeps a second brain from queueing work behind a
   * device it cannot have. Without it, the brain whose job is NOT running sees
   * a healthy, idle-looking device and keeps handing it jobs that get released
   * a moment later.
   */
  async function beaconLoop(client: CollectorClient): Promise<void> {
    let last = Date.now();
    while (!stopped) {
      const now = Date.now();
      // A laptop that was asleep wakes with a dead socket on the other end and a
      // registry row that has gone stale. Re-registering on the first tick after
      // a suspend is what makes the machine reconnect without a restart; the
      // long-poll's own 40 s deadline handles the socket.
      if (now - last > WAKE_GAP_MS) {
        log(`resumed after ${Math.round((now - last) / 1000)}s asleep; re-registering with ${client.base}`);
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
        const mine = gate.heldBy === client ? gate.jobId : null;
        const sample = await beacon();
        // Told only to the collectors that are NOT running it. To the one that
        // is, the job_id above is already the whole story, and repeating it as
        // `busy` would be an agent describing its own claim back to the brain
        // that granted it.
        const busy =
          gate.jobId !== null && gate.heldBy !== client
            ? { job_id: gate.jobId, collector: gate.heldBy?.base ?? null }
            : undefined;

        const renewed = await client.postBeacon({
          schema: SCHEMA, kind: "beacon", device_id: deviceId,
          job_id: mine ?? undefined, // renews the running job's lease
          beacon: busy ? { ...sample, busy } : sample,
        });
        // An explicit false means the claim is gone — cancelled from the
        // dashboard, or swept — so tell the workload to stop. Only that answer
        // counts: an unreachable collector or a non-2xx throws to the catch
        // below, and a throw is not a cancellation.
        if (mine !== null && !renewed) {
          log(`lease not renewed for ${mine}; cancelling at the next iteration boundary`);
          JobCancellation.cancel(mine);
        }
      } catch {
        // Best-effort: the claim loop owns error reporting.
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
  async function dispatch(job: JobSpec, client: CollectorClient): Promise<void> {
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

  /**
   * Take a claim, or give it straight back.
   *
   * The gate is held from the instant a job is accepted until the instant it
   * finishes, and the check-and-set here is synchronous -- there is no `await`
   * between reading `gate.heldBy` and writing it, so two concurrent claim loops
   * on the same event loop cannot both pass.
   *
   * The loser hands the job back rather than queueing it. Holding it would mean
   * this agent had two claims, which is the one thing the gate exists to
   * prevent; dropping it silently would leave it `claimed` until a lease sweep,
   * with an attempt burnt.
   *
   * ## Why the losing poll is not aborted
   *
   * The first version of this aborted every other collector's in-flight poll
   * the instant a claim was taken, on the theory that a shorter window is a
   * smaller race. It is the opposite. A poll that has *already been answered*
   * -- the brain has run its claim transaction and the job row says `claimed`
   * -- is one whose response is in flight, and aborting it throws the job away
   * without anyone knowing it existed. Measured, that is exactly what happened:
   * two brains, two jobs, one ran and the other sat `claimed` forever with no
   * runner and no release, because the abort landed between the claim and the
   * response.
   *
   * So the losing poll is allowed to finish, and its job comes back here to be
   * handed over. Waiting out a long poll costs nothing: the loop is not doing
   * anything else, and the check at the top of it stops any NEW poll while a
   * job is running.
   */
  async function takeOrRelease(client: CollectorClient, job: JobSpec): Promise<boolean> {
    if (gate.heldBy !== null) {
      log(`released ${job.job_id} back to ${client.base}: already running ${gate.jobId}`);
      await client.releaseJob(job.job_id, deviceId);
      return false;
    }
    gate.heldBy = client;
    gate.jobId = job.job_id;
    return true;
  }

  function releaseGate(): void {
    gate.heldBy = null;
    gate.jobId = null;
  }

  /**
   * One claim loop per collector, all sharing the gate.
   *
   * Each loop is otherwise exactly the single-collector loop that was here
   * before: register, long-poll, claim, check constraints, run, report.
   */
  async function claimLoop(client: CollectorClient, alreadyRegistered: boolean): Promise<void> {
    // startAgent may have registered already, so that it could resolve only
    // after this agent exists in the registry. Re-registering here on the first
    // pass would then be a harmless upsert and a confusing pair of identical log
    // lines; every LATER pass is a reconnect, where re-registering is the point.
    let registered = alreadyRegistered;
    while (!stopped) {
      try {
        if (!registered) {
          log(`re-registering with ${client.base}`);
          await register(client);
          log(`registered with ${client.base}; capabilities: ${capabilities.join(", ")}`);
        }
        registered = false;

        while (!stopped) {
          // While another collector's job is running, this loop stops asking.
          // The brain has been told `busy` and should not be offering anyway;
          // this is the belt to that braces, and it costs nothing.
          if (gate.heldBy !== null) {
            await sleep(1_000);
            continue;
          }
          let job: JobSpec | null = null;
          try {
            job = await client.nextJob(deviceId, gate.polls.signal);
          } catch (e) {
            // The only abort is `stop()`, which the loop condition handles.
            if (gate.polls.signal.aborted || (e as Error).name === "AbortError") continue;
            throw e;
          }
          if (!job) continue;

          if (!(await takeOrRelease(client, job))) continue;
          log(`claimed ${job.job_id} (${job.workload}/${job.backend ?? "synthetic"}) from ${client.base}`);

          try {
            const refusal = await constraintError(job);
            if (refusal) {
              await client.postResult({
                schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
                iter: 0, final: true, ok: false, device: descriptor ?? undefined, error: refusal,
              });
              log(`rejected ${job.job_id}: ${refusal}`);
              continue;
            }

            const release = holdAwake(log);
            try {
              await dispatch(job, client);
            } finally {
              release();
              JobCancellation.clear(job.job_id);
            }
            log(`finished ${job.job_id}`);
          } finally {
            // In a `finally` so that a throw out of the workload -- a network
            // failure mid-report, say -- cannot leave this agent permanently
            // convinced it is busy, which would take it out of every fleet it
            // belongs to until somebody restarted it.
            releaseGate();
          }
        }
      } catch (e) {
        if (stopped) return;
        log(`error from ${client.base}: ${(e as Error).message} — retrying in ${ERROR_BACKOFF_MS / 1000}s`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  log(
    `fleet-runner-machine ${APP_VER} on ${process.platform}/${process.arch}, ` +
      `collector${clients.length > 1 ? "s" : ""} ${bases.join(", ")}`,
  );
  if (bases.length === 1 && bases[0] === DEFAULT_BASE && !process.env.FLEET_URL && !opts.collectors) {
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
  const registeredWith = new Set<CollectorClient>();
  await Promise.all(
    clients.map(async (client) => {
      for (const wait of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
        if (wait) await sleep(wait);
        try {
          await register(client);
          registeredWith.add(client);
          return;
        } catch (e) {
          if (wait === 8_000) {
            log(`could not register with ${client.base} yet (${(e as Error).message}); its claim loop keeps trying`);
          }
        }
      }
    }),
  );
  if (registeredWith.size > 0) {
    log(`registered with ${[...registeredWith].map((c) => c.base).join(", ")}; capabilities: ${capabilities.join(", ")}`);
  }
  for (const client of clients) {
    void beaconLoop(client);
    void claimLoop(client, registeredWith.has(client));
  }

  return {
    deviceId,
    capabilities,
    collectors: bases,
    registered: registeredWith.size > 0,
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
      // Ends every in-flight long poll, so `stop()` takes effect now rather
      // than in up to forty seconds when the last one times out.
      gate.polls.abort();
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
