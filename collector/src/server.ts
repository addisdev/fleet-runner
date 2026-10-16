import Fastify, { type FastifyReply } from "fastify";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { closeDb, db, openDb } from "./db.js";
import { renderDash, renderBench } from "./dash.js";
import { cronMatches, isValidCron, minuteKey } from "./cron.js";
import { evalMatch } from "./match.js";
import { identity } from "./identity.js";
import { APP_VERSION } from "./version.js";
import { advertise, type Advertised } from "./discovery.js";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_DIR,
  BIND,
  DISCOVERY,
  freezeConfig,
  DATA_DIR,
  GITHUB_API,
  GITHUB_STATUS_ARMED,
  GITHUB_TOKEN,
  LOG_FILE,
  PORT,
  POWER_CONFIG_PATH,
  SCHEDULER_TICK_MS,
  SWEEP_MS,
  TAILNET_ALLOWLIST,
} from "./config.js";
import { evaluate, expireSnoozes, notify, reconcile } from "./alerts.js";
import { requireToken } from "./api/guard.js";
import { registerApi } from "./api/index.js";
import { AGE, capabilityMatches, deviceCapabilities, effectivePools, isExpired, ONLINE_S } from "./api/shared.js";
import { admit, isTailnetAddress, normaliseIp, whois } from "./tailnet.js";
// Dependency chains live beside the cancel path, which also has to settle
// waiters; imported here rather than duplicated. mutations.ts imports nothing
// from this file, so there is no cycle.
import { firstArtifactSha, settleWaiters, type DepSettlement } from "./api/mutations.js";
import { announce } from "./announce.js";
import { closingStatus, type Closing } from "./skip.js";
import { forgetStaleSimulators, retireRokuIpDuplicate } from "./registry-hygiene.js";
import { enqueueJob, matchingDevices, resolveLatestBuild, type JobSpec } from "./queue.js";
import { authWarnings, provenanceOf, registerAuth } from "./auth.js";
import { registerDeprecations } from "./api/v1/deprecations.js";
import { cleanMediaType, sniffMediaType } from "./media-type.js";
import { registerDashStatic } from "./dash-static.js";
import { registerRunnerWeb } from "./runner-web.js";
import { startPowerSampler } from "./power.js";
import { endMirror } from "./api/mirror.js";
import { digestTick, digestTickOptions } from "./findings.js";
import { FINDINGS_REPOS_ERROR } from "./config.js";


/**
 * This collector's stable id, read once.
 *
 * The claim path needs it on every claim in order to tell "busy for me" from
 * "busy for somebody else", and `identity()` is a file read. Resolved lazily
 * rather than at module load because the data directory is not decided until
 * `configure()` has run.
 */
let collectorId: string | null = null;
function myCollectorId(): string {
  if (collectorId === null) collectorId = identity(DATA_DIR).id;
  return collectorId;
}

const LONG_POLL_S = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Agents beacon every 60 s. Two missed beacons and a state claim is no longer
// evidence of anything, which matters because these claims gate work rather
// than merely describing it.
const BEACON_TRUST_S = 180;

const app = Fastify({ logger: { level: process.env.FLEET_LOG ?? "info" } });

// Artifact uploads arrive as raw bytes and are streamed to disk while the
// hash is computed — a multi-GB GGUF never lives in collector memory.
app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
// Mirror frames, unlike artifacts, are small, capped, and consumed immediately
// rather than streamed to disk — so they are buffered here. Kept to its own
// content type precisely so the artifact path above keeps streaming: a
// multi-GB GGUF must never be buffered into collector memory.
app.addContentTypeParser("image/jpeg", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

// Before any route, so every route registered below is behind it. With
// FLEET_AUTH unset it only records who asked; see src/auth.ts.
registerAuth(app);
registerDeprecations(app);

/**
 * The longest an ephemeral agent may ask to be remembered for. A day: past
 * that, "ephemeral" is not what the word means, and a permanent device is
 * spelled by omitting the field.
 */
const MAX_DEVICE_TTL_S = 86_400;

function touchDevice(deviceId: string) {
  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
}

/**
 * Preconditions the collector can check before handing out a claim, evaluated
 * against the device's last beacon.
 *
 * Deliberately NOT the whole `constraints` object. `require_charging` and
 * `min_battery_pct` are enforced by the runner apps against live state, and
 * they refuse the job with a failed result; moving them here would change that
 * behaviour and double-enforce it against data up to a minute stale. What is
 * here is the set that describes a machine being temporarily unsuitable rather
 * than a device failing a contract — a laptop on battery, or busy, or awake at
 * the wrong hour has not failed at anything, so the job should stay queued and
 * be offered again rather than burn an attempt.
 *
 * Stale beacons fail closed. A machine that stopped reporting cannot be shown
 * to be idle, and guessing in the permissive direction is how a benchmark ends
 * up running while someone is typing.
 */
export function constraintsSatisfied(
  constraints: Record<string, unknown> | undefined,
  lastBeacon: Record<string, unknown> | null,
  beaconAgeS: number | null,
  now = new Date(),
): boolean {
  if (!constraints) return true;
  const wantsAc = constraints.require_ac === true;
  const wantsIdle = typeof constraints.require_idle_s === "number";
  const wantsLoad = typeof constraints.max_load === "number";
  const window = constraints.window as { from?: number; to?: number; tz_offset_min?: number } | undefined;

  if (window && typeof window.from === "number" && typeof window.to === "number") {
    const shifted = typeof window.tz_offset_min === "number"
      ? new Date(now.getTime() + window.tz_offset_min * 60_000)
      : now;
    const hour = typeof window.tz_offset_min === "number" ? shifted.getUTCHours() : shifted.getHours();
    // from > to means the window crosses midnight, which is the common case:
    // "22 to 06" is the night, not an empty set.
    const inside = window.from <= window.to
      ? hour >= window.from && hour < window.to
      : hour >= window.from || hour < window.to;
    if (!inside) return false;
  }

  if (!wantsAc && !wantsIdle && !wantsLoad) return true;

  // Everything below reads the beacon, so no beacon means no claim.
  const sample = (lastBeacon?.beacon ?? lastBeacon) as Record<string, unknown> | null | undefined;
  if (!sample) return false;
  if (beaconAgeS !== null && beaconAgeS > BEACON_TRUST_S) return false;

  if (wantsAc && sample.on_ac !== true && sample.charging !== true) return false;
  if (wantsIdle) {
    const idle = Number(sample.idle_s);
    if (!Number.isFinite(idle) || idle < Number(constraints.require_idle_s)) return false;
  }
  if (wantsLoad) {
    const load = Number(sample.load_1m);
    if (!Number.isFinite(load) || load > Number(constraints.max_load)) return false;
  }
  return true;
}

/**
 * Whether this device is currently running a job for a *different* collector.
 *
 * A device can register with several brains -- that is the whole point of
 * multi-homing -- but it is one piece of hardware and it runs one job at a
 * time. The agent enforces that on its side with a claim gate; this is the
 * other half, and it exists so the queue does not have to find out by handing
 * over a job and having it handed straight back.
 *
 * The signal rides on the beacon rather than on a new endpoint, for the same
 * reason `preempt` and `lease_renewed` do: the agent is already beaconing every
 * sixty seconds to every brain it knows, and a device that has gone silent is
 * a device whose claims about itself have expired anyway.
 *
 * Three things are deliberate:
 *
 * - **A stale beacon does not block.** Past BEACON_TRUST_S the claim is no
 *   longer evidence of anything, and the failure mode of trusting it would be a
 *   device that took one job from another brain, was unplugged, and then never
 *   claimed anything here again.
 * - **Our own id never blocks.** If the busy claim names this collector, it is
 *   this collector's own job and the lease machinery already governs it.
 *   Treating it as "busy elsewhere" would mean a device could never claim a
 *   second job from the brain it is already working for.
 * - **A busy claim with no collector named blocks anyway.** An agent that says
 *   it is busy and cannot say for whom is still busy, and the conservative
 *   reading costs a claim the device would have bounced.
 */
function busyElsewhere(
  beacon: Record<string, unknown> | null,
  beaconAgeS: number | null,
  myCollectorId: string,
): { job_id: string | null; collector: string | null } | null {
  if (beaconAgeS !== null && beaconAgeS > BEACON_TRUST_S) return null;
  const sample = (beacon?.beacon ?? beacon) as Record<string, unknown> | null | undefined;
  const busy = sample?.busy as { job_id?: unknown; collector?: unknown } | undefined;
  if (!busy || typeof busy !== "object") return null;
  const collector = typeof busy.collector === "string" ? busy.collector : null;
  if (collector !== null && collector === myCollectorId) return null;
  return {
    job_id: typeof busy.job_id === "string" ? busy.job_id : null,
    collector,
  };
}

/** Everything about a claimant a job spec can be judged against: the pools and
 *  capabilities it works under, the descriptor a `targets.match` expression
 *  reads, and the last beacon the collector-side constraints are measured
 *  against. Built fresh per claim attempt and per preemption check, so those
 *  two can never be answering from different pictures of the same device. */
type ClaimantContext = {
  executor: "device" | "host";
  claimant: string;
  pools: string[];
  capabilities: string[] | null;
  descriptor: Record<string, unknown>;
  beacon: Record<string, unknown> | null;
  beaconAgeS: number | null;
};

function claimantContext(executor: "device" | "host", claimant: string): ClaimantContext {
  const empty = { executor, claimant, pools: [] as string[], capabilities: null, descriptor: {}, beacon: null, beaconAgeS: null };
  // A host executor has no device row: it is judged only on targets.executor.
  if (executor !== "device") return empty;
  const dev = db
    .prepare(
      `SELECT pools, pools_override, capabilities, descriptor, last_beacon,
              CAST(strftime('%s','now') - strftime('%s', last_seen) AS INTEGER) AS age_s
       FROM devices WHERE device_id = ?`,
    )
    .get(claimant) as
    | { pools: string; pools_override: string | null; capabilities: string | null;
        descriptor: string; last_beacon: string | null; age_s: number | null }
    | undefined;
  if (!dev) return empty;
  const pools = effectivePools(dev);
  const capabilities = deviceCapabilities(dev);
  let beacon: Record<string, unknown> | null = null;
  try { beacon = dev.last_beacon ? JSON.parse(dev.last_beacon) : null; } catch { beacon = null; }
  return {
    executor, claimant, pools, capabilities,
    // targets.match expressions can read `pools`, so they see the effective set
    // rather than the runner's raw report.
    descriptor: {
      ...JSON.parse(dev.descriptor),
      device_id: claimant, pools, capabilities: capabilities ?? [],
    },
    beacon,
    beaconAgeS: dev.age_s ?? null,
  };
}

/**
 * Would this claimant be handed this spec if it asked right now?
 *
 * The single copy of the queue's eligibility rules. The claim loop walks the
 * queue with it, and the preemption check asks it what a higher-priority job
 * would do — a second implementation would eventually promise a preemption
 * that the claim loop then refuses, which is a running job stopped for nothing.
 */
/**
 * Which executors hold an online device this host job could run on, judged
 * from the presence reports executors already send: `attached_to` names the
 * executor, `last_seen` says it is still there, and `targets.device_id` or
 * `targets.match` says whether it fits. A job that names neither fits any
 * attached device, so every executor with something attached qualifies.
 */
function executorsHolding(spec: JobSpec): Set<string> {
  const rows = db
    .prepare(
      `SELECT device_id, descriptor, ${AGE("last_seen")} AS age_s FROM devices
        WHERE json_extract(descriptor, '$.attached_to') IS NOT NULL`,
    )
    .all() as { device_id: string; descriptor: string; age_s: number | null }[];
  const holders = new Set<string>();
  for (const r of rows) {
    if (r.age_s === null || r.age_s > ONLINE_S) continue;
    if (spec.targets?.device_id && spec.targets.device_id !== r.device_id) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(r.descriptor) as Record<string, unknown>; } catch { continue; }
    if (spec.targets?.match) {
      try { if (!evalMatch(spec.targets.match, { ...d, device_id: r.device_id })) continue; } catch { continue; }
    }
    if (typeof d.attached_to === "string") holders.add(d.attached_to);
  }
  return holders;
}

