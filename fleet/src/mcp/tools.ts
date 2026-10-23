/**
 * The tools, once, for both transports.
 *
 * Each is a thin call through the generated client to one /api/v1 operation,
 * plus the reduction that makes the answer fit in an agent's context: a job
 * detail is tens of kilobytes of beacons, and a summary is what the agent
 * needs to decide what to do next. Nothing here schedules, locks or decides;
 * the collector does, so a tool cannot do anything a person with curl could not.
 *
 * `remote` is true when the call came through the HTTP gateway from a chat
 * client. It narrows three things: dangerous workloads are refused outright,
 * waits are short (a proxy between a chat client and here will not hold a
 * request for fifteen minutes), and errors never include the collector URL.
 */
import type { FleetClient, JobSpecInput, JobSummary } from "../../../collector/src/client/index.js";
import { FleetApiError } from "../../../collector/src/client/index.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };
export type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export type ToolContext = {
  client: FleetClient;
  /** Called through the remote gateway rather than a local stdio session. */
  remote: boolean;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, Json>;
  outputSchema?: Record<string, Json>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** The gateway scope a remote caller needs. */
  needs: "read" | "run";
  /** The same operation as a shell command, for the skill's table. */
  cli: string;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

// --- shaping answers ---------------------------------------------------------------

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Text for every client, structured content for the ones that read it. */
export function ok(value: unknown, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : json(value) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function failure(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: Object.keys(extra).length ? json({ error: message, ...extra }) : message }], isError: true };
}

/** What to do about a refusal, in terms of the other tools. */
const NEXT: Record<string, string> = {
  invalid_spec: "fleet_workloads with name=<workload> returns a valid example; fleet_validate shows each problem.",
  no_capable_agent: "No live agent declares this workload. fleet_workloads with available_only=true lists what can run now.",
  no_matching_devices: "Nothing matches the targets. fleet_devices lists what is online and what each can run.",
  device_reserved: "That device is kept for other work (fleet_devices shows reserved_for). Target another device; do not add the reservation to get it.",
  duplicate_job: "That job_id exists. Omit job_id to have one generated, or fleet_job to read the existing one.",
  no_build: "No artifact is published under that app name. Check app.name, or pin app.sha256.",
  not_found: "Check the id. fleet_results lists recent jobs.",
  forbidden: "This needs someone with more access, or it is someone else's job.",
  insufficient_scope: "Your access does not include this. Ask a fleet admin for the run scope.",
  unauthorized: "The gateway or CLI has no valid token for the collector.",
  unreachable: "The collector did not answer. It may be down or the URL may be wrong.",
  rate_limited: "Too many calls; wait a minute.",
  conflict: "The state does not allow it. For fleet_verdict fixed: mark the finding real first, and fixed once the fix has merged.",
};

export function refusal(name: string, e: unknown, remote: boolean): ToolResult {
  if (e instanceof FleetApiError) {
    const message = remote && e.code === "unreachable" ? "the fleet collector did not answer" : e.message;
    const details = e.details as { schema_errors?: unknown } | undefined;
    return failure(`${name}: ${message}`, {
      code: e.code,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(NEXT[e.code] ? { next: NEXT[e.code] } : {}),
      ...(details?.schema_errors ? { schema_errors: details.schema_errors } : {}),
    });
  }
  return failure(`${name} failed: ${(e as Error).message}`);
}

const clip = (s: string | null | undefined, n = 600) => (s && s.length > n ? `${s.slice(0, n)}... (${s.length - n} more)` : s ?? null);

/** A summary, cut to what decides the next step. */
export function compactSummary(s: JobSummary) {
  return {
    job_id: s.job_id,
    workload: s.workload,
    finished: s.finished,
    verdict: s.verdict,
    status: s.status,
    ...(s.fanout ? { fanout: true } : {}),
    counts: s.counts,
    duration_s: s.duration_s ?? null,
    devices: s.devices.map((d) => ({
      device_id: d.device_id,
      ...(s.fanout ? { job_id: d.job_id } : {}),
      status: d.status,
      ok: d.ok,
      ...(d.skipped ? { skipped: true } : {}),
      ...(d.error ? { error: clip(d.error) } : {}),
      ...(d.failing_step ? { failing_step: d.failing_step } : {}),
      ...(d.test ? { test: d.test } : {}),
      ...(d.metrics && Object.keys(d.metrics).length ? { metrics: d.metrics } : {}),
    })),
    artifacts: s.artifacts.slice(0, 40).map((a) => ({ sha256: a.sha256, name: a.name, media_type: a.media_type, role: a.role })),
    ...(s.artifacts.length > 40 ? { artifacts_truncated: s.artifacts.length - 40 } : {}),
    ...(s.requested_by ? { requested_by: s.requested_by } : {}),
  };
}

