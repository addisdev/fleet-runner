/**
 * The shapes the control API answers with, as JSON Schema (2020-12, which is
 * what OpenAPI 3.1 speaks).
 *
 * Three things read these, which is the reason they exist as data rather than
 * as TypeScript types:
 *
 * - the OpenAPI document served at /api/v1/openapi.json
 * - the generated client (src/client/api.gen.ts), whose types are emitted from them
 * - scripts/check-api-v1.ts, which validates every real response against them,
 *   so a handler that drifts from its schema fails `npm test` instead of
 *   quietly lying to every generated client
 *
 * Objects are open (`additionalProperties` unset) on purpose: adding a field is
 * not a breaking change, and a schema that forbade it would make every new
 * field a version bump.
 */
import jobSchemaFile from "../../../schemas/job.schema.json" with { type: "json" };

type Schema = Record<string, unknown>;

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const int = { type: "integer" };
const nint = { type: ["integer", "null"] };
const num = { type: "number" };
const bool = { type: "boolean" };
const obj = { type: "object" };
const nobj = { type: ["object", "null"] };
const strs = { type: "array", items: str };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items: Schema) => ({ type: "array", items });
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties), extra: Schema = {}) =>
  ({ type: "object", properties, required, ...extra });

/** The job spec as the schema file states it, minus what the API fills in. */
function jobSpecInput(): Schema {
  const { $schema: _s, $id: _i, ...rest } = jobSchemaFile as Record<string, unknown>;
  return {
    ...rest,
    // Closed at the top level, unlike the file: a misspelt `worklaod` or
    // `target` is a job that silently runs somewhere other than intended, and
    // an agent is exactly the author who makes that mistake. Nested objects
    // stay as open as the file has them.
    properties: {
      ...(rest.properties as Record<string, unknown>),
      priority: { type: "integer", description: "Higher is claimed first. Default 0." },
      template_id: { type: "string", description: "The saved template this spec came from." },
    },
    additionalProperties: false,
    title: "Job spec",
    description:
      "A Fleet Runner job spec (schema 1). `schema` and `job_id` may be omitted; the API fills in 1 and a " +
      "generated id. A caller that sets job_id is choosing an idempotency key: a second POST with the same id " +
      "is refused with duplicate_job. GET /api/v1/workloads/{name} returns a complete example for each workload.",
    required: ["workload", "executor"],
  };
}

