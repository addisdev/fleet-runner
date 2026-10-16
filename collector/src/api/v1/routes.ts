/**
 * The control API: /api/v1.
 *
 * Every operation is one entry in ROUTES, and that entry is the only place the
 * operation is described. Fastify registration, the OpenAPI document, the
 * generated client, the MCP tool table and the skill's command list are all
 * read off it, so they cannot disagree about a parameter's name.
 *
 * The rules every handler keeps, because a caller that learned them on one
 * endpoint should be able to rely on them on the next:
 *
 * - A list is `{items, page, per_page, total, pages}`.
 * - A failure is `{error: {code, message, hint?}}` with a code from ErrorCode.
 * - Timestamps are ISO 8601 UTC.
 * - `skipped` is never folded into `ok`. Nothing ran is not a pass.
 *
 * Handlers reuse the legacy routes through `forward()` where those already do
 * the work, so a filter fixed in /api/devices is fixed here too. Where the old
 * shape was wrong for a program -- results that dragged every payload along,
 * a summary that existed only as a dashboard component -- the query is here.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { announce, onAnnounce } from "../../announce.js";
import { authOf, forward, type Scope } from "../../auth.js";
import { ARTIFACT_DIR, AUTH, AUTH_PROTOCOL } from "../../config.js";
import { APP_VERSION } from "../../version.js";
import { db, type SqlParam } from "../../db.js";
import { enqueueJob, WORKLOADS, type ErrorCode, type JobSpec } from "../../queue.js";
import { CATALOG, catalogEntry, type CatalogEntry } from "../../workloads/catalog.js";
import { isTextual } from "../../media-type.js";
import { AGE, capabilityMatches, deviceCapabilities, inClause, iso, isExpired, ONLINE_S, paging, parse, sha256Refs } from "../shared.js";
import { needsAdmin, notOwned } from "../policy.js";
import { dashTokenOk } from "../guard.js";
import { schedulesView } from "../system.js";
import { SCHEMAS } from "./schemas.js";
import { isSkipError } from "../../skip.js";
import { errorsOf, paramsValidator, validateSpec, type SchemaError } from "./spec-check.js";
import { findingDetail, listFindings, parseVerdictBody, setVerdict } from "../../findings.js";

// --- the table's types ------------------------------------------------------------

export type ParamType = "string" | "integer" | "boolean";

export type Param = {
  name: string;
  in: "path" | "query";
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
};

export type Response = {
  status: number;
  description: string;
  /** A component name, `list:<Component>` for the list envelope, or null for no JSON body. */
  schema: string | null;
  contentType?: string;
};

type Query = Record<string, string | number | boolean | undefined>;

type Handler = (ctx: { app: FastifyInstance; req: FastifyRequest; reply: FastifyReply; q: Query; p: Record<string, string> }) => Promise<unknown>;

export type Route = {
  operationId: string;
  method: "GET" | "POST";
  /** OpenAPI-style path: `/api/v1/jobs/{id}`. */
  path: string;
  tag: "meta" | "devices" | "workloads" | "jobs" | "results" | "artifacts" | "findings" | "fleet" | "protocol";
  summary: string;
  description?: string;
  scope: "public" | "protocol" | Scope;
  params?: Param[];
  body?: { schema: string; description: string; required: boolean };
  responses: Response[];
  /** Safe to call any number of times with no effect beyond the first. MCP's idempotentHint. */
  idempotent?: boolean;
  /** Changes nothing. MCP's readOnlyHint. */
  readOnly?: boolean;
  /** Undoes or stops work someone else may be relying on. MCP's destructiveHint. */
  destructive?: boolean;
  /** Implemented elsewhere (the runner protocol); listed so the document is whole. */
  documentOnly?: boolean;
  handler?: Handler;
};

// --- envelopes ---------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly http: number,
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const notFound = (what: string, hint?: string) => new ApiError(404, "not_found", `${what} not found`, hint);

export function errorBody(code: string, message: string, hint?: string, details?: unknown) {
  return { error: { code, message, ...(hint ? { hint } : {}), ...(details !== undefined ? { details } : {}) } };
}

function list<T>(items: T[], page: number, per_page: number, total: number) {
  return { items, page, per_page, total, pages: Math.max(1, Math.ceil(total / per_page)) };
}

/** Page through an array the legacy route returned whole. */
function pageOf<T>(all: T[], q: Query) {
  const { page, per_page, offset } = paging(q as Record<string, string | undefined>, 100, 500);
  return list(all.slice(offset, offset + per_page), page, per_page, all.length);
}

