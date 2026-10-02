// Dashboard mutations (plan D2). Every route here is behind requireToken.
//
// Enqueueing goes through the existing POST /jobs by inject rather than a
// second insert path: fan-out, lease defaults, workload validation and the
// duplicate-id 409 are non-trivial and must not have two implementations that
// can drift.
import type { FastifyInstance } from "fastify";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_DIR } from "../config.js";
import { db } from "../db.js";
import { powerRetention } from "../power.js";
import { isValidMatch } from "../match.js";
import { requireToken } from "./guard.js";
import { iso, parse, sha256Refs } from "./shared.js";

/** How long explore keeps a whole night's trajectories before only the findings' remain (plan, phase 5). */
const EXPLORE_RUN_KEEP_DAYS = 7;

type Announce = (event: { type: string; [k: string]: unknown }) => void;
type MatchingDevices = (
  pool?: string, match?: string, workload?: string, backend?: string | null,
) => {
  device_id: string; pools: string; pools_override: string | null;
  descriptor: string; capabilities: string | null;
}[];

// --- job dependencies -------------------------------------------------------
//
// A chain is declared on the job that waits — `depends_on: ["build-42"]` — not
// by a script sitting on the queue watching for a build to finish. The job is
// inserted as 'waiting', which the claim loop does not look at, and becomes
// 'queued' when the last of its dependencies is 'done'.
//
// The machinery lives in this file because both of the places a job can close
// have to settle whatever was waiting on it: a final result (server.ts) and a
// cancellation (below), and only one of those can import the other.

export type DepSettlement = { promoted: string[]; failed: { job_id: string; reason: string }[] };

// `${jobs.<id>.artifact}` and `${jobs.<id>.metrics.<key>}`. The id is matched
// lazily and the suffix is what anchors the match, so a job id that itself
// contains dots still resolves.
const DEP_REF_SOURCE = String.raw`\$\{jobs\.(.+?)\.(artifact|metrics\.[^}.]+)\}`;

/** Every dependency reference in a blob of spec JSON. */
export function depRefs(specJson: string): { job_id: string; field: string; raw: string }[] {
  return [...specJson.matchAll(new RegExp(DEP_REF_SOURCE, "g"))].map((m) => ({
    raw: m[0],
    job_id: m[1],
    field: m[2],
  }));
}

/** The final result row a job posted, if it posted one. */
function finalResult(jobId: string): Record<string, any> | null {
  for (const r of db
    .prepare("SELECT payload FROM results WHERE job_id = ? ORDER BY rowid DESC")
    .all(jobId) as { payload: string }[]) {
    const payload = parse<Record<string, any>>(r.payload, {});
    if (payload.final) return payload;
  }
  return null;
}

/** The first artifact a result row uploaded. Runners put them under
 *  `test.artifacts` or a bare `artifacts`, always as sha256 strings — this is
 *  the one place that knows both shapes. */
export function firstArtifactSha(payload: Record<string, any> | null | undefined): string | null {
  const list = (payload?.test?.artifacts ?? payload?.artifacts ?? []) as unknown[];
  const found = Array.isArray(list)
    ? list.find((a) => typeof a === "string" && /^[a-f0-9]{64}$/.test(a))
    : undefined;
  return (found as string | undefined) ?? null;
}

function resolveDepRef(jobId: string, field: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const final = finalResult(jobId);
  if (!final) return { ok: false, why: `${jobId} posted no final result row` };
  if (field === "artifact") {
    const sha = firstArtifactSha(final);
    return sha ? { ok: true, value: sha } : { ok: false, why: `${jobId} uploaded no artifact` };
  }
  const key = field.slice("metrics.".length);
  const value = (final.metrics ?? {})[key];
  return value === undefined
    ? { ok: false, why: `${jobId} reported no metric '${key}'` }
    : { ok: true, value };
}

/**
 * Fill in every `${jobs.…}` reference in a spec from the dependency's final
 * result row. A reference that is the whole string keeps the value's type — a
 * metric substituted into `params.threshold` stays a number — while one
 * embedded in a longer string is interpolated as text.
 *
 * References that cannot be resolved are reported rather than blanked. A job
 * promoted with an empty model hash fails at download time, hours later and
 * nowhere near the cause; a job that never runs says why on its own row.
 */