const VERDICT_NOTE: Record<string, string> = {
  skipped: "Nothing ran: no device matched, or the host refused the work. This is not a pass.",
  mixed: "Some devices passed and some failed; read each device's error.",
  cancelled: "The job was cancelled before it finished.",
};

function summaryResult(s: JobSummary, extra: Record<string, unknown> = {}): ToolResult {
  const compact = { ...compactSummary(s), ...(VERDICT_NOTE[s.verdict] ? { note: VERDICT_NOTE[s.verdict] } : {}), ...extra };
  const result = ok(compact, compact);
  if (s.artifacts.length) {
    for (const a of s.artifacts.slice(0, 5)) {
      result.content.push({ type: "resource_link", uri: `fleet://artifact/${a.sha256}`, name: a.name ?? a.sha256.slice(0, 12), ...(a.media_type ? { mimeType: a.media_type } : {}) });
    }
  }
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long-poll until finished or the budget runs out, in chunks the collector allows. */
async function waitUntil(client: FleetClient, id: string, budgetS: number): Promise<JobSummary> {
  const deadline = Date.now() + budgetS * 1000;
  let s = await client.getJobSummary(id);
  while (!s.finished && Date.now() < deadline) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    try {
      s = await client.waitJob(id, { timeout_s: Math.max(1, Math.min(60, left)) });
    } catch (e) {
      // A collector restarting mid-wait is a pause, not a verdict.
      if (e instanceof FleetApiError && e.code === "unreachable" && Date.now() < deadline) {
        await sleep(3_000);
        continue;
      }
      throw e;
    }
  }
  return s;
}

const isImage = (t: string | null) => !!t && /^image\/(png|jpeg|gif|webp)$/.test(t);
const isText = (t: string | null) => !!t && (t.startsWith("text/") || t === "application/json" || t === "application/xml");

const DEVICE_OUT: Record<string, Json> = {
  type: "object",
  required: ["devices", "total"],
  properties: {
    total: { type: "integer" },
    devices: {
      type: "array",
      items: {
        type: "object",
        required: ["device_id", "status"],
        properties: {
          device_id: { type: "string" }, name: { type: ["string", "null"] }, status: { type: "string" },
          platform: { type: ["string", "null"] }, kind: { type: ["string", "null"] }, model: { type: ["string", "null"] },
          os: { type: ["string", "null"] }, pools: { type: "array", items: { type: "string" } },
          capabilities: { type: ["array", "null"], items: { type: "string" } }, current_job: { type: ["string", "null"] },
          reserved_for: {
            type: ["string", "null"],
            description: "Kept for one kind of work: only a job with this reservation label that pins the device by id may use it. Do not target it otherwise.",
          },
        },
      },
    },
  },
};