export const SCHEMAS: Record<string, Schema> = {
  Error: object(
    {
      error: object(
        {
          code: {
            type: "string",
            description: "Stable and machine-readable. Branch on this, not on the message.",
            enum: [
              "bad_request", "invalid_spec", "not_found", "duplicate_job", "no_capable_agent",
              "no_matching_devices", "secret_in_spec", "no_build", "invalid_match", "invalid_dependency",
              "unresolved_reference", "conflict", "unauthorized", "insufficient_scope", "forbidden",
              "rate_limited", "internal",
            ],
          },
          message: str,
          hint: { type: "string", description: "What to do about it, when there is something to do." },
          required_scope: str,
        },
        ["code", "message"],
      ),
    },
  ),

  Health: object(
    {
      ok: bool, collector: str, name: str, instance: str, started_at: str, uptime_s: int, now: str, node: str,
      pid: int, stream_clients: int, guard: bool, version: str,
      auth: { enum: ["off", "tokens"] }, auth_protocol: { enum: ["open", "token"] }, api: { const: "v1" },
    },
    ["ok", "collector", "name", "version", "auth", "api"],
  ),

  WhoAmI: object(
    {
      auth: { enum: ["off", "tokens"] },
      protocol: { enum: ["open", "token"] },
      actor: { ...nstr, description: "Who the collector thinks is asking." },
      verified: { ...bool, description: "False when the name came from a header anyone could send (auth off)." },
      token: { oneOf: [{ type: "null" }, object({ id: str, name: str })] },
      scopes: strs,
    },
  ),

  Beacon: {
    type: ["object", "null"],
    properties: {
      battery_pct: { type: ["number", "null"] }, charging: { type: ["boolean", "null"] }, thermal: nstr,
      mem_mb: { type: ["number", "null"] }, job_id: nstr,
    },
  },

  Device: object(
    {
      device_id: str, name: nstr, notes: nstr, descriptor: obj,
      pools: { ...strs, description: "Effective pools: the override when set, otherwise what the runner reported." },
      pools_reported: strs, pools_override: { type: ["array", "null"], items: str },
      capabilities: { type: ["array", "null"], items: str, description: "null: an agent that predates capabilities, offered everything." },
      last_net: nstr, ttl_s: nint, expired: bool, platform: str, kind: nstr, simulator: bool,
      status: { enum: ["online", "stale", "offline"] }, age_s: nint, last_seen: nstr,
      beacon: ref("Beacon"), current_job: nstr,
      lock: { oneOf: [{ type: "null" }, object({ job_id: str, acquired_at: nstr })] },
    },
    ["device_id", "name", "descriptor", "pools", "capabilities", "platform", "kind", "simulator", "status", "last_seen"],
  ),

  DeviceDetail: {
    allOf: [
      ref("Device"),
      object({ counts: obj, jobs: arr(obj), benchmarks: arr(obj) }, ["jobs"]),
    ],
  },

  Job: object(
    {
      job_id: str, workload: str, executor: { enum: ["device", "host"] },
      status: { enum: ["waiting", "queued", "claimed", "done", "failed", "cancelled", "skipped"] },
      claimed_by: nstr, attempts: int, max_attempts: int, priority: int, template_id: nstr,
      depends_on: strs, lease_ttl_s: int, lease_deadline: nstr, lease_remaining_s: nint, duration_s: nint,
      last_error: nstr, created_at: nstr, claimed_at: nstr, finished_at: nstr,
      pool: nstr, match: nstr, device_id: nstr, wants_executor: nstr, exclusive: bool, preemptible: bool,
      backend: nstr, model: nstr, app: nstr, report_to: nobj,
      requested_by: { ...nstr, description: "Verified only when the collector runs with FLEET_AUTH=tokens." },
      source: { ...nstr, description: "Which front door: mcp, cli, ci, dash, schedule, api." },
    },
    ["job_id", "workload", "executor", "status", "attempts", "max_attempts", "created_at", "requested_by", "source"],
  ),

  JobDetail: {
    allOf: [
      ref("Job"),
      object(
        {
          spec: obj, parent: nstr, children: arr(ref("Job")), siblings: arr(ref("Job")),
          results: arr(object({ device_id: str, iter: int, created_at: nstr, payload: obj })),
          beacons: arr(obj),
          artifacts: arr(object({ sha256: str, name: nstr, size: nint, created_at: nstr, in_store: bool, role: { enum: ["input", "output"] } })),
          locks: arr(obj), status_report: nobj, derived_timeline: arr(object({ at: nstr, what: str })),
        },
        ["spec", "results", "artifacts"],
      ),
    ],
  },

  ArtifactRef: object(
    {
      sha256: str, name: nstr, size: nint, media_type: nstr, role: { enum: ["input", "output"] }, in_store: bool,
      url: { type: "string", description: "Where to fetch the bytes, relative to the collector." },
    },
  ),

  DeviceOutcome: object(
    {
      device_id: str, job_id: str,
      status: { enum: ["waiting", "queued", "claimed", "done", "failed", "cancelled", "skipped"] },
      ok: { type: ["boolean", "null"] },
      skipped: { ...bool, description: "Nothing ran (no matching device, or a host refusing work). Not a pass." },
      error: nstr, metrics: nobj,
      test: { oneOf: [{ type: "null" }, object({ passed: nint, failed: nint, skipped: nint }, [])] },
      failing_step: nstr,
    },
    ["device_id", "job_id", "status", "ok", "skipped", "error"],
  ),

  JobSummary: object(
    {
      job_id: str,
      workload: nstr,
      status: {
        type: "string",
        description: "The row's status, or for a fan-out parent the status of the whole family.",
      },
      finished: bool,
      verdict: {
        enum: ["passed", "failed", "skipped", "cancelled", "running", "queued", "waiting", "mixed"],
        description: "skipped means nothing ran; it is not a pass. mixed: some devices passed and some failed.",
      },
      fanout: { ...bool, description: "True when job_id names a fan-out parent and devices are its children." },
      requested_by: nstr, source: nstr, claimed_by: nstr, duration_s: nint, last_error: nstr,
      counts: object({ devices: int, passed: int, failed: int, skipped: int, running: int }),
      devices: arr(ref("DeviceOutcome")),
      artifacts: arr(ref("ArtifactRef")),
      links: object({ self: str, detail: str, wait: str }),
    },
    ["job_id", "status", "finished", "verdict", "counts", "devices", "artifacts", "links"],
  ),

  JobSpecInput: jobSpecInput(),

  JobCreated: object(
    {
      job_id: str, status: str,
      fanout: { ...strs, description: "One child job per device when the spec fanned out." },
      links: object({ summary: str, wait: str, detail: str }),
    },
    ["job_id", "status", "links"],
  ),

  CandidateDevice: object({ device_id: str, model: nstr, os: nstr }),

  Validation: object(
    {
      valid: bool,
      job_id: str,
      status: { type: "string", description: "What the job would be on enqueue: queued, waiting, failed (a dependency failed) or skipped (a dependency skipped)." },
      fanout: strs,
      spec: { ...obj, description: "The spec as it would be stored: `latest` resolved, lease filled in." },
      candidates: arr(ref("CandidateDevice")),
      warnings: { ...strs, description: "Reasons a valid job would sit in the queue." },
      error: SCHEMA_ERROR_INNER(),
      schema_errors: arr(object({ path: str, message: str })),
    },
    ["valid"],
  ),

  Workload: object(
    {
      name: str, executor: { enum: ["device", "host"] }, runs_on: arr({ enum: ["device", "host", "machine"] }),
      summary: str, status: { enum: ["shipped", "reserved", "agent"] }, docs: nstr, params: nobj, example: nobj,
      dangerous: bool,
      available: { ...bool, description: "Something live could claim it right now." },
      agents: { ...int, description: "Live devices declaring it (device workloads) or live host executors (host workloads)." },
    },
    ["name", "executor", "summary", "status", "example", "available", "agents"],
  ),

  Template: object({ id: str, name: nstr, spec: obj, created_at: nstr, updated_at: nstr }),
  Schedule: object({ id: str, cron: str, enabled: bool, last_run: nstr, next_run: nstr }, ["id", "cron", "enabled"]),
  Alert: object({ id: { type: ["integer", "string"] }, rule: str, subject: nstr, severity: str, state: str, message: nstr }, ["id", "rule", "state"]),

  Result: object(
    {
      job_id: str, device_id: str, iter: int, workload: str, final: bool, ok: bool,
      skipped: { ...bool, description: "error starts with `skipped:`: nothing ran." },
      error: nstr, created_at: nstr, metrics: nobj, test: nobj,
      payload: { ...obj, description: "Only with include=payload." },
    },
    ["job_id", "device_id", "iter", "workload", "final", "ok", "skipped", "error", "created_at"],
  ),

  FlakyCell: object(
    {
      build: { type: "string", description: "`<app> <build>`" },
      device_id: str, runs: int, passes: int, failures: int,
      latest: object({ job_id: str, ok: bool, at: nstr }),
    },
  ),

  Artifact: object(
    {
      sha256: str, name: nstr, size: nint, media_type: nstr, app: nstr, build: nstr, platform: nstr,
      created_at: nstr, published_at: nstr, pinned: bool, in_store: bool, url: str,
    },
    ["sha256", "name", "size", "media_type", "in_store", "url"],
  ),

  CancelResult: object(
    {
      job_id: str,
      cancelled: { ...strs, description: "Every job id this cancelled: one, or a fan-out's unfinished children." },
      cascaded: { ...strs, description: "Jobs that were waiting on these and are now failed." },
      note: str,
    },
  ),

  RetryResult: object({ job_id: str, retry_of: str }),

  AuditEntry: object(
    {
      id: int, at: nstr, actor: nstr, verified: bool, token_id: nstr, source: nstr,
      method: str, route: str, status: int, subject: nstr, ip: nstr,
    },
  ),
};

function SCHEMA_ERROR_INNER(): Schema {
  return object({ code: str, message: str, hint: str }, ["code", "message"]);
}

/** A paginated list of `item`. Every list in v1 has this envelope. */
export function listOf(item: string): Schema {
  return object(
    { items: arr(ref(item)), page: int, per_page: int, total: int, pages: int },
  );
}

export { ref, num };