function specEligibleFor(ctx: ClaimantContext, spec: JobSpec): boolean {
  // Host jobs may name the executor that should take them.
  if (ctx.executor === "host") {
    if (spec.targets?.executor) return spec.targets.executor === ctx.claimant;
    // Unpinned, it goes to an executor that actually holds a device it can run
    // on. It used to go to whichever executor polled first, which with two
    // executors is a coin flip: a job meant for a phone cabled to one Mac was
    // claimed by the other, found nothing attached, and was skipped -- while
    // the phone sat idle a room away. When no executor holds a match, any may
    // claim it, so the answer is a prompt "no targets" skip rather than a job
    // queued forever for a device that is not coming.
    const holders = executorsHolding(spec);
    return holders.size === 0 || holders.has(ctx.claimant);
  }

  if (spec.targets?.device_id && spec.targets.device_id !== ctx.claimant) return false;
  const pool = spec.targets?.pool;
  if (pool && !ctx.pools.includes(pool)) return false;
  // An agent is never handed a workload it did not say it could run. This sits
  // above targets.match on purpose: an expression narrows the set of eligible
  // agents, it does not grant one a workload its code lacks.
  if (!capabilityMatches(ctx.capabilities, spec.workload, spec.backend ?? null)) return false;
  // Not a rejection: an unsatisfied constraint leaves the job queued for the
  // next poll, which is the whole difference between "the laptop is busy right
  // now" and "this job failed".
  if (!constraintsSatisfied(spec.constraints, ctx.beacon, ctx.beaconAgeS)) return false;
  // targets.match: descriptor expression ("ram_mb >= 4000 && os ~ 'android'").
  if (spec.targets?.match) {
    try { if (!evalMatch(spec.targets.match, ctx.descriptor)) return false; } catch { return false; }
  }
  return true;
}

// Atomically claim the oldest queued job this claimant is eligible for, and
// start its lease clock. 'waiting' jobs are invisible here by construction:
// the SELECT asks for 'queued', which is the whole reason a dependency chain
// needed its own status rather than a flag on a queued row.
const claimTx = db.transaction((executor: "device" | "host", claimant: string): JobSpec | null => {
  if (executor === "device") {
    // A host-executor job holding this device (exclusive ui-test, drain…)
    // means the agent must idle until the lock is released.
    const locked = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(claimant);
    if (locked) return null;
  }
  const ctx = claimantContext(executor, claimant);
  // And a device already working for another brain is not available to this
  // one. Checked here rather than after the match expression on purpose: this
  // is a fact about the hardware, not a narrowing of which jobs suit it, and a
  // job that "matched but was not offered" is easier to reason about than one
  // that was offered and bounced.
  if (executor === "device" && busyElsewhere(ctx.beacon, ctx.beaconAgeS, myCollectorId()) !== null) return null;
  // Priority first, then age. A job promoted from the dashboard jumps the queue
  // without anyone falsifying its created_at.
  const rows = db
    .prepare(
      "SELECT job_id, spec FROM jobs WHERE status = 'queued' AND executor = ? ORDER BY priority DESC, created_at",
    )
    .all(executor) as { job_id: string; spec: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec) as JobSpec;
    if (!specEligibleFor(ctx, spec)) continue;
    db.prepare(
      `UPDATE jobs SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now'),
                       attempts = attempts + 1,
                       lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds')
       WHERE job_id = ?`,
    ).run(claimant, row.job_id);
    if (executor === "device") {
      db.prepare("INSERT OR REPLACE INTO device_locks (device_id, job_id) VALUES (?, ?)").run(
        claimant, row.job_id,
      );
    }
    return spec;
  }
  return null;
});