const SUMMARY_OUT: Record<string, Json> = {
  type: "object",
  required: ["job_id", "finished", "verdict", "counts", "devices"],
  properties: {
    job_id: { type: "string" },
    finished: { type: "boolean" },
    verdict: { type: "string", enum: ["passed", "failed", "skipped", "cancelled", "running", "queued", "waiting", "mixed"] },
    status: { type: "string" },
    counts: { type: "object" },
    devices: { type: "array", items: { type: "object" } },
    artifacts: { type: "array", items: { type: "object" } },
    note: { type: "string" },
  },
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const FINDING_ITEM: Record<string, Json> = {
  type: "object",
  required: ["id", "app", "check", "severity", "title", "verdict", "replay", "seen_count"],
  properties: {
    id: { type: "integer" }, app: { type: "string" }, check: { type: "string" }, severity: { type: "string" },
    title: { type: "string" }, screen: { type: "string" }, platform: { type: "string" },
    verdict: { type: ["string", "null"], description: "null: open. agent_mistake: not a bug in the app." },
    replay: { type: "string", description: "reproduced 2/2, flaky 1/2, crash log." },
    seen_count: { type: "integer" }, builds: { type: "integer" }, last_seen: { type: ["string", "null"] },
    regression: { type: ["string", "null"], description: "candidate, active (in the nightly) or retired." },
  },
};

const FINDINGS_OUT: Record<string, Json> = {
  type: "object",
  required: ["findings", "total"],
  properties: { findings: { type: "array", items: FINDING_ITEM }, total: { type: "integer" } },
};

const FINDING_OUT: Record<string, Json> = {
  type: "object",
  required: ["id", "app", "check", "title", "verdict", "steps", "evidence", "history"],
  properties: {
    ...(FINDING_ITEM.properties as Record<string, Json>),
    detail: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "object" } },
    replay_flow: { type: ["object", "null"], description: "kind, sha256, and text when the flow is small enough to inline." },
    regression_test: { type: ["object", "null"] },
    history: { type: "array", items: { type: "object" } },
    note: { type: "string" },
  },
};

const VERDICT_OUT: Record<string, Json> = {
  type: "object",
  required: ["id", "verdict"],
  properties: { id: { type: "integer" }, verdict: { type: ["string", "null"] }, change: { type: ["string", "null"] }, regression: { type: ["string", "null"] } },
};

type FindingRow = {
  id: number; app: string; check: string; severity: string; title: string; screen_name: string; platform: string;
  verdict: string | null; replay_label: string; seen_count: number; builds_seen: string[]; last_seen: string | null;
  regression: { state: string } | null;
};

const findingItem = (f: FindingRow) => ({
  id: f.id, app: f.app, check: f.check, severity: f.severity, title: f.title, screen: f.screen_name, platform: f.platform,
  verdict: f.verdict, replay: f.replay_label, seen_count: f.seen_count, builds: f.builds_seen.length, last_seen: f.last_seen,
  regression: f.regression?.state ?? null,
});

const VERDICT_WORDS = ["real", "duplicate", "not_a_bug", "agent_mistake", "fixed"] as const;