/** A forwarded legacy route's JSON, or an ApiError carrying its message. */
async function inner<T>(app: FastifyInstance, req: FastifyRequest, method: "GET" | "POST", url: string, payload?: unknown): Promise<T> {
  const res = await forward(app, req, { method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const body = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
  if (res.statusCode >= 400) {
    const message = typeof body.error === "string" ? body.error : `upstream ${res.statusCode}`;
    const code: ErrorCode =
      res.statusCode === 404 ? "not_found" : res.statusCode === 409 ? "conflict" : res.statusCode === 400 ? "bad_request"
        : res.statusCode === 401 ? "unauthorized" : res.statusCode === 403 ? "forbidden" : "internal";
    throw new ApiError(res.statusCode, code, message);
  }
  return body as T;
}

const qs = (q: Query, names: string[]) => {
  const out = new URLSearchParams();
  for (const n of names) if (q[n] !== undefined && q[n] !== "") out.set(n, String(q[n]));
  const s = out.toString();
  return s ? `?${s}` : "";
};

// --- parameters shared across operations -------------------------------------------

const PAGE: Param[] = [
  { name: "page", in: "query", type: "integer", description: "1-based page.", minimum: 1, default: 1 },
  { name: "per_page", in: "query", type: "integer", description: "Items per page.", minimum: 1, maximum: 500 },
];
const JOB_ID: Param = { name: "id", in: "path", type: "string", required: true, description: "A job id, or a fan-out parent's id." };
const FINDING_ID: Param = { name: "id", in: "path", type: "integer", required: true, description: "The finding's id." };
/** A finding id from the path, or a 404 for anything that cannot be one. */
const findingId = (raw: string) => {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new ApiError(404, "not_found", `finding ${raw} not found`, "finding ids are positive integers");
  return Number(raw);
};
const SHA: Param = { name: "sha256", in: "path", type: "string", required: true, description: "The artifact's sha256 (64 hex)." };

const E400: Response = { status: 400, description: "The request was malformed or the spec is invalid.", schema: "Error" };
const E401: Response = { status: 401, description: "A token is required (FLEET_AUTH=tokens).", schema: "Error" };
const E403: Response = { status: 403, description: "The token lacks the scope, or the job is someone else's.", schema: "Error" };
const E404: Response = { status: 404, description: "No such thing.", schema: "Error" };
const E409: Response = { status: 409, description: "The state does not allow it (already finished, duplicate id).", schema: "Error" };

// --- spec validation ----------------------------------------------------------------

/** The spec as v1 accepts it: schema and job_id filled in, then checked strictly. */
function prepareSpec(req: FastifyRequest): { spec: JobSpec; entry: CatalogEntry | null } {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "bad_request", "the body must be a JSON job spec", "GET /api/v1/workloads/{name} returns an example spec");
  const ctx = authOf(req);
  const raw = body as Record<string, unknown>;
  const spec: Record<string, unknown> = { ...raw, schema: raw.schema ?? 1 };
  if (spec.job_id === undefined) {
    const who = (ctx.source ?? "api").replace(/[^\w-]/g, "").slice(0, 12) || "api";
    const what = String(spec.workload ?? "job").replace(/[^\w-]/g, "").slice(0, 24) || "job";
    spec.job_id = `${who}-${what}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  }

  if (!validateSpec(spec))
    throw new ApiError(400, "invalid_spec", "the job spec does not match the schema", "schema_errors names each problem by JSON pointer", { schema_errors: errorsOf(validateSpec) });

  const entry = catalogEntry(String(spec.workload));
  const pv = paramsValidator(entry);
  if (pv && !pv(spec.params ?? {}))
    throw new ApiError(400, "invalid_spec", `params do not match the ${entry!.name} manifest`, `GET /api/v1/workloads/${entry!.name} has the params schema`, { schema_errors: errorsOf(pv, "/params") });

  // A script runner reachable from a chat window is the one thing this API
  // will not do for an ordinary token, however the spec is phrased. The same
  // function decides it for the older enqueue routes.
  const refused = needsAdmin(ctx, spec.workload);
  if (refused) throw new ApiError(403, "forbidden", refused.message, refused.hint);

  return { spec: spec as JobSpec, entry };
}

// --- workloads ----------------------------------------------------------------------

type LiveAgents = { devices: { caps: string[] | null }[]; executors: number };

function liveAgents(): LiveAgents {
  const rows = db.prepare(`SELECT capabilities, ttl_s, ${AGE("last_seen")} AS age_s FROM devices`).all() as {
    capabilities: string | null; ttl_s: number | null; age_s: number | null;
  }[];
  const devices = rows
    .filter((r) => r.age_s !== null && r.age_s <= ONLINE_S && !isExpired(r, r.age_s))
    .map((r) => ({ caps: deviceCapabilities(r) }));
  const executors = (db.prepare(`SELECT COUNT(*) AS n FROM executors WHERE ${AGE("last_seen")} <= 120`).get() as { n: number }).n;
  return { devices, executors };
}

function workloadView(entry: CatalogEntry, live: LiveAgents) {
  const agents = entry.executor === "host" ? live.executors : live.devices.filter((d) => capabilityMatches(d.caps, entry.name)).length;
  return { ...entry, dangerous: !!entry.dangerous, available: agents > 0, agents };
}

/** Names agents declare that the collector ships nothing for: real work, undocumented here. */
function declaredOnly(live: LiveAgents) {
  const known = new Set([...CATALOG.map((c) => c.name), ...WORKLOADS]);
  const counts = new Map<string, number>();
  for (const d of live.devices)
    for (const c of new Set((d.caps ?? []).map((x) => x.split(":")[0]))) if (!known.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([name, n]) => ({
    name, executor: "device" as const, runs_on: ["device" as const],
    summary: `Declared by ${n} live agent${n === 1 ? "" : "s"}; the collector publishes no description or params for it.`,
    status: "agent" as const, docs: null, params: null,
    example: { schema: 1, job_id: `example-${name}`, workload: name, executor: "device" },
    dangerous: false, available: true, agents: n,
  }));
}

// --- job summaries --------------------------------------------------------------------

type SummaryJob = {
  job_id: string; workload: string; status: string; claimed_by: string | null; last_error: string | null;
  requested_by: string | null; source: string | null; spec: string; duration_s: number | null;
};

const SUMMARY_COLUMNS = `job_id, workload, status, claimed_by, last_error, requested_by, source, spec,
  CASE WHEN claimed_at IS NOT NULL THEN CAST(strftime('%s', COALESCE(finished_at, datetime('now'))) - strftime('%s', claimed_at) AS INTEGER) END AS duration_s`;

const FINISHED = new Set(["done", "failed", "cancelled", "skipped"]);
const likePrefix = (p: string) => `${p.replace(/[\\%_]/g, "\\$&")}--%`;

function familyOf(id: string): { jobs: SummaryJob[]; fanout: boolean } | null {
  const self = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM jobs WHERE job_id = ?`).get(id) as SummaryJob | undefined;
  if (self) return { jobs: [self], fanout: false };
  // A fan-out parent has no row of its own: POST /jobs inserts only children.
  const children = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM jobs WHERE parent_job_id = ? OR job_id LIKE ? ESCAPE '\\' ORDER BY job_id`)
    .all(id, likePrefix(id)) as SummaryJob[];
  return children.length ? { jobs: children, fanout: true } : null;
}

type DeviceOutcome = {
  device_id: string; job_id: string; status: string; ok: boolean | null; skipped: boolean; error: string | null;
  metrics: Record<string, unknown> | null; test: { passed: number | null; failed: number | null; skipped: number | null } | null;
  failing_step: string | null;
};

function outcomesOf(job: SummaryJob): DeviceOutcome[] {
  const rows = db
    .prepare("SELECT device_id, iter, payload FROM results WHERE job_id = ? ORDER BY iter, rowid")
    .all(job.job_id) as { device_id: string; iter: number; payload: string }[];
  // The newest row per device wins, and a final row beats any later progress row.
  const byDevice = new Map<string, Record<string, any>>();
  for (const r of rows) {
    const payload = parse<Record<string, any>>(r.payload, {});
    const prev = byDevice.get(r.device_id);
    if (!prev || !prev.final || payload.final) byDevice.set(r.device_id, payload);
  }
  // The host executor's `host:<name>` row is its own verdict over the devices it
  // drove; it stands in for a device only when no device reported.
  let entries = [...byDevice];
  if (entries.some(([d]) => !d.startsWith("host:"))) entries = entries.filter(([d]) => !d.startsWith("host:"));

  const spec = parse<Record<string, any>>(job.spec, {});
  if (entries.length === 0) {
    const device = String(job.claimed_by ?? spec.targets?.device_id ?? "(unassigned)");
    // A job skipped because its dependency skipped never reached a runner, so
    // it has no rows; its status is the whole story.
    const skipped = job.status === "skipped" || isSkipError(job.last_error);
    return [{
      device_id: device, job_id: job.job_id, status: job.status,
      ok: job.status === "skipped" ? true : job.status === "done" ? !skipped : job.status === "failed" ? false : null,
      skipped, error: job.last_error, metrics: null, test: null, failing_step: null,
    }];
  }
  return entries.map(([device, p]) => {
    const error = typeof p.error === "string" ? p.error : null;
    const skipped = isSkipError(error);
    const test = p.test && typeof p.test === "object"
      ? { passed: p.test.passed ?? null, failed: p.test.failed ?? null, skipped: p.test.skipped ?? null }
      : null;
    const failing = p.test?.failing_flow ?? p.test?.failing_step ?? p.failing_step ?? null;
    return {
      device_id: device, job_id: job.job_id, status: job.status,
      ok: FINISHED.has(job.status) || p.final ? p.ok !== false : null,
      skipped, error, metrics: (p.metrics as Record<string, unknown>) ?? null, test,
      failing_step: typeof failing === "string" ? failing : null,
    };
  });
}

function artifactRefs(jobs: SummaryJob[]) {
  const output = new Set<string>();
  const input = new Set<string>();
  for (const j of jobs) {
    for (const s of sha256Refs(j.spec)) input.add(s);
    const payloads = db.prepare("SELECT payload FROM results WHERE job_id = ?").all(j.job_id) as { payload: string }[];
    for (const r of payloads) for (const s of sha256Refs(r.payload)) output.add(s);
  }
  const shas = [...new Set([...output, ...input])].slice(0, 200);
  if (!shas.length) return [];
  const known = new Map(
    (db.prepare(`SELECT sha256, name, size, media_type FROM artifacts WHERE sha256 IN (${shas.map(() => "?").join(",")})`).all(...shas) as {
      sha256: string; name: string | null; size: number; media_type: string | null;
    }[]).map((a) => [a.sha256, a]),
  );
  return shas.filter((s) => known.has(s)).map((s) => {
    const a = known.get(s)!;
    return {
      sha256: s, name: a.name, size: a.size, media_type: a.media_type,
      role: output.has(s) ? ("output" as const) : ("input" as const),
      in_store: existsSync(path.join(ARTIFACT_DIR, s)),
      url: `/api/v1/artifacts/${s}/content`,
    };
  });
}

export function summarize(id: string) {
  const family = familyOf(id);
  if (!family) return null;
  const { jobs, fanout } = family;
  const devices = jobs.flatMap(outcomesOf);
  const finished = jobs.every((j) => FINISHED.has(j.status));
  const passed = devices.filter((d) => d.ok === true && !d.skipped).length;
  const failed = devices.filter((d) => d.ok === false).length;
  const skipped = devices.filter((d) => d.skipped).length;
  const running = jobs.filter((j) => !FINISHED.has(j.status)).length;

  let verdict: string;
  if (!finished) {
    verdict = jobs.some((j) => j.status === "claimed") ? "running" : jobs.some((j) => j.status === "queued") ? "queued" : "waiting";
  } else if (jobs.every((j) => j.status === "cancelled")) verdict = "cancelled";
  else if (failed > 0 && passed > 0) verdict = "mixed";
  else if (failed > 0 || jobs.some((j) => j.status === "failed")) verdict = "failed";
  else if (passed === 0 && (skipped > 0 || jobs.some((j) => j.status === "cancelled"))) verdict = skipped > 0 ? "skipped" : "cancelled";
  else verdict = "passed";

  const head = jobs[0];
  const has = (s: string) => jobs.some((j) => j.status === s);
  const familyStatus = !finished
    ? has("claimed") ? "claimed" : has("queued") ? "queued" : "waiting"
    : jobs.every((j) => j.status === "cancelled") ? "cancelled" : has("failed") ? "failed"
    // Nothing in the family ran: every child skipped (or skipped and was
    // cancelled). One that ran is enough for the family to be done.
    : !has("done") && has("skipped") ? "skipped" : "done";
  const status = fanout ? familyStatus : head.status;
  return {
    job_id: id,
    workload: head.workload ?? null,
    status,
    finished,
    verdict,
    fanout,
    requested_by: head.requested_by,
    source: head.source,
    claimed_by: fanout ? null : head.claimed_by,
    duration_s: fanout ? null : head.duration_s,
    last_error: fanout ? null : head.last_error,
    counts: { devices: devices.length, passed, failed, skipped, running },
    devices,
    artifacts: artifactRefs(jobs),
    links: {
      self: `/api/v1/jobs/${encodeURIComponent(id)}/summary`,
      detail: `/api/v1/jobs/${encodeURIComponent(fanout ? jobs[0].job_id : id)}`,
      wait: `/api/v1/jobs/${encodeURIComponent(id)}/wait`,
    },
  };
}

/** Resolves with the summary once the job (or its whole fan-out) finishes, or at the deadline. */
function waitFor(id: string, timeoutS: number, reply: FastifyReply) {
  return new Promise<ReturnType<typeof summarize>>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(sweep);
      unsubscribe();
      resolve(summarize(id));
    };
    const check = () => {
      const s = summarize(id);
      if (!s || s.finished) finish();
    };
    const unsubscribe = onAnnounce((e) => {
      const jid = typeof e.job_id === "string" ? e.job_id : "";
      if (e.type === "job" && (jid === id || jid.startsWith(`${id}--`))) check();
    });
    // Belt and braces: a status change that skipped announce (a sweep, a
    // restart) is still noticed within five seconds.
    const sweep = setInterval(check, 5_000);
    const deadline = setTimeout(finish, timeoutS * 1000);
    // The response's close, not the request's: the request closes as soon as
    // its (empty) body is read, and a caller that hung up should free the slot.
    reply.raw.once("close", finish);
  });
}

function owned(req: FastifyRequest, ids: string[]) {
  const refused = notOwned(authOf(req), ids);
  if (refused) throw new ApiError(403, "forbidden", refused.message, refused.hint);
}

// --- results ---------------------------------------------------------------------------

function listResults(q: Query) {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (q.job) {
    // A fan-out parent's results are its children's.
    where.push("(r.job_id = ? OR j.parent_job_id = ?)");
    params.push(String(q.job), String(q.job));
  }
  if (q.device) {
    where.push("r.device_id = ?");
    params.push(String(q.device));
  }
  const workload = inClause("j.workload", q.workload as string | undefined);
  if (workload) {
    where.push(workload.sql);
    params.push(...workload.params);
  }
  if (q.final === true) where.push("json_extract(r.payload, '$.final') = 1");
  if (q.ok === false) where.push("json_extract(r.payload, '$.ok') = 0");
  if (q.ok === true) where.push("COALESCE(json_extract(r.payload, '$.ok'), 1) != 0");
  if (q.requested_by) {
    where.push("j.requested_by = ?");
    params.push(String(q.requested_by));
  }
  for (const [key, op] of [["from", ">="], ["to", "<="]] as const) {
    if (q[key]) {
      where.push(`r.created_at ${op} ?`);
      params.push(String(q[key]).replace("T", " ").replace("Z", ""));
    }
  }
  const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM results r JOIN jobs j ON j.job_id = r.job_id${sql}`).get(...params) as { n: number }).n;
  const { page, per_page, offset } = paging(q as Record<string, string | undefined>, 50, 500);
  const rows = db
    .prepare(
      `SELECT r.job_id, r.device_id, r.iter, r.payload, r.created_at, j.workload
       FROM results r JOIN jobs j ON j.job_id = r.job_id${sql}
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, per_page, offset) as { job_id: string; device_id: string; iter: number; payload: string; created_at: string; workload: string }[];
  const withPayload = q.include === "payload";
  return list(
    rows.map((r) => {
      const p = parse<Record<string, any>>(r.payload, {});
      const error = typeof p.error === "string" ? p.error : null;
      return {
        job_id: r.job_id, device_id: r.device_id, iter: r.iter, workload: r.workload,
        final: !!p.final, ok: p.ok !== false, skipped: !!error && error.startsWith("skipped:"), error,
        created_at: iso(r.created_at), metrics: p.metrics ?? null, test: p.test ?? null,
        ...(withPayload ? { payload: p } : {}),
      };
    }),
    page, per_page, total,
  );
}

// --- artifacts -------------------------------------------------------------------------

type ArtifactRow = {
  sha256: string; name: string | null; size: number; media_type: string | null; app: string | null; build: string | null;
  platform: string | null; created_at: string; published_at: string | null; pinned: number | null; channel: string | null;
};

function artifactMeta(sha: string) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ApiError(400, "bad_request", "sha256 must be 64 lowercase hex characters");
  const a = db
    .prepare("SELECT sha256, name, size, media_type, app, build, platform, created_at, published_at, pinned, channel FROM artifacts WHERE sha256 = ?")
    .get(sha) as ArtifactRow | undefined;
  if (!a) throw notFound("artifact");
  return {
    sha256: a.sha256, name: a.name, size: a.size, media_type: a.media_type, app: a.app, build: a.build,
    platform: a.platform, created_at: iso(a.created_at), published_at: iso(a.published_at), pinned: !!a.pinned,
    channel: a.channel === "pr" ? ("pr" as const) : ("main" as const),
    in_store: existsSync(path.join(ARTIFACT_DIR, a.sha256)), url: `/api/v1/artifacts/${a.sha256}/content`,
  };
}

/**
 * Types a browser would execute or render as a page. Artifacts are uploaded by
 * any runner, and serving one inline from the dashboard's own origin would
 * hand that runner the dashboard's session.
 */
const ACTIVE = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)/;

// --- the table ---------------------------------------------------------------------------

export const ROUTES: Route[] = [
  // meta
  {
    operationId: "getHealth", method: "GET", path: "/api/v1/health", tag: "meta", scope: "public", readOnly: true, idempotent: true,
    summary: "Is the collector up, which version, and is auth on.",
    responses: [{ status: 200, description: "Up.", schema: "Health" }],
    handler: async ({ app, req }) => {
      const h = await inner<Record<string, unknown>>(app, req, "GET", "/api/health");
      return { ...h, version: APP_VERSION, auth: AUTH, auth_protocol: AUTH_PROTOCOL, api: "v1" };
    },
  },
  {
    operationId: "whoami", method: "GET", path: "/api/v1/whoami", tag: "meta", scope: "public", readOnly: true, idempotent: true,
    summary: "Who the collector thinks is asking, and with which scopes.",
    description: "Public so a client can ask before it has a token: without one, scopes is empty when auth is on.",
    responses: [{ status: 200, description: "The caller.", schema: "WhoAmI" }],
    handler: async ({ req }) => {
      const ctx = authOf(req);
      return { auth: ctx.mode, protocol: AUTH_PROTOCOL, actor: ctx.actor, verified: ctx.verified, token: ctx.token, scopes: [...ctx.scopes].sort() };
    },
  },
  {
    operationId: "getOpenApi", method: "GET", path: "/api/v1/openapi.json", tag: "meta", scope: "public", readOnly: true, idempotent: true,
    summary: "This document.",
    responses: [{ status: 200, description: "OpenAPI 3.1.", schema: null, contentType: "application/json" }],
    handler: async () => (await import("./openapi.js")).openapiDocument(),
  },

  // devices
  {
    operationId: "listDevices", method: "GET", path: "/api/v1/devices", tag: "devices", scope: "read", readOnly: true, idempotent: true,
    summary: "The shelf: every device and agent, with status, pools, capabilities and current job.",
    description: "Expired ephemeral agents are hidden unless expired=true. Filters combine with AND.",
    params: [
      { name: "status", in: "query", type: "string", description: "Comma-separated: online, stale, offline." },
      { name: "pool", in: "query", type: "string", description: "Only devices in this pool." },
      { name: "platform", in: "query", type: "string", description: "android, ios, macos, linux, windows, roku, web..." },
      { name: "kind", in: "query", type: "string", description: "phone, tablet, tv, laptop, desktop, browser, ci..." },
      { name: "simulator", in: "query", type: "boolean", description: "false hides simulators and emulators." },
      { name: "q", in: "query", type: "string", description: "Substring of id, model, OS or SoC." },
      { name: "expired", in: "query", type: "boolean", description: "Include expired ephemeral agents." },
      ...PAGE,
    ],
    responses: [{ status: 200, description: "Devices, and the facets a filter menu is built from.", schema: "DeviceList" }],
    handler: async ({ app, req, q }) => {
      const body = await inner<{ devices: unknown[]; pools: string[]; platforms: string[]; kinds: string[] }>(
        app, req, "GET", `/api/devices${qs(q, ["status", "pool", "platform", "kind", "simulator", "q", "expired"])}`,
      );
      return { ...pageOf(body.devices, q), facets: { pools: body.pools, platforms: body.platforms, kinds: body.kinds } };
    },
  },
  {
    operationId: "getDevice", method: "GET", path: "/api/v1/devices/{id}", tag: "devices", scope: "read", readOnly: true, idempotent: true,
    summary: "One device: descriptor, beacon, recent jobs and benchmarks.",
    params: [{ name: "id", in: "path", type: "string", required: true, description: "The device id." }],
    responses: [{ status: 200, description: "The device.", schema: "DeviceDetail" }, E404],
    handler: async ({ app, req, p }) => inner(app, req, "GET", `/api/devices/${encodeURIComponent(p.id)}`),
  },

  // workloads
  {
    operationId: "listWorkloads", method: "GET", path: "/api/v1/workloads", tag: "workloads", scope: "read", readOnly: true, idempotent: true,
    summary: "What the fleet can be asked to do, with an example spec each and whether anything live can claim it.",
    description:
      "status: shipped (implemented here), reserved (the name is accepted but nothing here implements it), " +
      "agent (declared by a live agent, undocumented). dangerous workloads are refused to non-admin tokens.",
    params: [
      { name: "available", in: "query", type: "boolean", description: "true: only workloads something live can claim now." },
      { name: "executor", in: "query", type: "string", enum: ["device", "host"], description: "Only this executor." },
    ],
    responses: [{ status: 200, description: "Workloads.", schema: "list:Workload" }],
    handler: async ({ q }) => {
      const live = liveAgents();
      let items = [...CATALOG.map((c) => workloadView(c, live)), ...declaredOnly(live)];
      if (q.available !== undefined) items = items.filter((w) => w.available === q.available);
      if (q.executor) items = items.filter((w) => w.executor === q.executor);
      return list(items, 1, Math.max(1, items.length), items.length);
    },
  },
  {
    operationId: "getWorkload", method: "GET", path: "/api/v1/workloads/{name}", tag: "workloads", scope: "read", readOnly: true, idempotent: true,
    summary: "One workload: its params schema and a complete example spec.",
    params: [{ name: "name", in: "path", type: "string", required: true, description: "The workload name." }],
    responses: [{ status: 200, description: "The workload.", schema: "Workload" }, E404],
    handler: async ({ p }) => {
      const live = liveAgents();
      const entry = catalogEntry(p.name);
      if (entry) return workloadView(entry, live);
      const declared = declaredOnly(live).find((w) => w.name === p.name);
      if (declared) return declared;
      throw notFound(`workload ${p.name}`, "GET /api/v1/workloads lists every name");
    },
  },
  {
    operationId: "listTemplates", method: "GET", path: "/api/v1/templates", tag: "workloads", scope: "read", readOnly: true, idempotent: true,
    summary: "Saved job specs: the team's known-good jobs, ready to run.",
    params: [...PAGE],
    responses: [{ status: 200, description: "Templates.", schema: "list:Template" }],
    handler: async ({ app, req, q }) => pageOf((await inner<{ templates: unknown[] }>(app, req, "GET", "/api/templates")).templates, q),
  },

  // jobs
  {
    operationId: "listJobs", method: "GET", path: "/api/v1/jobs", tag: "jobs", scope: "read", readOnly: true, idempotent: true,
    summary: "Jobs, newest first, filterable.",
    params: [
      { name: "status", in: "query", type: "string", description: "Comma-separated: waiting, queued, claimed, done, failed, cancelled, skipped." },
      { name: "workload", in: "query", type: "string", description: "Comma-separated workload names." },
      { name: "executor", in: "query", type: "string", enum: ["device", "host"], description: "device or host." },
      { name: "device", in: "query", type: "string", description: "Claimed by, or pinned to, this device." },
      { name: "pool", in: "query", type: "string", description: "Targeted at this pool." },
      { name: "requested_by", in: "query", type: "string", description: "Started by this person or token." },
      { name: "mine", in: "query", type: "boolean", description: "true: only jobs the caller started." },
      { name: "source", in: "query", type: "string", description: "mcp, cli, ci, dash, schedule, api." },
      { name: "q", in: "query", type: "string", description: "Substring of the job id." },
      { name: "from", in: "query", type: "string", description: "Created at or after (ISO 8601)." },
      { name: "to", in: "query", type: "string", description: "Created at or before (ISO 8601)." },
      { name: "has_error", in: "query", type: "boolean", description: "true: only jobs with a last_error." },
      ...PAGE,
    ],
    responses: [{ status: 200, description: "Jobs, and the facets a filter menu is built from.", schema: "JobList" }],
    handler: async ({ app, req, q }) => {
      const query: Query = { ...q };
      if (q.mine === true) query.requested_by = authOf(req).actor ?? "\u0000nobody";
      const body = await inner<{
        jobs: unknown[]; page: number; per_page: number; total: number;
        status_counts: Record<string, number>; workloads: string[]; pools: string[];
      }>(
        app, req, "GET",
        `/api/jobs${qs(query, ["status", "workload", "executor", "device", "pool", "requested_by", "source", "q", "from", "to", "has_error", "page", "per_page"])}`,
      );
      return {
        ...list(body.jobs, body.page, body.per_page, body.total),
        facets: { status_counts: body.status_counts, workloads: body.workloads, pools: body.pools },
      };
    },
  },
  {
    operationId: "createJob", method: "POST", path: "/api/v1/jobs", tag: "jobs", scope: "run",
    summary: "Queue a job. Validate it first with validateJob.",
    description:
      "schema and job_id may be omitted. A job_id you choose is an idempotency key: reposting it is refused with " +
      "duplicate_job rather than running twice. A spec with fanout:true creates one child job per matching device; " +
      "the returned job_id is then the parent, which summary and wait understand.",
    body: { schema: "JobSpecInput", description: "The job spec.", required: true },
    responses: [
      { status: 201, description: "Queued (or waiting on dependencies).", schema: "JobCreated" },
      {
        status: 400,
        description:
          "Malformed or refused before queueing: invalid_spec, no_matching_devices (no registered device matches the targets), " +
          "no_build (no artifact for app `latest`), invalid_match, invalid_dependency, secret_in_spec, bad_request.",
        schema: "Error",
      },
      E401, E403, E409,
      {
        status: 422,
        description: "Valid, but cannot be queued: no_capable_agent (nothing declares the workload), unresolved_reference (a template reference that does not resolve).",
        schema: "Error",
      },
    ],
    handler: async ({ req, reply }) => {
      const { spec } = prepareSpec(req);
      const ctx = authOf(req);
      const out = enqueueJob(spec, { provenance: { requested_by: ctx.actor, source: ctx.source ?? "api" } });
      if (!out.ok) throw new ApiError(out.http, out.code, out.message, out.hint);
      const id = out.fanout ? String(spec.job_id) : out.job_id;
      reply.code(201);
      return {
        job_id: id, status: out.status, ...(out.fanout ? { fanout: out.fanout } : {}),
        links: {
          summary: `/api/v1/jobs/${encodeURIComponent(id)}/summary`,
          wait: `/api/v1/jobs/${encodeURIComponent(id)}/wait`,
          detail: `/api/v1/jobs/${encodeURIComponent(out.fanout?.[0] ?? id)}`,
        },
      };
    },
  },
  {
    operationId: "validateJob", method: "POST", path: "/api/v1/jobs/validate", tag: "jobs", scope: "run", readOnly: true, idempotent: true,
    summary: "Dry run: every check createJob makes, the devices it would land on, and why it might sit in the queue.",
    description: "Always 200 for a spec that could be read; valid says whether createJob would accept it.",
    body: { schema: "JobSpecInput", description: "The job spec.", required: true },
    responses: [{ status: 200, description: "The verdict.", schema: "Validation" }, E401, E403],
    handler: async ({ req }) => {
      try {
        const { spec } = prepareSpec(req);
        const out = enqueueJob(spec, { dryRun: true, provenance: { requested_by: authOf(req).actor, source: authOf(req).source ?? "api" } });
        if (!out.ok) return { valid: false, error: { code: out.code, message: out.message, ...(out.hint ? { hint: out.hint } : {}) } };
        return {
          valid: true, job_id: out.job_id, status: out.status, ...(out.fanout ? { fanout: out.fanout } : {}),
          spec: out.preview?.spec, candidates: out.preview?.candidates ?? [], warnings: out.preview?.warnings ?? [],
        };
      } catch (e) {
        if (!(e instanceof ApiError) || e.http === 401 || e.http === 403) throw e;
        const details = e.details as { schema_errors?: SchemaError[] } | undefined;
        return {
          valid: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
          ...(details?.schema_errors ? { schema_errors: details.schema_errors } : {}),
        };
      }
    },
  },
  {
    operationId: "getJob", method: "GET", path: "/api/v1/jobs/{id}", tag: "jobs", scope: "read", readOnly: true, idempotent: true,
    summary: "Everything about one job: spec, every result payload, beacons, artifacts, timeline.",
    description: "Large. For a verdict, use getJobSummary.",
    params: [JOB_ID],
    responses: [{ status: 200, description: "The job.", schema: "JobDetail" }, E404],
    handler: async ({ app, req, p }) => {
      try {
        return await inner(app, req, "GET", `/api/jobs/${encodeURIComponent(p.id)}`);
      } catch (e) {
        if (e instanceof ApiError && e.http === 404 && familyOf(p.id)?.fanout)
          throw notFound(`job ${p.id}`, `${p.id} is a fan-out parent with no row of its own; use /api/v1/jobs/${p.id}/summary`);
        throw e;
      }
    },
  },
  {
    operationId: "getJobSummary", method: "GET", path: "/api/v1/jobs/{id}/summary", tag: "jobs", scope: "read", readOnly: true, idempotent: true,
    summary: "The verdict: passed, failed, skipped, mixed or still going, per device, with artifacts. Small.",
    params: [JOB_ID],
    responses: [{ status: 200, description: "The summary.", schema: "JobSummary" }, E404],
    handler: async ({ p }) => summarize(p.id) ?? (() => { throw notFound(`job ${p.id}`); })(),
  },
  {
    operationId: "waitJob", method: "GET", path: "/api/v1/jobs/{id}/wait", tag: "jobs", scope: "read", readOnly: true, idempotent: true,
    summary: "Hold the request until the job finishes or timeout_s passes, then return its summary.",
    description: "Check `finished` in the answer: at the timeout the summary is returned unfinished. Call again to keep waiting.",
    params: [JOB_ID, { name: "timeout_s", in: "query", type: "integer", minimum: 0, maximum: 120, default: 30, description: "Seconds to wait, at most 120." }],
    responses: [{ status: 200, description: "The summary, finished or not.", schema: "JobSummary" }, E404],
    handler: async ({ reply, p, q }) => {
      const first = summarize(p.id);
      if (!first) throw notFound(`job ${p.id}`);
      const timeout = Math.min(120, Math.max(0, Number(q.timeout_s ?? 30)));
      if (first.finished || timeout === 0) return first;
      return (await waitFor(p.id, timeout, reply)) ?? first;
    },
  },
  {
    operationId: "cancelJob", method: "POST", path: "/api/v1/jobs/{id}/cancel", tag: "jobs", scope: "run", destructive: true, idempotent: false,
    summary: "Stop a job, or every unfinished child of a fan-out. Jobs waiting on it fail.",
    description: "With auth on, a run token may cancel only jobs it started; admin may cancel any.",
    params: [JOB_ID],
    body: { schema: "CancelInput", description: "Optional reason, kept on the job.", required: false },
    responses: [{ status: 200, description: "Cancelled.", schema: "CancelResult" }, E403, E404, E409],
    handler: async ({ app, req, p }) => {
      const family = familyOf(p.id);
      if (!family) throw notFound(`job ${p.id}`);
      const targets = family.fanout ? family.jobs.filter((j) => !FINISHED.has(j.status)).map((j) => j.job_id) : [p.id];
      if (family.fanout && targets.length === 0) throw new ApiError(409, "conflict", "every job in this fan-out has already finished");
      owned(req, targets);
      const reason = (req.body as { reason?: unknown } | null)?.reason;
      const payload = { reason: typeof reason === "string" ? reason : `cancelled via ${authOf(req).source ?? "api"}` };
      const cancelled: string[] = [];
      const cascaded: string[] = [];
      let note = "";
      for (const t of targets) {
        const r = await inner<{ cascaded: string[]; note: string }>(app, req, "POST", `/api/jobs/${encodeURIComponent(t)}/cancel`, payload).catch((e) => {
          if (targets.length === 1) throw e;
          return null; // one child finishing mid-loop is not a failure of the whole cancel
        });
        if (!r) continue;
        cancelled.push(t);
        cascaded.push(...r.cascaded);
        note = r.note;
      }
      return { job_id: p.id, cancelled, cascaded, note };
    },
  },
  {
    operationId: "retryJob", method: "POST", path: "/api/v1/jobs/{id}/retry", tag: "jobs", scope: "run",
    summary: "Run a job again under a new id, optionally on another pool or device. The original stays on the record.",
    params: [JOB_ID],
    body: { schema: "RetryInput", description: "Optional retargeting.", required: false },
    responses: [{ status: 201, description: "The new job.", schema: "RetryResult" }, E403, E404],
    handler: async ({ app, req, reply, p }) => {
      owned(req, [p.id]);
      const r = await inner<{ job_id: string; retry_of: string }>(app, req, "POST", `/api/jobs/${encodeURIComponent(p.id)}/retry`, req.body ?? {});
      reply.code(201);
      return { job_id: r.job_id, retry_of: r.retry_of };
    },
  },

  // results
  {
    operationId: "listResults", method: "GET", path: "/api/v1/results", tag: "results", scope: "read", readOnly: true, idempotent: true,
    summary: "Result rows, newest first. Payloads only on request.",
    params: [
      { name: "job", in: "query", type: "string", description: "A job id; a fan-out parent includes its children." },
      { name: "device", in: "query", type: "string", description: "A device id." },
      { name: "workload", in: "query", type: "string", description: "Comma-separated workload names." },
      { name: "requested_by", in: "query", type: "string", description: "Jobs started by this person or token." },
      { name: "final", in: "query", type: "boolean", description: "true: only each run's final row." },
      { name: "ok", in: "query", type: "boolean", description: "Filter on the verdict." },
      { name: "from", in: "query", type: "string", description: "At or after (ISO 8601)." },
      { name: "to", in: "query", type: "string", description: "At or before (ISO 8601)." },
      { name: "include", in: "query", type: "string", enum: ["payload"], description: "payload: include the full result payload." },
      ...PAGE,
    ],
    responses: [{ status: 200, description: "Results.", schema: "list:Result" }],
    handler: async ({ q }) => listResults(q),
  },
  {
    operationId: "listFlaky", method: "GET", path: "/api/v1/results/flaky", tag: "results", scope: "read", readOnly: true, idempotent: true,
    summary: "UI tests whose verdict flips across runs of the same build on the same device.",
    params: [
      { name: "device", in: "query", type: "string", description: "Only this device." },
      { name: "app", in: "query", type: "string", description: "Only builds of this app." },
    ],
    responses: [{ status: 200, description: "Flaky (build, device) cells.", schema: "list:FlakyCell" }],
    handler: async ({ app, req, q }) => {
      const ui = await inner<{ matrix: { build: string; cells: { device: string; latest: { job_id: string; ok: boolean; at: string | null } | null; runs: number; flaky: boolean }[] }[]; runs: { job_id: string; device_id: string; app: string | null; build: string | null; ok: boolean }[] }>(app, req, "GET", "/api/results/ui");
      const items = ui.matrix.flatMap((row) =>
        row.cells.filter((c) => c.flaky && (!q.device || c.device === q.device) && (!q.app || row.build.startsWith(`${q.app} `))).map((c) => {
          const runs = ui.runs.filter((r) => r.device_id === c.device && `${r.app ?? "?"} ${r.build ?? "?"}` === row.build);
          const passes = runs.filter((r) => r.ok).length;
          return {
            build: row.build, device_id: c.device, runs: c.runs, passes, failures: runs.length - passes,
            latest: { job_id: c.latest?.job_id ?? "", ok: c.latest?.ok ?? false, at: c.latest?.at ?? null },
          };
        }),
      );
      return list(items, 1, Math.max(1, items.length), items.length);
    },
  },

  // artifacts
  {
    operationId: "getArtifact", method: "GET", path: "/api/v1/artifacts/{sha256}", tag: "artifacts", scope: "read", readOnly: true, idempotent: true,
    summary: "What an artifact is: name, size, media type, the build it belongs to.",
    params: [SHA],
    responses: [{ status: 200, description: "The artifact.", schema: "Artifact" }, E400, E404],
    handler: async ({ p }) => artifactMeta(p.sha256),
  },
  {
    operationId: "getArtifactContent", method: "GET", path: "/api/v1/artifacts/{sha256}/content", tag: "artifacts", scope: "read", readOnly: true, idempotent: true,
    summary: "The artifact's bytes, with its media type.",
    description: "Types a browser would execute (HTML, SVG, XML, JavaScript) are always sent as attachments.",
    params: [SHA, { name: "download", in: "query", type: "boolean", description: "true: ask the browser to save it." }],
    responses: [{ status: 200, description: "The bytes.", schema: null, contentType: "application/octet-stream" }, E404],
    handler: async ({ reply, p, q }) => {
      const meta = artifactMeta(p.sha256);
      const file = path.join(ARTIFACT_DIR, meta.sha256);
      if (!existsSync(file)) throw new ApiError(404, "not_found", "the artifact is recorded but its bytes are gone", "it was collected by GC; re-run the job that made it");
      const type = meta.media_type ?? "application/octet-stream";
      const attach = q.download === true || ACTIVE.test(type);
      const filename = (meta.name ?? meta.sha256).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100) || meta.sha256;
      reply
        .header("content-type", isTextual(type) && !type.includes("charset") ? `${type}; charset=utf-8` : type)
        .header("content-length", statSync(file).size)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("content-disposition", `${attach ? "attachment" : "inline"}; filename="${filename}"`);
      return reply.send(createReadStream(file));
    },
  },

  // findings
  {
    operationId: "listFindings", method: "GET", path: "/api/v1/findings", tag: "findings", scope: "read", readOnly: true, idempotent: true,
    summary: "What night QA (the explore workload) found, newest sighting first.",
    description:
      "Each finding was replayed on a clean install before it was filed; `replay_label` says how often it reproduced. " +
      "verdict agent_mistake means the model misread the app, not a bug in it. since=24h is the morning brief.",
    params: [
      { name: "app", in: "query", type: "string", description: "Only this app (the explore app key)." },
      { name: "state", in: "query", type: "string", enum: ["open", "triaged", "all"], description: "open: no verdict yet (or reopened by a regression). Default all." },
      { name: "verdict", in: "query", type: "string", description: "Comma-separated: real, duplicate, not_a_bug, agent_mistake, fixed." },
      { name: "check", in: "query", type: "string", description: "crash, anr, frozen, blank, left_app, a11y, visual, goal, dead_control." },
      { name: "since", in: "query", type: "string", description: "Last seen at or after: ISO 8601, or a span back from now such as 90m, 24h, 7d." },
      ...PAGE,
    ],
    responses: [{ status: 200, description: "Findings, and the facets a filter menu is built from.", schema: "FindingList" }, E400],
    handler: async ({ q }) => {
      const { page, per_page, offset } = paging(q as Record<string, string | undefined>, 50, 500);
      const out = listFindings({
        app: q.app as string | undefined, status: q.state as string | undefined,
        verdict: q.verdict as string | undefined, check: q.check as string | undefined, since: q.since as string | undefined,
        limit: per_page, offset,
      });
      if (!out.ok) throw new ApiError(400, "bad_request", out.error);
      const b = out.body;
      return { ...list(b.findings, page, per_page, b.total), facets: { apps: b.apps, checks: b.checks, counts: b.counts } };
    },
  },
  {
    operationId: "getFinding", method: "GET", path: "/api/v1/findings/{id}", tag: "findings", scope: "read", readOnly: true, idempotent: true,
    summary: "One finding: the steps in words, its evidence as links, the replay flow (inline when small), its regression test and verdict history.",
    params: [FINDING_ID],
    responses: [{ status: 200, description: "The finding.", schema: "FindingDetail" }, E404],
    handler: async ({ p }) => findingDetail(findingId(p.id)) ?? (() => { throw notFound(`finding ${p.id}`, "GET /api/v1/findings lists them"); })(),
  },
  {
    operationId: "setFindingVerdict", method: "POST", path: "/api/v1/findings/{id}/verdict", tag: "findings", scope: "run", idempotent: true,
    summary: "Judge a finding: real, duplicate, not_a_bug, agent_mistake, or fixed (only after real). null reopens.",
    description:
      "real keeps the finding's replay flow as a candidate regression test; fixed makes it active, so the app's nightly " +
      "ui-test (with params.regressions) runs it. duplicate, not_a_bug and agent_mistake retire it. Mark fixed only once a fix " +
      "has merged. Each verdict counts towards the check's precision, which decides what night QA runs tomorrow.",
    params: [FINDING_ID],
    body: { schema: "FindingVerdictInput", description: "The verdict and an optional note.", required: true },
    responses: [
      { status: 200, description: "Recorded.", schema: "FindingVerdictResult" },
      E400, E401, E403, E404,
      { status: 409, description: "fixed on a finding that is not real (conflict).", schema: "Error" },
    ],
    handler: async ({ req, p }) => {
      const id = findingId(p.id);
      // FLEET_DASH_TOKEN's speed bump, as on the dashboard's older route and on
      // cancel (which forwards to a guarded route): a verdict decides what the
      // nightly runs.
      if (!dashTokenOk(req))
        throw new ApiError(401, "unauthorized", "X-Fleet-Token required (FLEET_DASH_TOKEN is set on the collector)", "send the dashboard token as X-Fleet-Token");
      const body = parseVerdictBody(req.body);
      if (!body.ok) throw new ApiError(400, "bad_request", body.error);
      const ctx = authOf(req);
      const out = setVerdict(id, body.verdict, body.note, body.duplicateOf, { who: { actor: ctx.actor, source: ctx.source ?? "api" } });
      if (!out.ok) throw new ApiError(out.status, out.status === 404 ? "not_found" : out.status === 409 ? "conflict" : "bad_request", out.error, out.hint);
      announce({ type: "finding", id, verdict: out.finding.verdict });
      return { finding: findingDetail(id), change: out.change };
    },
  },

  // fleet
  {
    operationId: "listSchedules", method: "GET", path: "/api/v1/schedules", tag: "fleet", scope: "read", readOnly: true, idempotent: true,
    summary: "Cron schedules, with next run and whether one was missed.",
    responses: [{ status: 200, description: "Schedules.", schema: "list:Schedule" }],
    handler: async () => {
      const items = schedulesView();
      return list(items, 1, Math.max(1, items.length), items.length);
    },
  },
  {
    operationId: "listAlerts", method: "GET", path: "/api/v1/alerts", tag: "fleet", scope: "read", readOnly: true, idempotent: true,
    summary: "What the collector thinks is wrong: offline devices, missed schedules, stuck leases.",
    params: [{ name: "state", in: "query", type: "string", description: "Comma-separated: open, acked, snoozed, resolved. Default: all but resolved." }],
    responses: [{ status: 200, description: "Alerts.", schema: "list:Alert" }],
    handler: async ({ app, req, q }) => {
      const body = await inner<{ alerts: unknown[] }>(app, req, "GET", `/api/alerts${qs(q, ["state"])}`);
      return list(body.alerts, 1, Math.max(1, body.alerts.length), body.alerts.length);
    },
  },
  {
    operationId: "listAudit", method: "GET", path: "/api/v1/audit", tag: "fleet", scope: "admin", readOnly: true, idempotent: true,
    summary: "Who changed what: every mutating control request, newest first.",
    params: [
      { name: "actor", in: "query", type: "string", description: "Only this person or token." },
      { name: "source", in: "query", type: "string", description: "Only this front door." },
      ...PAGE,
    ],
    responses: [{ status: 200, description: "Audit entries.", schema: "list:AuditEntry" }, E401, E403],
    handler: async ({ q }) => {
      const where: string[] = [];
      const params: SqlParam[] = [];
      if (q.actor) { where.push("actor = ?"); params.push(String(q.actor)); }
      if (q.source) { where.push("source = ?"); params.push(String(q.source)); }
      const sql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log${sql}`).get(...params) as { n: number }).n;
      const { page, per_page, offset } = paging(q as Record<string, string | undefined>, 50, 500);
      const rows = db.prepare(`SELECT * FROM audit_log${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, per_page, offset) as Record<string, unknown>[];
      return list(rows.map((r) => ({ ...r, at: iso(r.at as string), verified: !!r.verified })), page, per_page, total);
    },
  },

  // The runner protocol, documented so the document is whole. Runners speak it
  // directly; nothing here should be called by an agent composing work.
  {
    operationId: "registerDevice", method: "POST", path: "/devices/register", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "A runner announcing itself (descriptor, pools, capabilities).",
    responses: [{ status: 200, description: "Registered.", schema: null }],
  },
  {
    operationId: "nextJobForDevice", method: "GET", path: "/devices/{id}/next-job", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "A device long-polling for work. 204 when there is none.",
    params: [{ name: "id", in: "path", type: "string", required: true, description: "The device id." }],
    responses: [{ status: 200, description: "A claimed job spec.", schema: null }, { status: 204, description: "No work.", schema: null }],
  },
  {
    operationId: "nextJobForExecutor", method: "GET", path: "/executor/next-job", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "A host executor long-polling for host work.",
    responses: [{ status: 200, description: "A claimed job spec.", schema: null }, { status: 204, description: "No work.", schema: null }],
  },
  {
    operationId: "postResult", method: "POST", path: "/results", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "A runner reporting a result row.",
    responses: [{ status: 200, description: "Recorded.", schema: null }],
  },
  {
    operationId: "uploadArtifact", method: "POST", path: "/artifacts", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "Upload bytes (application/octet-stream). Answers with the sha256 and the detected media type.",
    description:
      "Headers: x-artifact-name, x-artifact-media-type (optional), x-artifact-app, x-artifact-build, " +
      "x-artifact-channel (optional: `pr` for a pull request's build, which `\"sha256\": \"latest\"` never resolves to; absent means a merged build).",
    responses: [{ status: 201, description: "Stored.", schema: null }],
  },
  {
    operationId: "postFinding", method: "POST", path: "/findings", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "The explore workload filing a finding (an ExploreFinding). Upserts on the fingerprint.",
    responses: [{ status: 201, description: "New.", schema: null }, { status: 200, description: "Seen again.", schema: null }],
  },
  {
    operationId: "listRegressionFlows", method: "GET", path: "/findings/regressions", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "A nightly ui-test pulling an app's regression flows (?app= &state=active &platform=).",
    responses: [{ status: 200, description: "{regressions: [...]}, each with its flow text.", schema: null }],
  },
  {
    operationId: "postRegressionRun", method: "POST", path: "/findings/{id}/regression", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "An executor reporting one regression run: {job_id, device_id, build, outcome: passed|reproduced|failed|skipped, detail}. reproduced reopens the finding.",
    params: [{ name: "id", in: "path", type: "integer", required: true, description: "The finding's id." }],
    responses: [{ status: 200, description: "Recorded.", schema: null }],
  },
  {
    operationId: "downloadArtifact", method: "GET", path: "/artifacts/{sha256}", tag: "protocol", scope: "protocol", documentOnly: true,
    summary: "The bytes as application/octet-stream, with Range support. Runners fetch models and builds here.",
    params: [SHA],
    responses: [{ status: 200, description: "The bytes.", schema: null, contentType: "application/octet-stream" }],
  },
];