/**
 * Is there queued work that outranks this claim and would go to the same
 * claimant? Answered with the same eligibility rules the claim loop uses, so a
 * runner is only ever asked to step aside for a job that would really replace
 * it — and only when its own spec said it could be interrupted.
 *
 * The collector never kills anything. It answers a beacon with `preempt: true`
 * and the runner decides when to stop, checkpoints, and posts a final row
 * carrying `preempted: true`.
 */
function preemptionPending(job: {
  spec: string; priority: number; executor: string; claimed_by: string | null;
}): boolean {
  if (!job.claimed_by) return false;
  let spec: JobSpec;
  try { spec = JSON.parse(job.spec) as JobSpec; } catch { return false; }
  if (spec.preemptible !== true) return false;

  const ctx = claimantContext(job.executor === "host" ? "host" : "device", job.claimed_by);
  // Strictly higher: equal priority is not a reason to throw away work in
  // progress, and two jobs trading the same device back and forth is worse
  // than either of them finishing late.
  const rows = db
    .prepare(
      `SELECT spec FROM jobs WHERE status = 'queued' AND executor = ? AND priority > ?
        ORDER BY priority DESC, created_at`,
    )
    .all(job.executor, job.priority) as { spec: string }[];
  return rows.some((r) => {
    try { return specEligibleFor(ctx, JSON.parse(r.spec) as JobSpec); } catch { return false; }
  });
}

async function longPollClaim(executor: "device" | "host", claimant: string, reply: FastifyReply) {
  // A claim made for a poller that has hung up is handed to nobody, and the
  // job sits claimed until its lease lapses.
  let gone = false;
  reply.raw.once("close", () => (gone = true));
  for (let i = 0; i < LONG_POLL_S && !gone; i++) {
    const spec = claimTx(executor, claimant);
    if (spec) {
      // Announced here rather than inside claimTx: the transaction has
      // committed by the time it returns.
      announce({ type: "job", job_id: spec.job_id, status: "claimed", workload: spec.workload, executor, claimed_by: claimant });
      return spec;
    }
    await sleep(1000);
  }
  return null;
}

// --- lease sweep ---

type SweptJob = { job_id: string; claimed_by: string | null; attempts: number };

// Requeue claims whose lease lapsed; give up on jobs that burned all attempts.
const sweepLeasesTx = db.transaction((): { requeued: SweptJob[]; failed: SweptJob[] } => {
  const expired = db
    .prepare(
      `SELECT job_id, claimed_by, attempts, max_attempts FROM jobs
       WHERE status = 'claimed' AND lease_deadline IS NOT NULL AND lease_deadline <= datetime('now')`,
    )
    .all() as (SweptJob & { max_attempts: number })[];

  const requeue = db.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  );
  const giveUp = db.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = datetime('now'),
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  );

  const requeued: SweptJob[] = [];
  const failed: SweptJob[] = [];
  const dropLocks = db.prepare("DELETE FROM device_locks WHERE job_id = ?");
  for (const job of expired) {
    const who = job.claimed_by ?? "unknown claimant";
    if (job.attempts >= job.max_attempts) {
      giveUp.run(`lease expired on ${who}; gave up after ${job.attempts}/${job.max_attempts} attempts`, job.job_id);
      failed.push(job);
    } else {
      requeue.run(`lease expired on ${who}; requeued after attempt ${job.attempts}/${job.max_attempts}`, job.job_id);
      requeued.push(job);
    }
    dropLocks.run(job.job_id);
  }
  return { requeued, failed };
});

function sweepLeases() {
  const swept = sweepLeasesTx();
  // Registry hygiene rides on the same timer: simulators offline past
  // FLEET_SIMULATOR_TTL_DAYS are forgotten. See registry-hygiene.ts.
  const forgotten = forgetStaleSimulators();
  for (const id of forgotten) {
    app.log.info({ device_id: id }, "simulator offline past its TTL; forgotten");
    announce({ type: "device", device_id: id, event: "forget", reason: "simulator offline past FLEET_SIMULATOR_TTL_DAYS" });
  }
  for (const j of swept.requeued) {
    app.log.warn({ job_id: j.job_id, claimed_by: j.claimed_by, attempt: j.attempts }, "lease expired; requeued");
    announce({ type: "job", job_id: j.job_id, status: "queued", reason: "lease expired", attempts: j.attempts });
  }
  for (const j of swept.failed) {
    app.log.error({ job_id: j.job_id, claimed_by: j.claimed_by, attempts: j.attempts }, "lease expired; job failed");
    announce({ type: "job", job_id: j.job_id, status: "failed", reason: "lease expired", attempts: j.attempts });
  }
  return { ...swept, forgotten };
}

// --- devices ---

app.post("/devices/register", async (req, reply) => {
  const b = req.body as {
    device_id?: string; descriptor?: object; pools?: string[]; capabilities?: string[];
    ttl_s?: number;
  };
  if (!b?.device_id) return reply.code(400).send({ error: "device_id required" });
  // An agent that knows it is temporary says so. See the ttl_s column in db.ts:
  // absent means a permanent shelf device, which is the default and the only
  // behaviour that existed before.
  if (b.ttl_s !== undefined &&
      (!Number.isInteger(b.ttl_s) || b.ttl_s < 1 || b.ttl_s > MAX_DEVICE_TTL_S))
    return reply.code(400).send({ error: `ttl_s must be an integer between 1 and ${MAX_DEVICE_TTL_S}` });
  if (b.capabilities !== undefined &&
      (!Array.isArray(b.capabilities) || b.capabilities.some((c) => typeof c !== "string")))
    return reply.code(400).send({ error: "capabilities must be an array of strings" });
  // An agent that sends no capabilities keeps whatever it declared last, rather
  // than having them erased: an older build of the same runner re-registering
  // during a rollback would otherwise widen itself back to everything.
  // Who is on the other end, when the other end is on the tailnet.
  //
  // This is not authentication and does not make POST /jobs safe to expose --
  // see src/tailnet.ts. It is the narrow thing FLEET_BIND made necessary: once
  // the collector answers on its tailnet address so a roaming laptop can claim
  // work, "the network I chose" includes every node on the tailnet, and a
  // personal fleet should be able to name which of them are its devices.
  //
  // Off unless FLEET_TAILNET_ALLOWLIST is set, and it never fences the LAN.
  if (TAILNET_ALLOWLIST.length > 0) {
    const ip = normaliseIp(req.ip);
    // whois is only paid for when it can change the answer.
    const peer = isTailnetAddress(ip) ? await whois(ip) : null;
    const decision = admit(ip, TAILNET_ALLOWLIST, peer);
    if (!decision.admit) {
      app.log.warn({ device_id: b.device_id, ip, why: decision.why }, "registration refused");
      return reply.code(403).send({ error: `registration refused: ${decision.why}` });
    }
  }
  const capabilities = b.capabilities === undefined ? null : JSON.stringify(b.capabilities);
  // Where it registered from, kept to a /24 (or the IPv6 prefix): enough to
  // tell the house from a cafe, without keeping a movement log.
  const net = (() => {
    const ip = (req.ip ?? "").replace(/^::ffff:/, "");
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split(".").slice(0, 3).join(".") + ".0/24";
    if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
    return null;
  })();
  // ttl_s follows the same rule as capabilities: an agent that does not send it
  // keeps whatever it declared last. A runner rolled back to a build that
  // predates the field must not silently become permanent, or a CI runner's
  // ghost outlives the run it was made for.
  const ttlS = b.ttl_s === undefined ? null : b.ttl_s;
  db.prepare(
    `INSERT INTO devices (device_id, descriptor, pools, capabilities, last_net, ttl_s, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       descriptor = excluded.descriptor, pools = excluded.pools, last_seen = excluded.last_seen,
       capabilities = COALESCE(excluded.capabilities, devices.capabilities),
       last_net = COALESCE(excluded.last_net, devices.last_net),
       ttl_s = COALESCE(excluded.ttl_s, devices.ttl_s)`,
  ).run(b.device_id, JSON.stringify(b.descriptor ?? {}), JSON.stringify(b.pools ?? []), capabilities, net, ttlS);
  announce({
    type: "device", device_id: b.device_id, event: "register",
    pools: b.pools ?? [], capabilities: b.capabilities ?? null,
  });
  // The same Roku, seen earlier by address only: one row is the truth.
  const retired = retireRokuIpDuplicate(b.device_id, (b.descriptor ?? {}) as Record<string, unknown>);
  if (retired) {
    app.log.info({ device_id: retired, now: b.device_id }, "retired a Roku's IP-named duplicate");
    announce({ type: "device", device_id: retired, event: "forget", reason: `same Roku as ${b.device_id}` });
  }
  return { ok: true };
});