// --- the tools ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "fleet_devices",
    title: "List lab devices",
    cli: "fleetr devices",
    description:
      "The real devices in the lab -- phones, tablets, TVs, watches, machines -- with what each can run. " +
      "Use it before fleet_run to choose targets. Only devices online right now unless status=all.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["online", "all"], description: "Default online." },
        platform: { type: "string", description: "android, ios, tvos, macos, roku, web..." },
        pool: { type: "string", description: "Only devices in this pool." },
        capability: { type: "string", description: "Only devices that can run this workload." },
        include_offline: { type: "boolean", description: "Same as status=all. Kept for older prompts." },
      },
    },
    outputSchema: DEVICE_OUT,
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const all = args.status === "all" || args.include_offline === true;
      const page = await client.listDevices({
        status: all ? undefined : "online",
        platform: typeof args.platform === "string" ? args.platform.toLowerCase() : undefined,
        pool: typeof args.pool === "string" ? args.pool : undefined,
        per_page: 500,
      });
      const cap = typeof args.capability === "string" ? args.capability : null;
      const devices = page.items
        .filter((d) => !cap || d.capabilities === null || d.capabilities.includes(cap) || d.capabilities.some((c) => c.startsWith(`${cap}:`)))
        .map((d) => {
          const ds = d.descriptor as Record<string, unknown>;
          return {
            device_id: d.device_id, name: d.name, status: d.status, platform: d.platform ?? null, kind: d.kind ?? null,
            model: (ds.model as string) ?? null, os: (ds.os as string) ?? null,
            ...(ds.attached_to ? { attached_to: ds.attached_to as string } : {}),
            pools: d.pools, capabilities: d.capabilities, current_job: d.current_job ?? null,
            reserved_for: d.reserved_for ?? null,
          };
        });
      const out = { devices, total: devices.length };
      if (!devices.length)
        return ok(all ? "No devices match." : "No devices are online right now. Pass status=all to see the rest of the shelf.", out);
      return ok(out, out);
    },
  },
  {
    name: "fleet_workloads",
    title: "What the lab can run",
    cli: "fleetr workloads [NAME]",
    description:
      "What the fleet can be asked to do. Without `name`: one line per workload, with whether anything live can " +
      "run it now. With `name`: that workload's params schema and a complete example spec to start fleet_run from.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One workload, in full." },
        available_only: { type: "boolean", description: "Only workloads something live can claim now." },
      },
    },
    annotations: READ,
    needs: "read",
    async run({ client, remote }, args) {
      if (typeof args.name === "string" && args.name) {
        const w = await client.getWorkload(args.name);
        const out = { ...w, ...(remote && w.dangerous ? { note: "Not available through the remote connector." } : {}) };
        return ok(out, out as Record<string, unknown>);
      }
      const page = await client.listWorkloads(args.available_only === true ? { available: true } : undefined);
      const items = page.items
        .filter((w) => !(remote && w.dangerous))
        .map((w) => ({ name: w.name, executor: w.executor, status: w.status, available: w.available, agents: w.agents, summary: w.summary }));
      return ok({ workloads: items, next: "fleet_workloads with name=<workload> for its example spec" }, { workloads: items });
    },
  },
  {
    name: "fleet_validate",
    title: "Check a job spec",
    cli: "fleetr run ... --validate",
    description:
      "Dry run of fleet_run: every check the collector makes, the devices the job would land on, and warnings " +
      "about why it might sit in the queue. Changes nothing. Use it whenever you wrote a spec by hand.",
    inputSchema: {
      type: "object",
      required: ["spec"],
      properties: { spec: { type: "object", description: "The job spec. schema and job_id may be omitted." } },
    },
    annotations: READ,
    needs: "run",
    async run({ client, remote }, args) {
      const spec = args.spec as JobSpecInput;
      if (!spec || typeof spec !== "object") return failure("spec must be a JSON object");
      if (remote && (await isDangerous(client, spec))) return failure(`the ${spec.workload} workload is not available through the remote connector`);
      const v = await client.validateJob(spec);
      return ok(v, v as Record<string, unknown>);
    },
  },
  {
    name: "fleet_run",
    title: "Run a job on real devices",
    cli: "fleetr run WORKLOAD ...",
    description:
      "Queue a job and, by default, wait for the verdict. `spec` is a Fleet Runner job spec: get a valid one from " +
      "fleet_workloads with name=<workload>, check it with fleet_validate. `verdict` is passed, failed, mixed, " +
      "skipped (nothing ran -- NOT a pass), or still running when the wait ran out (follow with fleet_job). " +
      "Artifacts are sha256s; open them with fleet_artifact.",
    inputSchema: {
      type: "object",
      required: ["spec"],
      properties: {
        spec: { type: "object", description: "The job spec. job_id and schema are filled in if absent." },
        wait: { type: "boolean", description: "Wait for the verdict. Default true." },
        timeout_s: { type: "number", description: "How long to wait. Default 900 locally, 45 through the remote connector." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    needs: "run",
    async run({ client, remote }, args) {
      const spec = args.spec as JobSpecInput;
      if (!spec || typeof spec !== "object") return failure("spec must be a JSON object");
      if (typeof spec.workload !== "string" || !spec.workload) return failure("spec.workload is required", { next: NEXT.invalid_spec });
      if (remote && (await isDangerous(client, spec))) return failure(`the ${spec.workload} workload is not available through the remote connector`);
      const created = await client.createJob(spec);
      if (args.wait === false)
        return ok({ job_id: created.job_id, status: created.status, ...(created.fanout ? { fanout: created.fanout } : {}), next: "fleet_job with this job_id" }, { job_id: created.job_id, status: created.status });
      const budget = Math.min(Number(args.timeout_s ?? (remote ? 45 : 900)) || 0, remote ? 55 : 3600);
      const s = await waitUntil(client, created.job_id, budget);
      return summaryResult(s, s.finished ? {} : { next: `still ${s.verdict}; call fleet_job with job_id=${s.job_id} and wait_s to keep waiting` });
    },
  },
  {
    name: "fleet_job",
    title: "A job's verdict",
    cli: "fleetr job ID / fleetr wait ID",
    description:
      "One job's verdict and per-device results, by id. wait_s > 0 holds the call until the job finishes or the " +
      "time is up. Works for a fan-out parent (every device's child at once).",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        wait_s: { type: "number", description: "Seconds to wait for it to finish, at most 120 (55 remotely). Default 0." },
      },
    },
    outputSchema: SUMMARY_OUT,
    annotations: READ,
    needs: "read",
    async run({ client, remote }, args) {
      const id = String(args.job_id ?? "");
      if (!id) return failure("job_id is required");
      const wait = Math.max(0, Math.min(Number(args.wait_s ?? 0) || 0, remote ? 55 : 120));
      return summaryResult(wait ? await client.waitJob(id, { timeout_s: wait }) : await client.getJobSummary(id));
    },
  },
  {
    name: "fleet_cancel",
    title: "Cancel a job",
    cli: "fleetr cancel ID",
    description:
      "Stop a job, or every unfinished device of a fan-out. Jobs waiting on it fail. With auth on you can cancel " +
      "only jobs you started. A device mid-run stops at its next beacon.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, reason: { type: "string", description: "Kept on the job." } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    needs: "run",
    async run({ client }, args) {
      const out = await client.cancelJob(String(args.job_id), typeof args.reason === "string" ? { reason: args.reason } : undefined);
      return ok(out, out as Record<string, unknown>);
    },
  },
  {
    name: "fleet_retry",
    title: "Run a job again",
    cli: "fleetr retry ID",
    description: "Run a finished job again under a new id, optionally on another device or pool. The original stays on the record.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, device_id: { type: "string" }, pool: { type: "string" } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    needs: "run",
    async run({ client }, args) {
      const body: Record<string, string> = {};
      if (typeof args.device_id === "string") body.device_id = args.device_id;
      if (typeof args.pool === "string") body.pool = args.pool;
      const out = await client.retryJob(String(args.job_id), body);
      return ok({ ...out, next: "fleet_job with the new job_id" }, out as Record<string, unknown>);
    },
  },
  {
    name: "fleet_results",
    title: "Recent results",
    cli: "fleetr results",
    description:
      "Recent final results, newest first, by device, workload or job. Use it to ask whether something has failed " +
      "on real hardware before, or what a device measured last time.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string" },
        workload: { type: "string", description: "e.g. ui-test, benchmark, web-shots" },
        job_id: { type: "string" },
        failures_only: { type: "boolean" },
        limit: { type: "number", description: "Default 20, at most 100." },
      },
    },
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const page = await client.listResults({
        device: typeof args.device_id === "string" ? args.device_id : undefined,
        workload: typeof args.workload === "string" ? args.workload : undefined,
        job: typeof args.job_id === "string" ? args.job_id : undefined,
        final: args.job_id ? undefined : true,
        ok: args.failures_only === true ? false : undefined,
        per_page: Math.max(1, Math.min(Number(args.limit ?? 20) || 20, 100)),
      });
      const rows = page.items.map((r) => ({
        at: r.created_at, job_id: r.job_id, device_id: r.device_id, workload: r.workload, ok: r.ok,
        ...(r.skipped ? { skipped: true } : {}), ...(r.error ? { error: clip(r.error) } : {}),
        ...(r.metrics ? { metrics: r.metrics } : {}), ...(r.test ? { test: r.test } : {}),
      }));
      return ok(rows.length ? { results: rows, total: page.total } : "No results match.", { results: rows, total: page.total });
    },
  },
  {
    name: "fleet_flaky",
    title: "Flaky UI tests",
    cli: "fleetr flaky",
    description: "UI tests whose verdict flips between runs of the same build on the same device: flaky, not broken.",
    inputSchema: { type: "object", properties: { device_id: { type: "string" }, app: { type: "string" } } },
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const page = await client.listFlaky({
        device: typeof args.device_id === "string" ? args.device_id : undefined,
        app: typeof args.app === "string" ? args.app : undefined,
      });
      return ok(page.items.length ? { flaky: page.items } : "Nothing is flaky in the recent UI test history.", { flaky: page.items });
    },
  },
  {
    name: "fleet_artifact",
    title: "Open an artifact",
    cli: "fleetr artifact SHA [--out FILE]",
    description:
      "Open an artifact by sha256: a screenshot, a visual diff, a JUnit report, a log. Images come back as images; " +
      "text comes back truncated to max_chars (default 20000).",
    inputSchema: {
      type: "object",
      required: ["sha256"],
      properties: { sha256: { type: "string" }, max_chars: { type: "number" } },
    },
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const sha = String(args.sha256 ?? "");
      if (!/^[a-f0-9]{64}$/.test(sha)) return failure("sha256 must be 64 lowercase hex characters");
      return readArtifact(client, sha, Math.max(500, Math.min(Number(args.max_chars ?? 20_000) || 20_000, 200_000)));
    },
  },
  {
    name: "fleet_findings",
    title: "What night QA found",
    cli: "fleetr findings [--app A] [--since 24h]",
    description:
      "Bugs night QA (the explore workload) found on real devices, newest sighting first. Each was replayed on a clean " +
      "install before it was filed: `replay` says how often it reproduced (\"flaky 1/2\" is weaker evidence). verdict " +
      "null is open; agent_mistake means the model misread the app and is NOT a bug. since=\"24h\" is last night. " +
      "fleet_finding with an id gives the steps, evidence and the replay flow.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The explore app key, e.g. greenfolio." },
        state: { type: "string", enum: ["open", "triaged", "all"], description: "Default all." },
        verdict: { type: "string", description: "Comma-separated: real, duplicate, not_a_bug, agent_mistake, fixed." },
        check: { type: "string", description: "crash, anr, frozen, blank, left_app, a11y, visual, goal, dead_control." },
        since: { type: "string", description: "ISO 8601, or a span back from now: 24h, 7d." },
        limit: { type: "number", description: "Default 30, at most 200." },
      },
    },
    outputSchema: FINDINGS_OUT,
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const s = (k: string) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined);
      const page = await client.listFindings({
        app: s("app"), state: s("state") as "open" | "triaged" | "all" | undefined, verdict: s("verdict"), check: s("check"), since: s("since"),
        per_page: Math.max(1, Math.min(Number(args.limit ?? 30) || 30, 200)),
      });
      const out = { findings: page.items.map((f) => findingItem(f as FindingRow)), total: page.total };
      return ok(out.findings.length ? out : "No findings match.", out);
    },
  },
  {
    name: "fleet_finding",
    title: "One finding, with its replay flow",
    cli: "fleetr finding ID [--flow FILE]",
    description:
      "One finding by id: what went wrong, the steps in words, links to the screenshot, contact sheet, trajectory and " +
      "log (open them with fleet_artifact), its verdict history, its regression test, and the Maestro (or tvloop) flow " +
      "that replays it -- inline when small, so you can reproduce the bug with fleet_run or locally.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", description: "The finding id." },
        include_flow: { type: "boolean", description: "Include the replay flow text when it is small. Default true." },
      },
    },
    outputSchema: FINDING_OUT,
    annotations: READ,
    needs: "read",
    async run({ client }, args) {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id < 1) return failure("id must be a finding id (a positive integer)");
      const f = await client.getFinding(String(id));
      const flow = f.replay_flow
        ? { kind: f.replay_flow.kind, sha256: f.replay_flow.sha256, ...(args.include_flow !== false && f.replay_flow.text !== null ? { text: f.replay_flow.text } : {}),
            ...(f.replay_flow.truncated ? { note: "too big to inline; fleet_artifact with this sha256 returns it" } : {}) }
        : null;
      const out = {
        ...findingItem(f as FindingRow),
        detail: clip(f.detail, 4000) ?? "",
        steps: f.steps,
        evidence: f.evidence.map((e) => ({ role: e.role, sha256: e.sha256, in_store: e.in_store })),
        replay_flow: flow,
        regression_test: f.regression
          ? { state: f.regression.state, asserts: f.regression.asserts, runs: f.regression.runs, last_outcome: f.regression.last_outcome ?? null, last_detail: f.regression.last_detail ?? null }
          : null,
        history: f.history,
        ...(f.verdict === "agent_mistake" ? { note: "agent_mistake: the model misread the app. Not a bug; do not fix the app for it." } : {}),
      };
      const result = ok(out, out);
      if (f.artifacts.shot) result.content.push({ type: "resource_link", uri: `fleet://artifact/${f.artifacts.shot}`, name: "screenshot", mimeType: "image/png" });
      return result;
    },
  },
  {
    name: "fleet_verdict",
    title: "Judge a finding",
    cli: "fleetr verdict ID VERDICT [--note TEXT]",
    description:
      "Record a verdict on a finding. real: a bug in the app (its replay flow is kept as a candidate regression test). " +
      "fixed: only after real, and only once a fix has MERGED -- the flow then runs in the app's nightly and reopens the " +
      "finding if the crash comes back. not_a_bug / agent_mistake: the check or the model was wrong (retires any test). " +
      "duplicate needs duplicate_of. Verdicts decide which checks night QA keeps running, so do not guess.",
    inputSchema: {
      type: "object",
      required: ["id", "verdict"],
      properties: {
        id: { type: "integer" },
        verdict: { type: "string", enum: [...VERDICT_WORDS] },
        note: { type: "string", description: "Why, for whoever reads it next. Name the fix's PR when marking fixed." },
        duplicate_of: { type: "integer", description: "With duplicate: the finding this one duplicates." },
      },
    },
    outputSchema: VERDICT_OUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    needs: "run",
    async run({ client }, args) {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id < 1) return failure("id must be a finding id (a positive integer)");
      const verdict = String(args.verdict ?? "").replace(/-/g, "_");
      if (!(VERDICT_WORDS as readonly string[]).includes(verdict)) return failure(`verdict must be one of ${VERDICT_WORDS.join(", ")}`);
      const r = await client.setFindingVerdict(String(id), {
        verdict: verdict as (typeof VERDICT_WORDS)[number],
        ...(typeof args.note === "string" && args.note ? { note: args.note } : {}),
        ...(args.duplicate_of !== undefined ? { duplicate_of: Number(args.duplicate_of) } : {}),
      });
      const out = { id, verdict: r.finding.verdict ?? null, change: r.change ?? null, regression: r.finding.regression?.state ?? null };
      return ok(out, out);
    },
  },
  {
    name: "fleet_whoami",
    title: "Who am I to the fleet",
    cli: "fleetr whoami",
    description: "Which collector this is, its version, whether auth is on, and who it thinks you are with which scopes.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    needs: "read",
    async run({ client, remote }) {
      const [me, health] = await Promise.all([client.whoami(), client.getHealth()]);
      const out = { ...me, version: health.version, collector: health.name, ...(remote ? {} : { url: client.baseUrl }) };
      return ok(out, out as Record<string, unknown>);
    },
  },
];

