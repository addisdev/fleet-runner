/**
 * MCP over JSON-RPC: the methods, independent of how the bytes arrive.
 *
 * Hand-written rather than the SDK. The server side of MCP is a handful of
 * methods -- initialize, tools, resources, ping -- and `fleet` bundles to one
 * file a person can read; the SDK would be most of its weight for that. The
 * SDK's *client* is used in the tests, which is where interoperability is
 * actually proven.
 */
import { VERSION } from "../version.js";
import { readArtifact, refusal, TOOLS, type Tool, type ToolContext, type ToolResult } from "./tools.js";

/** Newest first. A client asking for one of these gets it back; anything else gets the newest. */
export const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
export type Reply = Record<string, unknown>;

export type Session = {
  ctx: ToolContext;
  /** Whether this caller may see and call a tool. Everything, locally. */
  allowed: (tool: Tool) => boolean;
  /** Called before each tool call; a string is a refusal (rate limit). */
  admit?: (tool: Tool, args: Record<string, unknown>) => string | null;
  /** Shown in `instructions`; the collector URL locally, nothing remotely. */
  where: string | null;
};

const INSTRUCTIONS = (where: string | null) =>
  "Fleet Runner is a lab of real devices -- phones, tablets, TVs, watches and Macs -- that run apps' UI flows, " +
  "installs, benchmarks and web checks on hardware. Use it when a simulator or emulator is not enough.\n\n" +
  "The usual order: fleet_devices (what is online) -> fleet_workloads name=<workload> (a valid example spec) -> " +
  "fleet_validate (fix what it says) -> fleet_run (waits for the verdict) -> fleet_artifact (screenshots, logs).\n" +
  "A verdict of skipped means nothing ran; never report it as a pass. Do not retry a failed job more than once " +
  "without reading its error. Prefer targets.pool or targets.match over pinning a device_id another person may be using." +
  (where ? `\n\nCollector: ${where}` : "");

/** One message in, zero or one out. */
export async function handle(session: Session, msg: Request): Promise<Reply | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string, data?: unknown) =>
    ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  const isNotification = msg.id === undefined || msg.id === null;
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(-32600, "invalid request");

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "fleet", title: "Fleet Runner device lab", version: VERSION },
        instructions: INSTRUCTIONS(session.where),
      });
    }
    case "ping":
      return reply({});

    case "tools/list":
      return reply({
        tools: TOOLS.filter(session.allowed).map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name, title, description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations: { title, ...annotations },
        })),
      });

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      if (!session.allowed(tool))
        return reply(errorResult(`${name}: your access does not include this tool (it needs the ${tool.needs} scope)`));
      const refused = session.admit?.(tool, args);
      if (refused) return reply(errorResult(refused));
      try {
        return reply(await tool.run(session.ctx, args));
      } catch (e) {
        // A tool that failed is a result the agent can read and act on, not a
        // protocol error that ends the conversation.
        return reply(refusal(name, e, session.ctx.remote));
      }
    }

    case "resources/list":
      return reply({
        resources: [
          { uri: "fleet://workloads", name: "workloads", title: "What the lab can run", mimeType: "application/json" },
          { uri: "fleet://devices", name: "devices", title: "Devices online now", mimeType: "application/json" },
        ],
      });

    case "resources/templates/list":
      return reply({
        resourceTemplates: [
          { uriTemplate: "fleet://job/{job_id}", name: "job", title: "A job's verdict", mimeType: "application/json" },
          { uriTemplate: "fleet://artifact/{sha256}", name: "artifact", title: "An artifact's bytes" },
          { uriTemplate: "fleet://workload/{name}", name: "workload", title: "A workload, with an example spec", mimeType: "application/json" },
        ],
      });

    case "resources/read": {
      const uri = String(msg.params?.uri ?? "");
      try {
        const contents = await readResource(session, uri);
        return contents ? reply({ contents }) : fail(-32002, `resource not found: ${uri}`);
      } catch (e) {
        const r = refusal("resources/read", e, session.ctx.remote);
        return fail(-32603, (r.content[0] as { text: string }).text);
      }
    }

    default:
      if (isNotification) return null; // notifications/initialized, cancelled, and friends
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

async function readResource(session: Session, uri: string) {
  const { client, remote } = session.ctx;
  const read = TOOLS.find((t) => t.needs === "read")!;
  if (!session.allowed(read)) return null;
  const asJson = (value: unknown) => [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }];
  if (uri === "fleet://workloads") return asJson((await client.listWorkloads()).items.filter((w) => !(remote && w.dangerous)));
  if (uri === "fleet://devices") return asJson((await client.listDevices({ status: "online", per_page: 500 })).items);
  let m = /^fleet:\/\/job\/(.+)$/.exec(uri);
  if (m) return asJson(await client.getJobSummary(decodeURIComponent(m[1])));
  m = /^fleet:\/\/workload\/(.+)$/.exec(uri);
  if (m) return asJson(await client.getWorkload(decodeURIComponent(m[1])));
  m = /^fleet:\/\/artifact\/([a-f0-9]{64})$/.exec(uri);
  if (m) {
    const out = await readArtifact(client, m[1], 200_000);
    const first = out.content[0];
    if (first.type === "image") return [{ uri, mimeType: first.mimeType, blob: first.data }];
    if (first.type === "text") return [{ uri, mimeType: (out.structuredContent?.media_type as string) ?? "text/plain", text: first.text }];
  }
  return null;
}