app.get("/devices", async () =>
  (db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all() as
    { device_id: string; descriptor: string; pools: string; last_seen: string;
      last_beacon: string | null; capabilities: string | null }[])
    .map((d) => ({
      device_id: d.device_id,
      descriptor: JSON.parse(d.descriptor),
      pools: JSON.parse(d.pools),
      capabilities: deviceCapabilities(d),
      last_seen: d.last_seen,
      last_beacon: d.last_beacon ? JSON.parse(d.last_beacon) : null,
    })));

app.get("/devices/:id/next-job", async (req, reply) => {
  const { id } = req.params as { id: string };
  const dev = db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(id);
  if (!dev) return reply.code(404).send({ error: "unknown device; register first" });
  touchDevice(id);
  // Pools and capabilities are read inside the claim rather than passed in, so
  // an override applied mid-poll takes effect on the next second's attempt.
  const spec = await longPollClaim("device", id, reply);
  if (!spec) return reply.code(204).send();
  return spec;
});

app.get("/executor/next-job", async (req, reply) => {
  const claimant = ((req.query as Record<string, string>).name ?? "host-executor");
  // A poll is a heartbeat. Recording it here means executor liveness needs no
  // new endpoint and no change to the executor itself — and a queue of host
  // jobs with a dead executor stops looking like a queue that is merely slow.
  db.prepare(
    `INSERT INTO executors (name, last_seen, polls) VALUES (?, datetime('now'), 1)
     ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, polls = polls + 1`,
  ).run(claimant);
  const spec = await longPollClaim("host", claimant, reply);
  if (!spec) return reply.code(204).send();
  db.prepare("UPDATE executors SET last_job = ? WHERE name = ?").run(spec.job_id, claimant);
  // Hand back the lease the collector actually granted, not the one the job
  // asked for. Most jobs set none and get a default the executor cannot see;
  // a workload that must finish inside its lease (web-test has nothing to
  // beacon with) can only budget itself if it is told the real number.
  const granted = db.prepare("SELECT lease_ttl_s FROM jobs WHERE job_id = ?").get(spec.job_id) as
    { lease_ttl_s?: number } | undefined;
  return { ...spec, lease: { ...(spec.lease ?? {}), ttl_s: granted?.lease_ttl_s ?? spec.lease?.ttl_s } };
});

// --- jobs ---

app.post("/jobs", async (req, reply) => {
  const out = enqueueJob(req.body as JobSpec, { provenance: provenanceOf(req) });
  if (!out.ok) return reply.code(out.http).send({ error: out.message });
  return reply.code(201).send(
    out.fanout ? { ok: true, fanout: out.fanout, status: out.status } : { ok: true, job_id: out.job_id, status: out.status },
  );
});

// Runs on a timer too; exposed so an operator (or the smoke test) can force a
// pass instead of waiting out the interval.
/**
 * Hand a claimed job back, before doing any of it.
 *
 * This is what makes multi-homing safe, and it exists because of a race that
 * cannot be closed on the agent's side alone.
 *
 * An agent registered with two brains long-polls both. Brain A answers `200`
 * with a job; the agent takes it and aborts its poll to brain B. But B may
 * already have answered `200` in the microseconds before the abort landed, and
 * that job is now claimed by a socket nobody is reading. Left alone it sits in
 * `claimed` until the lease sweep finds it, which is ten minutes by default and
 * four hours for a `drain` -- and it comes back having burned an attempt, so
 * three such races retire the job permanently.
 *
 * So the agent says so instead. A release is not a failure and not a
 * cancellation:
 *
 * - the job goes back to `queued`, immediately claimable by anything
 * - **`attempts` is decremented**, because being handed a job you could not
 *   take is not evidence that the job is flaky, and counting it would exhaust
 *   `max_attempts` on a job that never once misbehaved -- the same reasoning
 *   preemption already uses
 * - `last_error` records that it happened, so a job that keeps being released
 *   is visible rather than merely slow
 *
 * Refused once any result row exists for the job, which is the line between
 * "handed back" and "abandoned half-done": a runner that has already reported
 * an iteration must close the job properly rather than pretend it never had it.
 *
 * Additive, like everything else in this protocol version. An agent that never
 * calls it behaves exactly as agents did before, and pays the lease sweep for
 * the race instead.
 */
const releaseTx = db.transaction((jobId: string, claimant: string | null) => {
  const job = db
    .prepare("SELECT status, claimed_by, attempts FROM jobs WHERE job_id = ?")
    .get(jobId) as { status: string; claimed_by: string | null; attempts: number } | undefined;
  if (!job) return { ok: false as const, why: "no such job" };
  if (job.status !== "claimed") return { ok: false as const, why: `job is ${job.status}, not claimed` };
  // Only the holder may hand it back. Without this any caller could return
  // another agent's running job to the queue, which on an unauthenticated API
  // is a denial of service with one curl.
  if (claimant !== null && job.claimed_by !== null && job.claimed_by !== claimant) {
    return { ok: false as const, why: `job is claimed by ${job.claimed_by}` };
  }
  const reported = db.prepare("SELECT 1 FROM results WHERE job_id = ? LIMIT 1").get(jobId);
  if (reported) return { ok: false as const, why: "results have already been posted for this job" };

  db.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
                     lease_deadline = NULL, attempts = MAX(attempts - 1, 0),
                     last_error = 'released by ' || ? || ' before starting'
     WHERE job_id = ?`,
  ).run(job.claimed_by ?? "the claimant", jobId);
  db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(jobId);
  return { ok: true as const, was: job.claimed_by };
});

app.post("/jobs/:id/release", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { device_id?: string };
  const out = releaseTx(id, typeof body.device_id === "string" ? body.device_id : null);
  if (!out.ok) {
    return reply.code(out.why === "no such job" ? 404 : 409).send({ error: out.why });
  }
  announce({ type: "job", job_id: id, status: "queued", released_by: out.was });
  return { ok: true, job_id: id, status: "queued" };
});

app.post("/jobs/sweep", async () => {
  const swept = sweepLeases();
  return {
    ok: true,
    requeued: swept.requeued.map((j) => j.job_id),
    failed: swept.failed.map((j) => j.job_id),
    forgotten: swept.forgotten,
  };
});

app.get("/jobs/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(id);
  if (!job) return reply.code(404).send({ error: "not found" });
  return job;
});

// --- results ---

/** Closing a job and settling whatever was queued behind it are one write.
 *  A crash between the two would leave a chain permanently stalled on a
 *  dependency that is already finished, which nothing on the collector would
 *  ever come back and fix. */
const closeJobTx = db.transaction((jobId: string, status: Closing["status"], reason: string | null): DepSettlement => {
  // Dropping the deadline takes the job out of the sweep's reach for good.
  // The reason replaces last_error only when there is one: a skip always has
  // one, a failure usually does, and a pass has nothing to say.
  db.prepare(
    `UPDATE jobs SET status = ?, finished_at = datetime('now'), lease_deadline = NULL,
                     last_error = COALESCE(?, last_error)
     WHERE job_id = ?`,
  ).run(status, reason, jobId);
  db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(jobId);
  return settleWaiters(jobId);
});

/**
 * A preempted job stood aside; it did not fail and it did not run out of road.
 *
 * So the attempt it burned is handed back — being interrupted by the operator's
 * own priorities is not evidence that the job is flaky, and counting it would
 * exhaust `max_attempts` on a job that never once misbehaved. The checkpoint
 * the runner uploaded with its final row is recorded as `params.resume_from`,
 * so the next claim continues rather than starting the hour again.
 */
const requeuePreemptedTx = db.transaction((jobId: string, finalRow: Record<string, unknown>) => {
  const row = db.prepare("SELECT spec, status, claimed_by FROM jobs WHERE job_id = ?").get(jobId) as
    | { spec: string; status: string; claimed_by: string | null }
    | undefined;
  if (!row || row.status !== "claimed") return { ok: false as const };

  const resumeFrom = firstArtifactSha(finalRow as Record<string, any>);
  const spec = JSON.parse(row.spec) as JobSpec;
  if (resumeFrom)
    spec.params = { ...((spec.params as Record<string, unknown>) ?? {}), resume_from: resumeFrom };

  db.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, finished_at = NULL,
                     lease_deadline = NULL, attempts = MAX(attempts - 1, 0), spec = ?, last_error = ?
     WHERE job_id = ?`,
  ).run(
    JSON.stringify(spec),
    `preempted on ${row.claimed_by ?? "unknown claimant"}; requeued` +
      (resumeFrom ? ` to resume from ${resumeFrom.slice(0, 12)}` : " with no checkpoint"),
    jobId,
  );
  db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(jobId);
  return { ok: true as const, resume_from: resumeFrom };
});