// --- request bodies too small to deserve a component of their own -----------------------

SCHEMAS.CancelInput = { type: "object", properties: { reason: { type: "string", maxLength: 500 } } };
SCHEMAS.RetryInput = {
  type: "object",
  properties: { pool: { type: "string" }, device_id: { type: "string" }, priority: { type: "integer" } },
};

// --- registration ---------------------------------------------------------------------------

const fastifyPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

/** Query strings are strings. Turn them into what the table says, or refuse. */
function coerce(route: Route, raw: Record<string, unknown>): Query {
  const out: Query = {};
  for (const prm of route.params ?? []) {
    if (prm.in !== "query") continue;
    const v = raw[prm.name];
    if (v === undefined || v === "") continue;
    const s = Array.isArray(v) ? String(v[v.length - 1]) : String(v);
    if (prm.type === "boolean") {
      if (s !== "true" && s !== "false") throw new ApiError(400, "bad_request", `${prm.name} must be true or false`);
      out[prm.name] = s === "true";
    } else if (prm.type === "integer") {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new ApiError(400, "bad_request", `${prm.name} must be an integer`);
      if (prm.minimum !== undefined && n < prm.minimum) throw new ApiError(400, "bad_request", `${prm.name} must be at least ${prm.minimum}`);
      if (prm.maximum !== undefined && n > prm.maximum) throw new ApiError(400, "bad_request", `${prm.name} must be at most ${prm.maximum}`);
      out[prm.name] = n;
    } else {
      if (prm.enum && !prm.enum.includes(s)) throw new ApiError(400, "bad_request", `${prm.name} must be one of ${prm.enum.join(", ")}`);
      out[prm.name] = s;
    }
  }
  return out;
}