export function substituteDepRefs<T>(spec: T): { spec: T; unresolved: string[] } {
  const unresolved: string[] = [];
  const cache = new Map<string, ReturnType<typeof resolveDepRef>>();
  const resolve = (jobId: string, field: string) => {
    const key = `${jobId}\0${field}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = resolveDepRef(jobId, field);
      cache.set(key, hit);
    }
    return hit;
  };

  const fill = (s: string): unknown => {
    const whole = new RegExp(`^${DEP_REF_SOURCE}$`).exec(s);
    if (whole) {
      const got = resolve(whole[1], whole[2]);
      if (got.ok) return got.value;
      unresolved.push(`${whole[0]} (${got.why})`);
      return s;
    }
    return s.replace(new RegExp(DEP_REF_SOURCE, "g"), (raw, jobId: string, field: string) => {
      const got = resolve(jobId, field);
      if (got.ok) return String(got.value);
      unresolved.push(`${raw} (${got.why})`);
      return raw;
    });
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return fill(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    return node;
  };

  return { spec: walk(spec) as T, unresolved };
}

/**
 * Enqueue-time refusals: a dependency that does not exist, and a cycle.
 *
 * With dependencies required to exist before the job that names them, the only
 * cycle reachable in practice is a job naming itself — but the walk is what
 * makes that a statement about the graph rather than a lucky consequence of
 * insertion order, and it costs one indexed read per link.
 */
export function validateDependencies(jobId: string, deps: string[]): string | null {
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === jobId) return `depends_on forms a cycle back to ${jobId}`;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const row = db.prepare("SELECT depends_on FROM jobs WHERE job_id = ?").get(cur) as
      | { depends_on: string | null }
      | undefined;
    if (row?.depends_on) stack.push(...parse<string[]>(row.depends_on, []));
  }
  for (const d of deps)
    if (!db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(d))
      return `depends_on names a job that does not exist: ${d}`;
  return null;
}

/** A `${jobs.<id>.…}` reference may only name a job this one actually waits
 *  for. Otherwise it would be filled from whatever that job happened to have
 *  produced by the time this one was promoted — or from nothing at all. */
export function validateDepRefs(specJson: string, deps: string[]): string | null {
  for (const ref of depRefs(specJson))
    if (!deps.includes(ref.job_id))
      return `${ref.raw} references ${ref.job_id}, which is not in depends_on`;
  return null;
}

/** What status a job with these dependencies should be inserted as. A chain
 *  whose build already failed is failed on arrival rather than parked in
 *  'waiting' forever: nothing will ever close that dependency again, so no
 *  promotion event is coming. */
export function dependencyState(
  deps: string[],
): { status: "queued" | "waiting" } | { status: "failed"; reason: string } {
  let allDone = true;
  for (const d of deps) {
    const row = db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(d) as { status: string } | undefined;
    if (row?.status === "failed" || row?.status === "cancelled")
      return { status: "failed", reason: `dependency ${d} ${row.status}` };
    if (row?.status !== "done") allDone = false;
  }
  return { status: allDone ? "queued" : "waiting" };
}

/** Every 'waiting' job that names this one as a dependency. */
function waitersOn(jobId: string) {
  return db
    .prepare(
      `SELECT job_id, spec, depends_on FROM jobs
        WHERE status = 'waiting' AND depends_on IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(jobs.depends_on) WHERE value = ?)`,
    )
    .all(jobId) as { job_id: string; spec: string; depends_on: string }[];
}

function failWaiter(jobId: string, reason: string, out: DepSettlement) {
  db.prepare(
    `UPDATE jobs SET status = 'failed', finished_at = datetime('now'),
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  ).run(reason, jobId);
  out.failed.push({ job_id: jobId, reason });
  // The rest of the chain. A broken build must not leave the install and the
  // ui-test behind it sitting in 'waiting' until someone notices next week.
  settleWaiters(jobId, out);
}