app.post("/results", async (req, reply) => {
  const b = req.body as {
    schema?: number; kind?: string; job_id?: string; device_id?: string;
    iter?: number; final?: boolean; ok?: boolean; error?: string;
    // A final row that closes nothing: the runner was asked to step aside and
    // has checkpointed. See requeuePreemptedTx.
    preempted?: boolean;
  };
  if (b?.schema !== 1) return reply.code(400).send({ error: "schema must be 1" });
  if (!b.device_id) return reply.code(400).send({ error: "device_id required" });

  if (b.kind === "beacon") {
    db.prepare("INSERT INTO beacon_samples (device_id, job_id, sample) VALUES (?, ?, ?)").run(
      b.device_id, b.job_id ?? null, JSON.stringify(b),
    );
    db.prepare("UPDATE devices SET last_beacon = ?, last_seen = datetime('now') WHERE device_id = ?").run(
      JSON.stringify(b), b.device_id,
    );
    // A beacon carrying a job_id is proof of life for that claim, so it pushes
    // the lease out. Not scoped to claimed_by: host-executor jobs are claimed by
    // the Mac executor but beacon from the device it is driving. lease_renewed
    // false tells a runner its claim is gone (swept, or already finished) and it
    // should stop work rather than keep burning the device.
    let leaseRenewed = false;
    if (b.job_id) {
      leaseRenewed =
        db
          .prepare(
            `UPDATE jobs SET lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds')
             WHERE job_id = ? AND status = 'claimed'`,
          )
          .run(b.job_id).changes > 0;
    }
    // The beacon is also where a preemptible job is asked to step aside. It
    // costs one indexed read on the overwhelming majority of beacons, because
    // anything that is not a live claim with `preemptible: true` in its spec
    // stops right there.
    let preempt = false;
    if (b.job_id && leaseRenewed) {
      const running = db
        .prepare("SELECT spec, priority, executor, claimed_by FROM jobs WHERE job_id = ? AND status = 'claimed'")
        .get(b.job_id) as
        | { spec: string; priority: number; executor: string; claimed_by: string | null }
        | undefined;
      if (running) preempt = preemptionPending(running);
    }
    announce({
      type: "beacon",
      device_id: b.device_id,
      job_id: b.job_id ?? null,
      lease_renewed: leaseRenewed,
      preempt,
      beacon: (b as { beacon?: unknown }).beacon ?? null,
    });
    return { ok: true, lease_renewed: leaseRenewed, preempt };
  }

  if (b.kind !== "result") return reply.code(400).send({ error: "kind must be 'result' or 'beacon'" });
  if (!b.job_id) return reply.code(400).send({ error: "job_id required for kind=result" });
  // Idempotent by (job_id, device_id, iter): retried posts overwrite, never duplicate.
  db.prepare(
    "INSERT OR REPLACE INTO results (job_id, device_id, iter, payload) VALUES (?, ?, ?, ?)",
  ).run(b.job_id, b.device_id, b.iter ?? 0, JSON.stringify(b));
  touchDevice(b.device_id);
  announce({ type: "result", job_id: b.job_id, device_id: b.device_id, iter: b.iter ?? 0, final: !!b.final });

  if (b.final) {
    // A preempted job did not fail and did not finish: it stood aside. It goes
    // back on the queue before anything else looks at it.
    if ((b as { preempted?: boolean }).preempted === true) {
      const out = requeuePreemptedTx(b.job_id, b as Record<string, unknown>);
      if (out.ok) {
        announce({
          type: "job", job_id: b.job_id, status: "queued",
          reason: "preempted", device_id: b.device_id, resume_from: out.resume_from,
        });
        return { ok: true, preempted: true, resume_from: out.resume_from };
      }
      // Not claimed any more — swept, cancelled or already closed. Fall through
      // and record it the ordinary way rather than resurrecting a closed job.
      app.log.warn({ job_id: b.job_id }, "preempted result for a job that is no longer claimed");
    }

    // Failed, done or skipped, judged over every row the job posted: a host
    // job's final row is the executor's verdict, and its devices may all have
    // said `skipped:` underneath a plain `ok: true`.
    const rows = (db
      .prepare("SELECT device_id, payload FROM results WHERE job_id = ? ORDER BY iter, rowid")
      .all(b.job_id) as { device_id: string; payload: string }[])
      .map((r) => ({ device_id: r.device_id, payload: JSON.parse(r.payload) as Record<string, unknown> }));
    const closing = closingStatus(rows, b as Record<string, unknown>);
    const status = closing.status;
    const settled = closeJobTx(b.job_id, status, closing.reason);
    // A finished job has nothing left to show. Outside the transaction, because
    // closing viewer sockets must not be able to roll back a device's result.
    endMirror(b.job_id);
    announce({ type: "job", job_id: b.job_id, status, device_id: b.device_id });
    // Announced after the transaction commits: a broken browser pipe must not
    // roll back a device's result.
    for (const jobId of settled.promoted)
      announce({ type: "job", job_id: jobId, status: "queued", reason: `dependency ${b.job_id} finished` });
    for (const f of settled.failed)
      announce({ type: "job", job_id: f.job_id, status: "failed", reason: f.reason });
    for (const s of settled.skipped)
      announce({ type: "job", job_id: s.job_id, status: "skipped", reason: s.reason });

    // A skip -- nothing attached, a host under pressure -- says nothing about
    // the code, so it must not become a green check.
    reportStatus(b.job_id, status === "failed" ? "failure" : "success", status === "skipped").catch((e) =>
      app.log.error(e, "status report failed"),
    );
    return {
      ok: true, status, promoted: settled.promoted, failed: settled.failed.map((f) => f.job_id),
      skipped: settled.skipped.map((s) => s.job_id),
    };
  }
  return { ok: true };
});