export function registerV1(app: FastifyInstance): void {
  for (const route of ROUTES) {
    if (route.documentOnly || !route.handler) continue;
    const handler = route.handler;
    app.route({
      method: route.method,
      url: fastifyPath(route.path),
      handler: async (req, reply) => {
        try {
          const q = coerce(route, (req.query ?? {}) as Record<string, unknown>);
          const out = await handler({ app, req, reply, q, p: (req.params ?? {}) as Record<string, string> });
          if (reply.sent) return reply;
          return out;
        } catch (e) {
          if (e instanceof ApiError) return reply.code(e.http).send(errorBody(e.code, e.message, e.hint, e.details));
          req.log.error(e);
          return reply.code(500).send(errorBody("internal", (e as Error).message ?? "internal error"));
        }
      },
      // Fastify's own parse failures (bad JSON) in the same envelope.
      errorHandler: (err, _req, reply) => {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        reply.code(status).send(errorBody(status === 400 || status === 415 ? "bad_request" : "internal", err.message));
      },
    });
  }

  // Anything else under /api/v1 is a 404 in the envelope, not Fastify's default.
  app.all("/api/v1/*", async (req, reply) =>
    reply.code(404).send(errorBody("not_found", `no route ${req.method} ${req.url.split("?")[0]}`, "GET /api/v1/openapi.json lists every operation")));
}