/**
 * Resolve everything that was waiting on a job that just closed.
 *
 * A waiter whose last dependency is now 'done' is promoted to 'queued' with its
 * `${jobs.…}` references filled in from the dependency's final row. A waiter
 * whose dependency failed or was cancelled is failed with `last_error` naming
 * it, and that failure cascades.
 *
 * Callers run this inside the transaction that closed the job, and announce
 * what it returns after that transaction commits — a broken dashboard pipe must
 * not roll back a device's result.
 */
export function settleWaiters(
  closedJobId: string,
  out: DepSettlement = { promoted: [], failed: [] },
): DepSettlement {
  for (const w of waitersOn(closedJobId)) {
    const deps = parse<string[]>(w.depends_on, []);
    const states = deps.map((d) => ({
      id: d,
      status:
        (db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(d) as { status: string } | undefined)?.status ??
        null,
    }));

    const broken = states.find((s) => s.status === "failed" || s.status === "cancelled" || s.status === null);
    if (broken) {
      failWaiter(
        w.job_id,
        broken.status === null ? `dependency ${broken.id} no longer exists` : `dependency ${broken.id} ${broken.status}`,
        out,
      );
      continue;
    }
    if (!states.every((s) => s.status === "done")) continue;

    const filled = substituteDepRefs(parse<Record<string, unknown>>(w.spec, {}));
    if (filled.unresolved.length) {
      failWaiter(w.job_id, `cannot resolve ${filled.unresolved.join("; ")}`, out);
      continue;
    }
    db.prepare("UPDATE jobs SET status = 'queued', spec = ? WHERE job_id = ?").run(
      JSON.stringify(filled.spec),
      w.job_id,
    );
    out.promoted.push(w.job_id);
  }
  return out;
}

/** Cancelling is a state change plus lock release. The runner is not told
 *  directly — it learns on its next beacon, which returns lease_renewed:false
 *  because the job is no longer 'claimed'. That is the same path a swept lease
 *  uses, so runners already handle it and no new protocol message is needed.
 *
 *  Cancelling cascades: a job nobody will ever run cannot satisfy anything
 *  waiting on it, so its waiters fail here rather than waiting forever. */