// --- GitHub commit statuses (recorded always, posted only when armed) ---

async function reportStatus(jobId: string, state: "success" | "failure", skipped = false) {
  const row = db.prepare("SELECT spec FROM jobs WHERE job_id = ?").get(jobId) as
    | { spec: string }
    | undefined;
  if (!row) return;
  const target = (JSON.parse(row.spec) as JobSpec & { report_to?: { github_status?: string } })
    .report_to?.github_status;
  if (!target) return;

  let posted = 0;
  let detail: string;
  if (skipped) {
    // Posting `success` for a run that tested nothing would put a green check
    // on a PR where no device ran. Posting nothing leaves the check absent,
    // which is the truth: advisory, it reads as "not run"; required, it
    // blocks until something does run.
    detail = "skipped: nothing ran, so nothing was posted";
  } else if (!GITHUB_STATUS_ARMED || !GITHUB_TOKEN) {
    detail = "dry run: FLEET_GITHUB_STATUS/FLEET_GITHUB_TOKEN not set";
    app.log.info({ job_id: jobId, target, state }, "commit status recorded, not posted (CI off)");
  } else {
    const m = /^([^/]+)\/([^@]+)@(.+)$/.exec(target);
    if (!m) {
      detail = `bad github_status target: ${target}`;
    } else {
      const res = await fetch(`${GITHUB_API}/repos/${m[1]}/${m[2]}/statuses/${m[3]}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state,
          context: "fleet-runner",
          description: `fleet job ${jobId}: ${state}`,
        }),
      });
      posted = res.ok ? 1 : 0;
      detail = `github responded ${res.status}`;
    }
  }
  db.prepare(
    `INSERT INTO status_reports (job_id, target, state, posted, detail) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id, target) DO UPDATE SET state = excluded.state, posted = excluded.posted, detail = excluded.detail`,
  ).run(jobId, target, state, posted, detail);
}

app.get("/status-reports", async () =>
  db.prepare("SELECT * FROM status_reports ORDER BY created_at DESC LIMIT 100").all());

// --- device locks (host executor coordination) ---

const acquireLocksTx = db.transaction((jobId: string, deviceIds: string[]) => {
  const granted: string[] = [];
  const denied: string[] = [];
  for (const id of deviceIds) {
    const existing = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (!existing || existing.job_id === jobId) {
      db.prepare("INSERT OR REPLACE INTO device_locks (device_id, job_id) VALUES (?, ?)").run(id, jobId);
      granted.push(id);
    } else {
      denied.push(id);
    }
  }
  return { granted, denied };
});

app.post("/locks/acquire", async (req, reply) => {
  const b = req.body as { job_id?: string; device_ids?: string[] };
  if (!b?.job_id || !Array.isArray(b.device_ids))
    return reply.code(400).send({ error: "job_id and device_ids required" });
  const outcome = acquireLocksTx(b.job_id, b.device_ids);
  if (outcome.granted.length) announce({ type: "lock", event: "acquire", job_id: b.job_id, devices: outcome.granted });
  return { ok: true, ...outcome };
});

app.post("/locks/release", async (req, reply) => {
  const b = req.body as { job_id?: string };
  if (!b?.job_id) return reply.code(400).send({ error: "job_id required" });
  const released = db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(b.job_id).changes;
  if (released) announce({ type: "lock", event: "release", job_id: b.job_id, released });
  return { ok: true, released };
});

// --- pipeline events (pub/sub without an external broker) ---

app.post("/events/:topic", async (req, reply) => {
  const { topic } = req.params as { topic: string };
  const payload = req.body ?? {};
  const r = db.prepare("INSERT INTO events (topic, payload) VALUES (?, ?)").run(
    topic, JSON.stringify(payload),
  );
  announce({ type: "pipeline-event", topic, id: Number(r.lastInsertRowid) });
  return reply.code(201).send({ ok: true, id: Number(r.lastInsertRowid) });
});

// Long-poll the next event after a cursor; 204 when the poll expires empty.
app.get("/events/:topic/poll", async (req, reply) => {
  const { topic } = req.params as { topic: string };
  const after = Number((req.query as Record<string, string>).after ?? 0);
  for (let i = 0; i < LONG_POLL_S; i++) {
    const row = db
      .prepare("SELECT id, payload, created_at FROM events WHERE topic = ? AND id > ? ORDER BY id LIMIT 1")
      .get(topic, after) as { id: number; payload: string; created_at: string } | undefined;
    if (row) return { id: row.id, payload: JSON.parse(row.payload), created_at: row.created_at };
    await sleep(1000);
  }
  return reply.code(204).send();
});

// --- schedules (nightly runs are just cron-driven enqueues) ---

type ScheduleRow = { id: string; cron: string; template: string; enabled: number; last_run: string | null };

app.post("/schedules", async (req, reply) => {
  const b = req.body as { id?: string; cron?: string; template?: JobSpec; enabled?: boolean };
  if (!b?.id || !b.cron || !b.template)
    return reply.code(400).send({ error: "id, cron, and template required" });
  if (!isValidCron(b.cron)) return reply.code(400).send({ error: `invalid cron: ${b.cron}` });
  if ((b.template as { job_id?: string }).job_id)
    return reply.code(400).send({ error: "template must not carry job_id; the scheduler generates it" });
  db.prepare(
    `INSERT INTO schedules (id, cron, template, enabled) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cron = excluded.cron, template = excluded.template, enabled = excluded.enabled`,
  ).run(b.id, b.cron, JSON.stringify(b.template), b.enabled ? 1 : 0);
  announce({ type: "schedule", event: "upsert", id: b.id, enabled: !!b.enabled });
  return reply.code(201).send({ ok: true, id: b.id, enabled: !!b.enabled });
});

app.get("/schedules", async () =>
  (db.prepare("SELECT * FROM schedules ORDER BY id").all() as ScheduleRow[]).map((s) => ({
    ...s, template: JSON.parse(s.template), enabled: !!s.enabled,
  })));

app.patch("/schedules/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as { enabled?: boolean };
  if (typeof b?.enabled !== "boolean") return reply.code(400).send({ error: "enabled (boolean) required" });
  const changed = db.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, id).changes;
  if (!changed) return reply.code(404).send({ error: "not found" });
  announce({ type: "schedule", event: "toggle", id, enabled: b.enabled });
  return { ok: true, id, enabled: b.enabled };
});

app.delete("/schedules/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const changed = db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes;
  if (!changed) return reply.code(404).send({ error: "not found" });
  announce({ type: "schedule", event: "delete", id });
  return { ok: true };
});

// Fire due schedules for the current minute (at most once per minute each).
// Enqueues through POST /jobs via inject so fanout and validation apply.
async function schedulerTick(now = new Date()): Promise<string[]> {
  const key = minuteKey(now);
  const due = (db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as ScheduleRow[]).filter(
    (s) => s.last_run !== key && cronMatches(s.cron, now),
  );
  const fired: string[] = [];
  for (const s of due) {
    db.prepare("UPDATE schedules SET last_run = ? WHERE id = ?").run(key, s.id);
    const jobId = `${s.id}-${key.replace(/[^0-9]/g, "")}`;
    let payload: Record<string, unknown>;
    try {
      payload = resolveLatestBuild(JSON.parse(s.template) as JobSpec) as Record<string, unknown>;
    } catch (e) {
      // No build to test is not a red nightly -- it is a nightly that did not
      // run. Firing it anyway against a hash that resolves to nothing would
      // produce a failure that looks like the app is broken.
      app.log.warn({ schedule: s.id, reason: String(e) }, "schedule skipped");
      announce({ type: "schedule", event: "skipped", id: s.id, reason: String((e as Error).message ?? e) });
      continue;
    }
    const out = enqueueJob({ ...payload, job_id: jobId } as JobSpec, {
      provenance: { requested_by: `schedule:${s.id}`, source: "schedule" },
    });
    if (out.ok) fired.push(jobId);
    else if (out.code !== "duplicate_job")
      app.log.error({ schedule: s.id, status: out.http, error: out.message }, "schedule enqueue failed");
  }
  return fired;
}

app.post("/schedules/tick", async () => ({ ok: true, fired: await schedulerTick() }));

// --- power control (smart-plug webhooks per pool) ---

app.post("/power/:pool/:state", async (req, reply) => {
  const { pool, state } = req.params as { pool: string; state: string };
  if (state !== "on" && state !== "off") return reply.code(400).send({ error: "state must be on|off" });
  let config: { pools?: Record<string, Record<string, string>> };
  try {
    config = JSON.parse(readFileSync(POWER_CONFIG_PATH, "utf8"));
  } catch {
    return reply.code(404).send({ error: `no power config at ${POWER_CONFIG_PATH}` });
  }
  const url = config.pools?.[pool]?.[state];
  if (!url) return reply.code(404).send({ error: `no ${state} webhook configured for pool ${pool}` });
  const res = await fetch(url, { method: "POST" });
  app.log.info({ pool, state, webhook_status: res.status }, "power webhook fired");
  return { ok: res.ok, pool, state, webhook_status: res.status };
});

// --- artifacts (models and app builds, addressed by sha256) ---

app.post("/artifacts", async (req, reply) => {
  const stream = req.body as Readable;
  if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function")
    return reply.code(400).send({ error: "raw application/octet-stream body required" });

  const tmp = path.join(ARTIFACT_DIR, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash("sha256");
  let size = 0;
  let head: Buffer | null = null;
  try {
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          // Enough of the start to tell what it is, without holding more.
          if (head === null || head.length < 4096)
            head = head === null ? chunk.subarray(0, 4096) : Buffer.concat([head, chunk]).subarray(0, 4096);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  if (size === 0) {
    await unlink(tmp).catch(() => {});
    return reply.code(400).send({ error: "empty body" });
  }

  const sha256 = hash.digest("hex");
  const dest = path.join(ARTIFACT_DIR, sha256);
  if (existsSync(dest)) await unlink(tmp).catch(() => {});
  else await rename(tmp, dest);

  const name = (req.headers["x-artifact-name"] as string | undefined) ?? null;
  // Which app this build IS. Optional, because an artifact can still be an
  // anonymous blob, but a build that says so can be found by a nightly without
  // anyone pinning its hash.
  const app_ = (req.headers["x-artifact-app"] as string | undefined) ?? null;
  const build = (req.headers["x-artifact-build"] as string | undefined) ?? null;
  const platform = (req.headers["x-artifact-platform"] as string | undefined) ?? null;
  const mediaType = cleanMediaType(req.headers["x-artifact-media-type"]) ?? sniffMediaType(head ?? Buffer.alloc(0), name);
  db.prepare(
    "INSERT OR IGNORE INTO artifacts (sha256, name, size, app, build, platform, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(sha256, name, size, app_, build, platform, mediaType);
  // Bytes uploaded before media types were recorded learn theirs the next time
  // somebody uploads them.
  db.prepare("UPDATE artifacts SET media_type = ? WHERE sha256 = ? AND media_type IS NULL").run(mediaType, sha256);
  // Content-addressing means re-uploading identical bytes is an ignored insert,
  // so a revert that republishes an earlier build would otherwise keep that
  // build's original created_at and sort BEHIND the build it just replaced.
  // Stamping published_at is what makes `latest` mean "most recently
  // published" rather than "first seen".
  if (app_) {
    db.prepare(
      `UPDATE artifacts
          SET app = ?, build = COALESCE(?, build), platform = COALESCE(?, platform),
              published_at = datetime('now'),
              publish_seq = (SELECT COALESCE(MAX(publish_seq), 0) + 1 FROM artifacts)
        WHERE sha256 = ?`,
    ).run(app_, build, platform, sha256);
  }
  announce({ type: "artifact", sha256, name, size, app: app_, build });
  return reply.code(201).send({ ok: true, sha256, size, app: app_, build, media_type: mediaType });
});

app.get("/artifacts/:sha256", async (req, reply) => {
  const { sha256 } = req.params as { sha256: string };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });
  const file = path.join(ARTIFACT_DIR, sha256);
  if (!existsSync(file)) return reply.code(404).send({ error: "not found" });
  const size = statSync(file).size;
  reply.header("accept-ranges", "bytes").header("content-type", "application/octet-stream");

  // ?filename= makes a browser save the artifact under a real name. Without it
  // a phone downloading the runner gets a 64-character hash with no extension,
  // which Android will not offer to install. Quoted and stripped of anything
  // that could break out of the header or the filename.
  const wanted = (req.query as Record<string, string | undefined>).filename;
  if (wanted) {
    const safe = wanted.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);
    if (safe) reply.header("content-disposition", `attachment; filename="${safe}"`);
  }

  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] !== "" || m[2] !== "")) {
    const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start < 0 || start > end)
      return reply.code(416).header("content-range", `bytes */${size}`).send();
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .send(createReadStream(file, { start, end }));
  }
  return reply.header("content-length", size).send(createReadStream(file));
});

// --- dashboard ---

// The server-rendered tables that were /dash through Phase 0–4. Kept at
// /dash/legacy while the SPA grows into parity (plan D0→D1): it has no build
// step, so it still works from a bare checkout if the bundle is missing.
app.get("/dash/legacy", async (_req, reply) => {
  reply.type("text/html").send(renderDash());
});
app.get("/dash/legacy/bench", async (_req, reply) => {
  reply.type("text/html").send(renderBench());
});

// Read API for the dashboard, then the SPA itself. Registration order does not
// decide precedence — Fastify prefers static routes over the /dash/* wildcard —
// but reading them in this order matches how a request resolves.
registerApi(app, announce, matchingDevices);
// Before the dashboard's wildcard, though Fastify prefers the static route
// either way. /runner is the one page in this collector that is itself an
// agent: opening it enrols the browser that opened it.
registerRunnerWeb(app);
registerDashStatic(app);

app.get("/", async (_req, reply) => reply.redirect("/dash"));

// --- alerts (plan D5) ---

const ALERT_TICK_MS = Number(process.env.FLEET_ALERT_TICK_MS ?? 60_000);

function fileSize(f: string) {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

export async function alertTick() {
  expireSnoozes();
  const opened = reconcile(
    evaluate(new Date(), {
      dbBytes: ["fleet.db", "fleet.db-wal"].reduce((a, f) => a + fileSize(path.join(DATA_DIR, f)), 0),
      logBytes: fileSize(LOG_FILE),
    }),
  );
  for (const a of opened) {
    app.log.warn({ rule: a.rule, subject: a.subject, severity: a.severity }, a.message);
    announce({ type: "alert", id: a.id, rule: a.rule, subject: a.subject, severity: a.severity, message: a.message });
  }
  // Marked before the await so a webhook that hangs cannot cause a re-notify
  // on the next tick.
  for (const a of opened) db.prepare("UPDATE alerts SET notified = 1 WHERE id = ?").run(a.id);
  await notify(opened, (o, m) => app.log.warn(o, m));
  return opened;
}

app.post("/api/alerts/tick", async (req, reply) => {
  if (!requireToken(req, reply)) return;
  return { ok: true, opened: (await alertTick()).map((a) => a.id) };
});

// --- starting and stopping ---------------------------------------------
//
// This used to be a bare `app.listen(...)` at the bottom of the file, which
// made the collector a script and nothing else. A brain that a desktop app
// switches on and off, and a test that wants a collector of its own, both need
// it to be a thing you call.
//
// The routes above still register at module scope, and that is deliberate: one
// process runs one collector, the Fastify app is its route table, and turning
// that into a factory would be a thousand lines of churn to support something
// nobody needs. What had to become callable is the part with side effects --
// the socket, the four timers, and the directory the artifacts go in.

/** Everything `listen()` started, so `close()` can stop exactly that. */
const running: {
  timers: NodeJS.Timeout[];
  extraServers: ReturnType<typeof createServer>[];
  listening: boolean;
  advertisement: Advertised | null;
} = { timers: [], extraServers: [], listening: false, advertisement: null };

/**
 * Start the collector: bind, sweep once, and set the four timers going.
 *
 * Resolves once the socket is accepting, so a caller that is about to run a
 * job against it does not have to poll `/api/health`.
 */
export async function listen(): Promise<{ port: number; addresses: string[]; id: string; name: string }> {
  if (running.listening) throw new Error("this collector is already listening");
  // After this, config.configure() refuses -- half these values are read once
  // here and half on every request, and a late change would apply to some and
  // not others.
  freezeConfig();
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  // Explicit rather than left to the first query's lazy open, so a broken data
  // directory fails here, with a stack that names it, instead of inside
  // whichever request happened to arrive first.
  openDb(DATA_DIR);
  const me = identity(DATA_DIR);

  try {
    await app.listen({ port: PORT, host: BIND[0] ?? "0.0.0.0" });
  } catch (e) {
    // A collector that could not take its port must not keep its database open.
    // On POSIX that is a leaked handle nobody notices; on Windows the file
    // cannot then be deleted at all, which is how this was found -- the
    // lifecycle check's own temp directory would not go away after it
    // deliberately provoked a second `listen()`.
    closeDb();
    throw e;
  }
  // Node binds one address per server, so every address after the first gets a
  // bare TCP listener whose connections are handed to the same HTTP server.
  // One Fastify app, one route table, several front doors.
  for (const host of BIND.slice(1)) {
    const extra = createServer((socket) => app.server.emit("connection", socket));
    extra.on("error", (e) => app.log.error(e, `bind ${host}:${PORT} failed`));
    extra.listen(PORT, host);
    extra.unref();
    running.extraServers.push(extra);
  }
  running.listening = true;
  app.log.info(`fleet-collector "${me.name}" (${me.id}) listening on ${BIND.join(", ")}:${PORT}`);
  if (BIND.includes("0.0.0.0") || BIND.includes("::")) {
    // Not an error: it is the default and it is right for a LAN-only fleet.
    // Said out loud because there is no authentication behind it, so the
    // network is the whole access control and it should be a decision.
    app.log.warn(
      "listening on every interface with no authentication; " +
        "set FLEET_BIND to loopback plus your tailnet address if agents roam",
    );
  }
  // Announce this brain on the local link, when asked to. Off by default: a
  // collector should not start advertising itself on somebody's office network
  // because they upgraded, and the whole security posture here is that the
  // network is the access control -- so what it announces to is a decision.
  if (DISCOVERY) {
    try {
      running.advertisement = advertise({
        id: me.id,
        name: me.name,
        port: PORT,
        version: APP_VERSION,
        log: (m) => app.log.info(m),
      });
    } catch (e) {
      // A host with no multicast, or a socket the OS refused. Discovery is a
      // convenience; a collector that would not start without it would be a
      // collector that stops working on a network somebody locked down.
      app.log.warn(`mDNS advertising is unavailable (${(e as Error).message}); agents will need the URL`);
    }
  }

  sweepLeases(); // catch claims that lapsed while the collector was down
  // Only samples pools whose power.json entry declares how to read watts, so a
  // fleet with no metering plugs starts exactly as before. Its timers are
  // unref'd, so this never holds the process open on its own.
  startPowerSampler({ log: app.log });
  running.timers.push(setInterval(sweepLeases, SWEEP_MS).unref());
  running.timers.push(
    setInterval(() => {
      schedulerTick().catch((e) => app.log.error(e, "scheduler tick failed"));
    }, SCHEDULER_TICK_MS).unref(),
  );
  // Evaluated on a slower cadence than the sweep: these are conditions
  // measured in minutes, and a tighter loop would only cost the little host CPU.
  alertTick().catch((e) => app.log.error(e, "alert tick failed"));
  running.timers.push(
    setInterval(() => {
      alertTick().catch((e) => app.log.error(e, "alert tick failed"));
    }, ALERT_TICK_MS).unref(),
  );
  // The night-QA morning digest (src/findings.ts). Checked every minute and
  // sent at most once per local day, only when FLEET_FINDINGS_DIGEST_AT and
  // FLEET_ALERT_WEBHOOK are both set -- the same channel alerts use.
  // A malformed repo map files nothing; said once here rather than discovered
  // when the first issue that should have been composed is not.
  if (FINDINGS_REPOS_ERROR) app.log.warn(FINDINGS_REPOS_ERROR);
  for (const w of authWarnings()) app.log.warn(w);
  {
    const opts = digestTickOptions((o, m) => app.log.warn(o, m));
    if (opts.at && opts.webhook) {
      const tick = () => digestTick(new Date(), opts).catch((e) => app.log.error(e, "findings digest failed"));
      void tick();
      running.timers.push(setInterval(tick, 60_000).unref());
      app.log.info(`night-QA digest daily at ${opts.at} local, covering ${opts.hours}h`);
    } else if (opts.at) {
      app.log.warn("FLEET_FINDINGS_DIGEST_AT is set but FLEET_ALERT_WEBHOOK is not; the digest has nowhere to go");
    }
  }
  return { port: PORT, addresses: BIND, id: me.id, name: me.name };
}

/**
 * Stop it again: timers cleared, sockets closed, database released.
 *
 * The timers are the part that matters. They are `unref`'d, so they never held
 * the process open -- but an interval that survives a `close()` keeps sweeping
 * leases against a database somebody else has since opened, which is a fine way
 * to corrupt a test suite.
 *
 * **This is shutdown, not a pause.** A Fastify instance cannot be listened on
 * again once closed, and the app above is a module singleton, so a second
 * `listen()` in the same process throws. That is not a gap being worked around:
 * one process runs one collector for its lifetime, and everything that wants to
 * turn a brain off and on again -- `fleet up`, the desktop app's role switch --
 * does it by stopping and starting the process, which is also what gives each
 * one its own crash domain. What `close()` buys is that stopping it is *clean*:
 * a supervisor's SIGTERM drains the sockets and releases the database instead
 * of having them taken away by the kernel.
 */
export async function close(): Promise<void> {
  // First, so that a browser running elsewhere drops this brain now rather than
  // listing one that stopped minutes ago.
  if (running.advertisement) {
    await running.advertisement.stop().catch(() => {});
    running.advertisement = null;
  }
  for (const t of running.timers) clearInterval(t);
  running.timers = [];
  for (const extra of running.extraServers) extra.close();
  running.extraServers = [];
  if (running.listening) {
    await app.close();
    running.listening = false;
  }
  closeDb();
}

/**
 * Run as a program: `npm start`, and what `fleet collector` execs.
 *
 * Guarded so that importing this module -- which `fleet up` and the tests both
 * do -- registers the routes without binding a socket. `pathToFileURL` rather
 * than a string compare because this repository's own checkout lives under a
 * directory with a space in it, and `file://.../Fleet Runner/...` is not a URL.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  listen().catch((e) => {
    app.log.error(e, "fleet-collector failed to start");
    process.exit(1);
  });
  // A supervisor stops a child with SIGTERM and expects it to go quietly.
  // Without this the socket is dropped by the kernel and any in-flight
  // long-poll is a broken pipe on an agent that did nothing wrong.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      close()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }
}
