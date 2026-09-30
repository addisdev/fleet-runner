/**
 * `fleet mcp` -- the device lab, as tools a coding agent can call.
 *
 * Nobody opened the dashboard for a week while the fleet ran fifty jobs, and
 * that is not a dashboard problem. The work on these apps is done by coding
 * agents -- between 40% and 90% of recent commits are co-authored -- and an
 * agent does not open a dashboard. It calls a tool. So this is the fleet's
 * front door for them: an MCP server over stdio that turns "does this still
 * render on Android 10?" from a person with a cable into one tool call whose
 * answer, screenshots included, comes back into the session.
 *
 * **It adds no capability to the collector.** Every tool is a thin wrapper
 * over the brain's existing HTTP API -- the same endpoints the dashboard and
 * `fleet status` use -- so there is exactly one place a job is scheduled, one
 * place a device is locked, and nothing an agent can do that a person with
 * curl could not.
 *
 * **Hand-written, not the MCP SDK.** The protocol an MCP server over stdio
 * needs is four JSON-RPC methods and newline-delimited framing. The SDK would
 * be most of this package's dependency weight for that, and `fleet` bundles to
 * one file a person can read; this keeps both true.
 *
 * Everything goes to stdout as protocol and to stderr as log, never the other
 * way: a stray console.log on stdout is a malformed message to the client.
 */
import { createInterface } from "node:readline";
import { load, agentCollectors } from "./config.js";
import { VERSION } from "./version.js";

/** The JSON-RPC protocol revision this server answers with by default. */
const PROTOCOL = "2025-06-18";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

/** Which brain to talk to: a flag, then the environment, then the config. */
export function resolveBrain(flagUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flagUrl) return flagUrl.replace(/\/+$/, "");
  if (env.FLEET_URL) return env.FLEET_URL.replace(/\/+$/, "");
  const config = load(env);
  const url = config.executor.collector ?? agentCollectors(config)[0] ?? `http://127.0.0.1:${config.collector.port}`;
  return url.replace(/\/+$/, "");
}

// --- talking to the brain ---------------------------------------------------

async function api<T = unknown>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Device = {
  device_id: string; name: string | null; status: string; platform?: string;
  descriptor?: Record<string, unknown>; capabilities?: string[] | null;
  pools?: string[]; pools_override?: string[] | null; last_seen?: string;
};
type JobRow = { job_id: string; status: string; workload: string; claimed_by?: string | null; duration_s?: number | null };
type ResultRow = {
  job_id: string; device_id: string; iter: number; final?: boolean; ok?: boolean;
  metrics?: Record<string, unknown>; test?: { passed?: number; failed?: number; skipped?: number; artifacts?: string[] };
  payload?: { error?: string };
};

/** A device, reduced to what an agent needs to choose one. */
function deviceSummary(d: Device) {
  const ds = d.descriptor ?? {};
  return {
    device_id: d.device_id,
    name: d.name,
    status: d.status,
    platform: d.platform ?? ds.platform ?? null,
    kind: ds.kind ?? null,
    model: ds.model ?? null,
    os: ds.os ?? null,
    attached_to: ds.attached_to ?? null,
    attached_host: ds.attached_host ?? null,
    pools: d.pools ?? [],
    capabilities: d.capabilities ?? null,
  };
}

/** A result row, reduced: the verdict, why, the numbers, and where the evidence is. */
function resultSummary(r: ResultRow) {
  const error = r.payload?.error;
  return {
    device_id: r.device_id,
    iter: r.iter,
    final: r.final ?? false,
    ok: r.ok ?? null,
    ...(error ? { error: error.slice(0, 600) } : {}),
    ...(r.metrics && Object.keys(r.metrics).length ? { metrics: r.metrics } : {}),
    ...(r.test ? { test: r.test } : {}),
  };
}

async function jobReport(base: string, jobId: string) {
  const job = await api<{ job?: JobRow } & JobRow>(base, "GET", `/api/jobs/${encodeURIComponent(jobId)}`);
  const row = (job.job ?? job) as JobRow;
  const results = await api<{ results: ResultRow[] }>(base, "GET", `/api/results?job=${encodeURIComponent(jobId)}&per_page=100`);
  return {
    job_id: row.job_id,
    status: row.status,
    workload: row.workload,
    claimed_by: row.claimed_by ?? null,
    duration_s: row.duration_s ?? null,
    results: (results.results ?? []).map(resultSummary),
  };
}