const cancelTx = db.transaction((jobId: string, reason: string) => {
  const job = db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(jobId) as { status: string } | undefined;
  if (!job) return { ok: false as const, code: 404, error: "not found" };
  if (job.status !== "queued" && job.status !== "claimed" && job.status !== "waiting")
    return { ok: false as const, code: 409, error: `job is already ${job.status}` };

  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'),
                     lease_deadline = NULL, last_error = ?
     WHERE job_id = ?`,
  ).run(reason, jobId);
  const released = db.prepare("DELETE FROM device_locks WHERE job_id = ?").run(jobId).changes;
  return { ok: true as const, was: job.status, released, settled: settleWaiters(jobId) };
});

export function registerMutations(app: FastifyInstance, announce: Announce, matchingDevices: MatchingDevices) {
  // --- jobs ---

  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const reason = ((req.body as { reason?: string } | null)?.reason ?? "cancelled from the dashboard").slice(0, 500);

    const out = cancelTx(id, reason);
    if (!out.ok) return reply.code(out.code).send({ error: out.error });
    announce({ type: "job", job_id: id, status: "cancelled", was: out.was });
    for (const f of out.settled.failed)
      announce({ type: "job", job_id: f.job_id, status: "failed", reason: f.reason });
    return {
      ok: true,
      job_id: id,
      was: out.was,
      locks_released: out.released,
      // Whatever was queued behind this job. Named in the response because a
      // cancel that quietly fails three downstream jobs is a surprise.
      cascaded: out.settled.failed.map((f) => f.job_id),
      // Say plainly that stopping the row does not stop the device.
      note:
        out.was === "claimed"
          ? "The runner stops at its next beacon (lease_renewed:false); work already in flight finishes first."
          : `Job was ${out.was}; nothing was running.`,
    };
  });

  // Retry clones the spec under a fresh id rather than resetting the original:
  // the failed attempt and its results stay on the record.
  app.post("/api/jobs/:id/retry", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { pool?: string; device_id?: string; priority?: number };

    const row = db.prepare("SELECT spec, template_id FROM jobs WHERE job_id = ?").get(id) as
      | { spec: string; template_id: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    const spec = parse<Record<string, any>>(row.spec, {});
    const base = String(spec.job_id ?? id).replace(/-r(\d+)$/, "");
    // Walk forward past ids that already exist so a third retry does not 409.
    let attempt = 2;
    let jobId = `${base}-r${attempt}`;
    while (db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(jobId)) {
      attempt++;
      jobId = `${base}-r${attempt}`;
    }

    const retry: Record<string, any> = { ...spec, job_id: jobId };
    delete retry.fanout; // a retry re-runs this job, not the whole shelf
    if (body.pool || body.device_id) {
      retry.targets = { ...(spec.targets ?? {}) };
      if (body.pool) retry.targets.pool = body.pool;
      if (body.device_id) retry.targets.device_id = body.device_id;
    }
    if (Number.isInteger(body.priority)) retry.priority = body.priority;
    if (row.template_id) retry.template_id = row.template_id;

    const res = await app.inject({ method: "POST", url: "/jobs", payload: retry });
    if (res.statusCode !== 201)
      return reply.code(res.statusCode).send({ error: `enqueue failed: ${res.body}` });
    return reply.code(201).send({ ok: true, job_id: jobId, retry_of: id });
  });

  app.patch("/api/jobs/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const { priority } = (req.body ?? {}) as { priority?: number };
    // `typeof` as well as isInteger, because isInteger does not narrow the type
    // and an `undefined` reaching a bound parameter throws at the driver.
    if (typeof priority !== "number" || !Number.isInteger(priority))
      return reply.code(400).send({ error: "priority (integer) required" });

    const changed = db.prepare("UPDATE jobs SET priority = ? WHERE job_id = ?").run(priority, id).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "job", job_id: id, status: "priority", priority });
    return { ok: true, job_id: id, priority };
  });

  // The composer's enqueue. Guarded, then handed to POST /jobs unchanged.
  app.post("/api/jobs", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/jobs", payload: req.body as object });
    return reply.code(res.statusCode).send(res.json());
  });

  /** "N devices match" for the composer, computed with the same function
   *  fan-out uses so the preview cannot promise a different set than it gets. */
  app.post("/api/jobs/preview-targets", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const body = (req.body ?? {}) as {
      targets?: { pool?: string; match?: string; device_id?: string };
      workload?: string; backend?: string;
    };
    const t = body.targets ?? {};
    if (t.match && !isValidMatch(t.match))
      return reply.code(400).send({ error: `invalid targets.match expression: ${t.match}` });

    // The composer knows the workload it is about to enqueue, so the preview
    // counts the agents that can actually run it rather than every agent the
    // pool and match happen to select.
    let devices = matchingDevices(t.pool, t.match, body.workload, body.backend ?? null);
    if (t.device_id) devices = devices.filter((d) => d.device_id === t.device_id);

    return {
      count: devices.length,
      devices: devices.map((d) => {
        const descriptor = parse<Record<string, unknown>>(d.descriptor, {});
        return { device_id: d.device_id, model: descriptor.model ?? null, os: descriptor.os ?? null };
      }),
    };
  });

  // --- devices ---

  app.patch("/api/devices/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string | null; notes?: string | null; pools?: string[] | null };

    const exists = db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(id);
    if (!exists) return reply.code(404).send({ error: "unknown device" });

    if (body.pools !== undefined && body.pools !== null) {
      if (!Array.isArray(body.pools) || body.pools.some((p) => typeof p !== "string"))
        return reply.code(400).send({ error: "pools must be an array of strings, or null to clear the override" });
    }
    if (body.name !== undefined)
      db.prepare("UPDATE devices SET name = ? WHERE device_id = ?").run(body.name || null, id);
    if (body.notes !== undefined)
      db.prepare("UPDATE devices SET notes = ? WHERE device_id = ?").run(body.notes || null, id);
    if (body.pools !== undefined)
      db.prepare("UPDATE devices SET pools_override = ? WHERE device_id = ?").run(
        // null clears the override and hands the device back to what its runner
        // reports, which is different from an override of "no pools".
        body.pools === null ? null : JSON.stringify(body.pools),
        id,
      );

    announce({ type: "device", device_id: id, event: "edit" });
    const row = db.prepare("SELECT pools, pools_override, name, notes FROM devices WHERE device_id = ?").get(id);
    return { ok: true, device_id: id, ...(row as object) };
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    // Forgetting a live device is pointless — it re-registers within a minute
    // and the row comes back, minus the operator's name and notes.
    const claimed = db.prepare("SELECT job_id FROM jobs WHERE status = 'claimed' AND claimed_by = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (claimed)
      return reply.code(409).send({ error: `device is running ${claimed.job_id}; cancel it first` });

    // A host-executor job is claimed by the *executor* ("mac-mini"), never by
    // the device it drives, so claimed_by alone cannot see an exclusive ui-test
    // or drain. Its device lock can: deleting the row below would drop that
    // lock, and the device's own agent — which only stands down while a lock
    // exists — would start claiming work on top of the running test.
    const held = db.prepare("SELECT job_id FROM device_locks WHERE device_id = ?").get(id) as
      | { job_id: string }
      | undefined;
    if (held)
      return reply
        .code(409)
        .send({ error: `device is locked by ${held.job_id}; cancel that job or release the lock first` });

    const changed = db.prepare("DELETE FROM devices WHERE device_id = ?").run(id).changes;
    if (!changed) return reply.code(404).send({ error: "unknown device" });
    db.prepare("DELETE FROM device_locks WHERE device_id = ?").run(id);
    announce({ type: "device", device_id: id, event: "forget" });
    // Results and beacons are deliberately kept: they are measurements, and a
    // device leaving the shelf does not make them untrue.
    return { ok: true, device_id: id, note: "results and beacon history were kept" };
  });

  app.post("/api/devices/:id/release-lock", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const released = db.prepare("DELETE FROM device_locks WHERE device_id = ?").run(id).changes;
    if (released) announce({ type: "lock", event: "release", device_id: id, released });
    return { ok: true, released };
  });

  // --- job templates (the composer's saved specs) ---

  app.get("/api/templates", async () => ({
    templates: (
      db.prepare("SELECT id, name, spec, created_at, updated_at FROM job_templates ORDER BY id").all() as {
        id: string;
        name: string | null;
        spec: string;
        created_at: string;
        updated_at: string | null;
      }[]
    ).map((t) => ({
      ...t,
      spec: parse(t.spec, {}),
      created_at: iso(t.created_at),
      updated_at: iso(t.updated_at),
    })),
  }));

  app.post("/api/templates", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const b = (req.body ?? {}) as { id?: string; name?: string; spec?: Record<string, unknown> };
    if (!b.id || !b.spec) return reply.code(400).send({ error: "id and spec required" });
    if ((b.spec as { job_id?: string }).job_id)
      return reply.code(400).send({ error: "template must not carry job_id; it is generated at enqueue" });

    db.prepare(
      `INSERT INTO job_templates (id, name, spec) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec, updated_at = datetime('now')`,
    ).run(b.id, b.name ?? null, JSON.stringify(b.spec));
    announce({ type: "template", id: b.id, event: "upsert" });
    return reply.code(201).send({ ok: true, id: b.id });
  });

  // --- schedules (plan D4) ---

  for (const [method, path] of [
    ["POST", "/api/schedules"],
    ["PATCH", "/api/schedules/:id"],
    ["DELETE", "/api/schedules/:id"],
  ] as const) {
    const handler = async (req: any, reply: any) => {
      if (!requireToken(req, reply)) return;
      // Forwarded to the long-standing /schedules routes rather than
      // reimplemented: cron validation and the no-job_id rule live there.
      const id = req.params?.id ? `/${encodeURIComponent(req.params.id)}` : "";
      const res = await app.inject({ method, url: `/schedules${id}`, payload: req.body as object });
      return reply.code(res.statusCode).send(res.statusCode === 204 ? null : res.json());
    };
    if (method === "POST") app.post(path, handler);
    else if (method === "PATCH") app.patch(path, handler);
    else app.delete(path, handler);
  }

  /** Fire one schedule now, without waiting for its cron minute and without
   *  disturbing the dedup key that stops it double-firing on its own. */
  app.post("/api/schedules/:id/run", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT template FROM schedules WHERE id = ?").get(id) as { template: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    // Suffixed with 'manual' so a hand-fired run is never mistaken for the
    // scheduler's own, and cannot collide with the minute-keyed id it uses.
    const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const jobId = `${id}-manual-${stamp}`;
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...parse<Record<string, unknown>>(row.template, {}), job_id: jobId },
    });
    if (res.statusCode !== 201) return reply.code(res.statusCode).send({ error: `enqueue failed: ${res.body}` });
    return reply.code(201).send({ ok: true, ...(res.json() as Record<string, unknown>), schedule: id });
  });

  // --- alerts (plan D5) ---

  app.post("/api/alerts/:id/ack", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    // Acknowledged, not resolved: the condition is still true and the alert
    // stays visible. Only the condition clearing resolves it.
    const changed = db
      .prepare("UPDATE alerts SET state = 'acked' WHERE id = ? AND state != 'resolved'")
      .run(Number(id)).changes;
    if (!changed) return reply.code(404).send({ error: "no open alert with that id" });
    announce({ type: "alert", id: Number(id), event: "ack" });
    return { ok: true, id: Number(id), state: "acked" };
  });

  app.post("/api/alerts/:id/snooze", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const minutes = Number((req.body as { minutes?: number } | null)?.minutes ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1) return reply.code(400).send({ error: "minutes must be >= 1" });

    const changed = db
      .prepare(
        `UPDATE alerts SET state = 'snoozed', snooze_until = datetime('now', ?)
         WHERE id = ? AND state != 'resolved'`,
      )
      .run(`+${Math.round(minutes)} minutes`, Number(id)).changes;
    if (!changed) return reply.code(404).send({ error: "no open alert with that id" });
    announce({ type: "alert", id: Number(id), event: "snooze" });
    return { ok: true, id: Number(id), state: "snoozed", minutes };
  });

  // --- artifacts (plan D4) ---

  /** Everything that makes an artifact un-collectable: a textual reference in
   *  something the collector stores, or a pin.
   *
   *  Baselines are the case a text scan cannot reach. An accepted visual
   *  baseline is referenced by a row in `baselines`, not by any job spec, and
   *  its entire purpose is to still exist months later to diff against — so
   *  the scan would have offered every one of them for collection. */
  function protectedShas(): Set<string> {
    const referenced = new Set<string>();
    // explore's whole-night trajectories are referenced by their own result
    // row forever, which would keep every night's screenshots forever. The
    // rule the plan set is seven nights, then only what a finding links to --
    // so those artifacts are judged separately, by explorationKept() below.
    for (const { blob } of [
      ...(db.prepare("SELECT spec AS blob FROM jobs").all() as { blob: string }[]),
      ...(db.prepare("SELECT payload AS blob FROM results").all() as { blob: string }[]),
      ...(db.prepare("SELECT template AS blob FROM schedules").all() as { blob: string }[]),
      ...(db.prepare("SELECT spec AS blob FROM job_templates").all() as { blob: string }[]),
      // A finding links its screenshot, contact sheet, trajectory, log and
      // replay file from the artifact store, and nothing else references them:
      // without this, GC would offer the evidence for every open finding.
      ...(db.prepare("SELECT artifacts || ' ' || COALESCE(replay, '') AS blob FROM findings").all() as { blob: string }[]),
    ]) {
      for (const sha of sha256Refs(blob)) referenced.add(sha);
    }
    for (const b of db.prepare("SELECT sha256 FROM baselines").all() as { sha256: string }[])
      referenced.add(b.sha256);
    for (const a of db.prepare("SELECT sha256 FROM artifacts WHERE pinned = 1").all() as { sha256: string }[])
      referenced.add(a.sha256);
    return referenced;
  }

  /** Artifacts nothing references and nobody pinned. The candidates are listed
   *  before anything is deleted, because a hash the dashboard cannot see a
   *  reference to may still be referenced by something it never indexed. */
  function gcCandidates(olderThanDays: number) {
    const referenced = protectedShas();
    const kept = explorationKept();
    const rows = db
      .prepare(
        `SELECT sha256, name, size, created_at FROM artifacts
         WHERE created_at <= datetime('now', ?) ORDER BY size DESC`,
      )
      .all(`-${olderThanDays} days`) as { sha256: string; name: string | null; size: number; created_at: string }[];
    // A night's run artifacts past their seven days are offered even though a
    // result row names them, unless a finding or a pin keeps them.
    const runs = db
      .prepare(
        `SELECT sha256, name, size, created_at FROM artifacts
         WHERE name LIKE 'explore-run-%' AND created_at <= datetime('now', ?) ORDER BY size DESC`,
      )
      .all(`-${EXPLORE_RUN_KEEP_DAYS} days`) as typeof rows;
    const out = new Map<string, (typeof rows)[number]>();
    for (const a of rows) if (!referenced.has(a.sha256)) out.set(a.sha256, a);
    for (const a of runs) if (!kept.has(a.sha256)) out.set(a.sha256, a);
    return [...out.values()].map((a) => ({ ...a, created_at: iso(a.created_at) }));
  }

  /** What keeps an explore-run artifact past its seven days: a finding naming it, or a pin. */
  function explorationKept(): Set<string> {
    const kept = new Set<string>();
    for (const { blob } of db.prepare("SELECT artifacts || ' ' || COALESCE(replay, '') AS blob FROM findings").all() as { blob: string }[])
      for (const sha of sha256Refs(blob)) kept.add(sha);
    for (const a of db.prepare("SELECT sha256 FROM artifacts WHERE pinned = 1").all() as { sha256: string }[])
      kept.add(a.sha256);
    return kept;
  }

  app.get("/api/artifacts/gc-candidates", async (req) => {
    const days = Math.max(0, Number((req.query as Record<string, string>).days ?? 30) || 30);
    const candidates = gcCandidates(days);
    return {
      days,
      count: candidates.length,
      bytes: candidates.reduce((a, c) => a + c.size, 0),
      candidates: candidates.slice(0, 500),
    };
  });

  /** Pin or unpin. A pin is an operator saying "keep this whatever the scan
   *  thinks"; the reason is stored because a pin with no reason is one nobody
   *  will ever dare remove. */
  app.post("/api/artifacts/:sha256/pin", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { sha256 } = req.params as { sha256: string };
    if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });
    const body = (req.body ?? {}) as { pinned?: boolean; reason?: string };
    const pinned = body.pinned !== false;
    const changed = db
      .prepare("UPDATE artifacts SET pinned = ?, pin_reason = ? WHERE sha256 = ?")
      .run(pinned ? 1 : 0, pinned ? (body.reason ?? "pinned from the dashboard") : null, sha256).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "artifact", sha256, event: pinned ? "pin" : "unpin" });
    return { ok: true, sha256, pinned };
  });

  app.delete("/api/artifacts/:sha256", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { sha256 } = req.params as { sha256: string };
    if (!/^[a-f0-9]{64}$/.test(sha256)) return reply.code(400).send({ error: "bad sha256" });

    const pin = db.prepare("SELECT pinned, pin_reason FROM artifacts WHERE sha256 = ?").get(sha256) as
      | { pinned: number; pin_reason: string | null } | undefined;
    if (pin?.pinned)
      return reply.code(409).send({
        error: `pinned${pin.pin_reason ? `: ${pin.pin_reason}` : ""}; unpin it first if you really mean to delete it`,
      });

    // Refuse while anything still points at it. An artifact is content, not a
    // cache entry: deleting one a queued job needs makes that job fail at
    // download time, long after the click that caused it.
    const referencedBy = (
      db.prepare("SELECT job_id, spec FROM jobs").all() as { job_id: string; spec: string }[]
    ).filter((j) => j.spec.includes(sha256));
    if (referencedBy.length > 0)
      return reply
        .code(409)
        .send({ error: `still referenced by ${referencedBy.length} job(s), e.g. ${referencedBy[0].job_id}` });

    // A baseline is referenced by a row, not by any spec text, so the scan
    // above cannot see it. Deleting one leaves a visual suite diffing against
    // nothing and reporting every page as changed.
    const baseline = db.prepare("SELECT suite, page, profile FROM baselines WHERE sha256 = ?").get(sha256) as
      | { suite: string; page: string; profile: string } | undefined;
    if (baseline)
      return reply.code(409).send({
        error: `accepted visual baseline for ${baseline.suite}/${baseline.page} (${baseline.profile}); ` +
          "accept a different shot first",
      });

    const removed = db.prepare("DELETE FROM artifacts WHERE sha256 = ?").run(sha256).changes;
    if (!removed) return reply.code(404).send({ error: "not found" });
    await unlink(path.join(ARTIFACT_DIR, sha256)).catch(() => {});
    announce({ type: "artifact", sha256, event: "delete" });
    return { ok: true, sha256 };
  });

  // --- system (plan D4) ---

  app.post("/api/system/sweep", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/jobs/sweep" });
    return reply.code(res.statusCode).send(res.json());
  });

  app.post("/api/system/scheduler-tick", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const res = await app.inject({ method: "POST", url: "/schedules/tick" });
    return reply.code(res.statusCode).send(res.json());
  });

  app.post("/api/power/:pool/:state", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { pool, state } = req.params as { pool: string; state: string };
    const res = await app.inject({ method: "POST", url: `/power/${encodeURIComponent(pool)}/${encodeURIComponent(state)}` });
    return reply.code(res.statusCode).send(res.json());
  });

  /**
   * Retention. A 60 s beacon is ~1.4k rows per device per day, so the table
   * that powers the battery charts is also the one that grows without bound.
   * Deliberately manual: a nightly job that silently deletes measurements is a
   * worse default than a button someone presses.
   */
  app.post("/api/system/retention", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const b = (req.body ?? {}) as {
      beacon_days?: number; event_days?: number; power_days?: number; dry_run?: boolean;
    };
    const beaconDays = Number(b.beacon_days ?? 30);
    const eventDays = Number(b.event_days ?? 30);
    // Power samples arrive every few seconds per pool rather than once a minute
    // per device, so this table outgrows the beacons it sits beside. Same
    // manual posture, same default, its own knob.
    const powerDays = Number(b.power_days ?? 30);
    if (!Number.isFinite(beaconDays) || beaconDays < 1 || !Number.isFinite(eventDays) || eventDays < 1 ||
        !Number.isFinite(powerDays) || powerDays < 1)
      return reply.code(400).send({ error: "beacon_days, event_days and power_days must be >= 1" });

    const countBeacons = db.prepare("SELECT COUNT(*) AS n FROM beacon_samples WHERE ts <= datetime('now', ?)");
    const countEvents = db.prepare("SELECT COUNT(*) AS n FROM events WHERE created_at <= datetime('now', ?)");
    const beacons = (countBeacons.get(`-${beaconDays} days`) as { n: number }).n;
    const events = (countEvents.get(`-${eventDays} days`) as { n: number }).n;
    const power = powerRetention(powerDays, true).power_samples;

    if (b.dry_run !== false) return { ok: true, dry_run: true, would_delete: { beacons, events, power_samples: power } };

    db.prepare("DELETE FROM beacon_samples WHERE ts <= datetime('now', ?)").run(`-${beaconDays} days`);
    db.prepare("DELETE FROM events WHERE created_at <= datetime('now', ?)").run(`-${eventDays} days`);
    powerRetention(powerDays, false);
    announce({ type: "retention", beacons, events, power_samples: power });
    return { ok: true, dry_run: false, deleted: { beacons, events, power_samples: power } };
  });

  app.delete("/api/templates/:id", async (req, reply) => {
    if (!requireToken(req, reply)) return;
    const { id } = req.params as { id: string };
    const changed = db.prepare("DELETE FROM job_templates WHERE id = ?").run(id).changes;
    if (!changed) return reply.code(404).send({ error: "not found" });
    announce({ type: "template", id, event: "delete" });
    return { ok: true };
  });
}