async function isDangerous(client: FleetClient, spec: { workload?: unknown }): Promise<boolean> {
  if (typeof spec.workload !== "string") return false;
  try {
    return (await client.getWorkload(spec.workload)).dangerous === true;
  } catch {
    return false; // an unknown workload is refused by the collector, with a better message
  }
}

export async function readArtifact(client: FleetClient, sha: string, maxChars: number): Promise<ToolResult> {
  const meta = await client.getArtifact(sha);
  const type = meta.media_type;
  const describe = { sha256: sha, name: meta.name, size: meta.size, media_type: type };
  if (!meta.in_store) return failure("the artifact is recorded but its bytes were collected", describe);
  if (isImage(type) && (meta.size ?? 0) <= 5 * 1024 * 1024) {
    const res = await client.getArtifactContent(sha, undefined, { timeoutMs: 60_000 });
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { content: [{ type: "image", data, mimeType: type! }, { type: "text", text: json(describe) }], structuredContent: describe };
  }
  if (isText(type)) {
    const res = await client.getArtifactContent(sha, undefined, { timeoutMs: 60_000 });
    const body = await res.text();
    const text = body.length > maxChars ? `${body.slice(0, maxChars)}\n... (${body.length - maxChars} more characters)` : body;
    return { content: [{ type: "text", text }], structuredContent: describe };
  }
  return ok({ ...describe, note: "binary; not shown" }, describe);
}