const FINISHED = new Set(["done", "failed", "cancelled"]);

// --- the tools --------------------------------------------------------------

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, Json>;
  run: (base: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const TOOLS: Tool[] = [
  {
    name: "fleet_devices",
    description:
      "List the real devices in the device lab: phones, tablets, TVs, watches and machines, with what each " +
      "can run. Use it before fleet_run to choose targets. By default only devices that are online right now " +
      "are listed; a device plugged into a Mac appears within a minute.",
    inputSchema: {
      type: "object",
      properties: {
        include_offline: { type: "boolean", description: "Also list devices that are not online. Default false." },
        platform: { type: "string", description: "Only this platform: android, ios, tvos, macos, roku, web..." },
      },
    },
    async run(base, args) {
      const raw = await api<Device[] | { devices: Device[] }>(base, "GET", "/api/devices");
      const all = (Array.isArray(raw) ? raw : raw.devices).filter((d) => d && typeof d === "object");
      const wanted = all
        .filter((d) => args.include_offline === true || d.status === "online")
        .map(deviceSummary)
        .filter((d) => !args.platform || String(d.platform).toLowerCase() === String(args.platform).toLowerCase());
      if (wanted.length === 0) {
        return text(
          args.include_offline
            ? "No devices match."
            : "No devices are online right now. Plug one into a Mac running a fleet executor, or pass include_offline.",
        );
      }
      return text(wanted);
    },
  },
  {
    name: "fleet_run",
    description:
      "Run a job on real devices and (by default) wait for the verdict. `spec` is a Fleet Runner job spec. " +
      "Common shapes:\n" +
      '- UI flow on attached Android: {"workload":"ui-test","executor":"host","app":{"name":"<app>","sha256":"latest"},' +
      '"suite":{"kind":"maestro","flows":"<app>/smoke.yaml"},"targets":{"match":"os ~ \'android\'"}}\n' +
      '- Install a published build: {"workload":"install","executor":"host","app":{"name":"<app>","sha256":"latest"},' +
      '"targets":{"device_id":"<id>"}}\n' +
      '- Benchmark: {"workload":"benchmark","executor":"device","backend":"synthetic","targets":{"device_id":"<id>"}}\n' +
      "A result whose error starts with \"skipped:\" means nothing ran (no matching device, or the host was too " +
      "loaded) -- that is not a pass. Artifacts in results are sha256s; open them with fleet_artifact.",
    inputSchema: {
      type: "object",
      required: ["spec"],
      properties: {
        spec: { type: "object", description: "The job spec. job_id and schema are filled in if absent." },
        wait: { type: "boolean", description: "Wait for the job to finish. Default true." },
        timeout_s: { type: "number", description: "How long to wait. Default 900." },
      },
    },
    async run(base, args) {
      const spec = { ...(args.spec as Record<string, unknown>) };
      if (!spec.workload) return { ...text("spec.workload is required"), isError: true };
      spec.schema ??= 1;
      spec.job_id ??= `mcp-${String(spec.workload)}-${Date.now().toString(36)}`;
      const created = await api<{ job_id?: string; fanout?: string[]; status?: string }>(base, "POST", "/jobs", spec);
      const ids = created.fanout?.length ? created.fanout : [String(spec.job_id)];
      if (args.wait === false) return text({ queued: ids, next: "call fleet_job with each id" });

      const deadline = Date.now() + Number(args.timeout_s ?? 900) * 1000;
      const pending = new Set(ids);
      while (pending.size > 0 && Date.now() < deadline) {
        for (const id of [...pending]) {
          const j = await api<{ job?: JobRow } & JobRow>(base, "GET", `/api/jobs/${encodeURIComponent(id)}`);
          if (FINISHED.has(((j.job ?? j) as JobRow).status)) pending.delete(id);
        }
        if (pending.size > 0) await sleep(3_000);
      }
      const reports = await Promise.all(ids.map((id) => jobReport(base, id)));
      const stillRunning = reports.filter((r) => !FINISHED.has(r.status)).map((r) => r.job_id);
      return text({
        ...(stillRunning.length ? { note: `still running after the timeout: ${stillRunning.join(", ")}` } : {}),
        jobs: reports,
      });
    },
  },
  {
    name: "fleet_job",
    description: "The status and per-device results of one job, by id. Use it to follow a job started with wait=false.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
    async run(base, args) {
      return text(await jobReport(base, String(args.job_id)));
    },
  },
  {
    name: "fleet_artifact",
    description:
      "Open an artifact by sha256 -- a screenshot, a visual diff, a JUnit report, a build log. Images come back " +
      "as images; text comes back truncated to 20 KB.",
    inputSchema: { type: "object", required: ["sha256"], properties: { sha256: { type: "string" } } },
    async run(base, args) {
      const sha = String(args.sha256);
      if (!/^[a-f0-9]{64}$/.test(sha)) return { ...text("sha256 must be 64 hex characters"), isError: true };
      const res = await fetch(`${base}/artifacts/${sha}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return { ...text(`no artifact ${sha} (${res.status})`), isError: true };
      const bytes = Buffer.from(await res.arrayBuffer());
      const mime = sniffImage(bytes);
      if (mime) return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: mime }] };
      const looksText = bytes.subarray(0, 4096).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127));
      if (!looksText) return text(`binary artifact, ${bytes.length} bytes; not shown`);
      const body = bytes.toString("utf8");
      return text(body.length > 20_000 ? `${body.slice(0, 20_000)}\n... (${body.length - 20_000} more characters)` : body);
    },
  },
  {
    name: "fleet_results",
    description:
      "Recent results from the lab, newest first, filtered by device and/or workload. Use it to ask whether " +
      "something has been flaky on real hardware, or what a device measured last time.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string" },
        workload: { type: "string", description: "e.g. ui-test, benchmark, web-shots" },
        failures_only: { type: "boolean" },
        limit: { type: "number", description: "Default 20, at most 100." },
      },
    },
    async run(base, args) {
      const q = new URLSearchParams({ per_page: String(Math.min(Number(args.limit ?? 20), 100)), final: "true" });
      if (args.device_id) q.set("device", String(args.device_id));
      if (args.workload) q.set("workload", String(args.workload));
      if (args.failures_only === true) q.set("ok", "false");
      const res = await api<{ results: (ResultRow & { workload?: string; created_at?: string })[] }>(
        base, "GET", `/api/results?${q.toString()}`,
      );
      const rows = (res.results ?? []).map((r) => ({ at: r.created_at, job_id: r.job_id, workload: r.workload, ...resultSummary(r) }));
      return text(rows.length ? rows : "No results match.");
    },
  },
];

/** PNG and JPEG by their magic bytes; the store does not keep a media type. */
function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

// --- the protocol -----------------------------------------------------------

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

/** One JSON-RPC message in, zero or one out. Exported so it can be tested without stdio. */
export async function handle(base: string, msg: Request): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "fleet", version: VERSION },
        instructions:
          "Fleet Runner is a lab of real devices -- phones, tablets, TVs, watches and Macs -- that run your apps' " +
          "UI flows, installs and benchmarks on hardware. Use it when a simulator or emulator is not enough: " +
          "an old Android, a real iPhone, a TV. fleet_devices shows what is attached now; fleet_run runs a job " +
          `and returns the verdict; fleet_artifact opens screenshots and logs. Brain: ${base}`,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      try {
        return reply(await tool.run(base, (msg.params?.arguments as Record<string, unknown>) ?? {}));
      } catch (e) {
        // A tool that could not reach the brain is a tool result the agent can
        // read and act on, not a protocol error that ends the conversation.
        return reply({ ...text(`${name} failed: ${(e as Error).message}`), isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized and friends
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve over stdio until stdin closes. */
export async function serveMcp(flagUrl?: string): Promise<number> {
  const base = resolveBrain(flagUrl);
  process.stderr.write(`fleet mcp ${VERSION}: brain ${base}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Request;
    try {
      msg = JSON.parse(line) as Request;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      continue;
    }
    // Calls run concurrently: fleet_run waits up to fifteen minutes, and a
    // client that sends `ping` meanwhile must still get an answer.
    const p = handle(base, msg).then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  return 0;
}
