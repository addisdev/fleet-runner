/**
 * `fleet mcp` over stdio, against a real collector.
 *
 * Two layers: the protocol handler called directly (fast, every tool), and the
 * real binary driven by the official MCP SDK client over stdio -- which is the
 * proof that a client we did not write can talk to the server we did.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveBrain, resolveToken } from "../src/connect.js";
import { handle, type Session } from "../src/mcp/protocol.js";
import { localSession } from "../src/mcp/stdio.js";
import { TOOLS } from "../src/mcp/tools.js";
import { fakeDevice, FLEET, PNG, startCollector, TSX, upload, type Collector } from "./helpers.js";

let c: Collector;
let session: Session;
let device: Awaited<ReturnType<typeof fakeDevice>>;

before(async () => {
  c = await startCollector();
  session = localSession({ url: c.base });
  device = await fakeDevice(c.base, "mcp-phone");
});
after(async () => {
  await device?.stop();
  await c?.stop();
});

type CallResult = { content: { type: string; text?: string; data?: string; mimeType?: string; uri?: string }[]; structuredContent?: any; isError?: boolean };
const rpc = (method: string, params?: Record<string, unknown>) => handle(session, { jsonrpc: "2.0", id: 1, method, params }) as Promise<any>;
const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as CallResult;
const body = (r: CallResult) => JSON.parse(r.content[0].text ?? "null");

test("initialize negotiates the protocol and says how to use the tools", async () => {
  const old = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(old.result.protocolVersion, "2025-03-26");
  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, "2025-06-18", "an unknown version gets the newest");
  assert.ok(unknown.result.capabilities.tools && unknown.result.capabilities.resources);
  assert.match(unknown.result.instructions, /fleet_validate/);
  assert.match(unknown.result.instructions, /skipped means nothing ran/);
});

test("tools/list: every tool has a title, a schema and annotations; reads are marked read-only", async () => {
  const { result } = await rpc("tools/list");
  const names = result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, TOOLS.map((t) => t.name).sort());
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
  }
  const by = Object.fromEntries(result.tools.map((t: { name: string }) => [t.name, t]));
  assert.equal(by.fleet_devices.annotations.readOnlyHint, true);
  assert.equal(by.fleet_cancel.annotations.destructiveHint, true);
  assert.equal(by.fleet_run.annotations.readOnlyHint, false);
});

test("a notification gets no reply; an unknown method is method-not-found; an unknown tool is invalid params", async () => {
  assert.equal(await handle(session, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await rpc("sampling/createMessage")).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "fleet_teleport" })).error.code, -32602);
});

test("fleet_devices lists the device with structured content", async () => {
  const r = await call("fleet_devices");
  assert.ok(!r.isError, r.content[0].text);
  assert.ok(r.structuredContent.devices.some((d: { device_id: string }) => d.device_id === "mcp-phone"));
  const none = await call("fleet_devices", { platform: "roku" });
  assert.match(none.content[0].text ?? "", /No devices are online/);
});

test("fleet_workloads lists names, and one name returns a usable example", async () => {
  const list = body(await call("fleet_workloads"));
  assert.ok(list.workloads.some((w: { name: string }) => w.name === "benchmark"));
  const one = body(await call("fleet_workloads", { name: "benchmark" }));
  assert.equal(one.example.workload, "benchmark");
});

test("fleet_validate names each problem; fleet_run refuses with a next step", async () => {
  const v = body(await call("fleet_validate", { spec: { workload: "benchmark", executor: "device", target: { pool: "x" } } }));
  assert.equal(v.valid, false);
  assert.ok(JSON.stringify(v.schema_errors).includes("target"));
  const r = await call("fleet_run", { spec: { workload: "benchmark" } });
  assert.equal(r.isError, true);
  const why = body(r);
  assert.equal(why.code, "invalid_spec");
  assert.match(why.next, /fleet_workloads/);
});

test("fleet_run waits for the device and returns the verdict, with requested_by from source mcp", async () => {
  const r = await call("fleet_run", { spec: { workload: "benchmark", executor: "device", backend: "synthetic", targets: { device_id: "mcp-phone" } }, timeout_s: 30 });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(r.structuredContent.verdict, "passed");
  assert.equal(r.structuredContent.finished, true);
  assert.equal(r.structuredContent.devices[0].metrics.decode_tps, 10);
  const summary = await session.ctx.client.getJobSummary(r.structuredContent.job_id);
  assert.equal(summary.source, "mcp");

  const job = await call("fleet_job", { job_id: r.structuredContent.job_id });
  assert.equal(job.structuredContent.verdict, "passed");
  const results = body(await call("fleet_results", { job_id: r.structuredContent.job_id }));
  assert.equal(results.results[0].device_id, "mcp-phone");
});

test("fleet_run wait=false queues; fleet_cancel stops it", async () => {
  const queued = body(await call("fleet_run", { spec: { workload: "benchmark", executor: "device", targets: { device_id: "nobody-home" } }, wait: false }));
  assert.match(queued.next, /fleet_job/);
  const cancelled = body(await call("fleet_cancel", { job_id: queued.job_id, reason: "test" }));
  assert.deepEqual(cancelled.cancelled, [queued.job_id]);
});

test("fleet_artifact returns an image as an image and text as text", async () => {
  const png = await upload(c.base, PNG, "shot.png");
  const img = await call("fleet_artifact", { sha256: png });
  assert.equal(img.content[0].type, "image");
  assert.equal(img.content[0].mimeType, "image/png");
  const xml = await upload(c.base, "<testsuites><testsuite name='a'/></testsuites>\n", "junit.xml");
  const txt = await call("fleet_artifact", { sha256: xml });
  assert.match(txt.content[0].text ?? "", /testsuites/);
  assert.equal((await call("fleet_artifact", { sha256: "nope" })).isError, true);
});

test("resources: templates are listed and a job reads as JSON", async () => {
  const t = await rpc("resources/templates/list");
  assert.ok(t.result.resourceTemplates.some((r: { uriTemplate: string }) => r.uriTemplate === "fleet://job/{job_id}"));
  const run = await call("fleet_run", { spec: { workload: "benchmark", executor: "device", targets: { device_id: "mcp-phone" } }, timeout_s: 30 });
  const read = await rpc("resources/read", { uri: `fleet://job/${run.structuredContent.job_id}` });
  assert.equal(JSON.parse(read.result.contents[0].text).verdict, "passed");
  assert.equal((await rpc("resources/read", { uri: "fleet://nothing" })).error.code, -32002);
});

test("an unreachable collector is a tool error the agent can read, not a protocol error", async () => {
  const dead = localSession({ url: "http://127.0.0.1:9" });
  const out = (await handle(dead, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fleet_devices", arguments: {} } })) as any;
  assert.equal(out.error, undefined);
  assert.equal(out.result.isError, true);
  assert.equal(JSON.parse(out.result.content[0].text).code, "unreachable");
});

test("the collector comes from the flag, then FLEET_URL, then the config", () => {
  assert.equal(resolveBrain("http://a:1/", {}), "http://a:1");
  assert.equal(resolveBrain(undefined, { FLEET_URL: "http://b:2,http://c:3" }), "http://b:2");
  assert.equal(resolveBrain(undefined, { FLEET_RUNNER_URL: "http://d:4", FLEET_URL: "http://localhost:7878" }), "http://d:4", "FLEET_RUNNER_URL wins over a FLEET_URL set for another tool");
  assert.equal(resolveToken("http://d:4", undefined, { FLEET_RUNNER_TOKEN: "mine", FLEET_TOKEN: "theirs", FLEET_HOME: "/nonexistent-fleet-home" }), "mine");
  assert.match(resolveBrain(undefined, { FLEET_HOME: "/nonexistent-fleet-home" }), /^http:\/\/127\.0\.0\.1:8788$/);
});

test("interop: the MCP SDK client drives `fleet mcp` over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, path.join(FLEET, "src/cli.ts"), "mcp", "--url", c.base],
    env: { ...process.env, FLEET_HOME: path.join(c.dir, "home"), FLEET_TOKEN: "", FLEET_RUNNER_URL: "", FLEET_RUNNER_TOKEN: "" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "fleet-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "fleet_run"));
    const me = await client.callTool({ name: "fleet_whoami", arguments: {} });
    assert.equal((me.structuredContent as { auth: string }).auth, "off");
    const job = await client.callTool({ name: "fleet_run", arguments: { spec: { workload: "benchmark", executor: "device", targets: { device_id: "mcp-phone" } }, timeout_s: 30 } });
    assert.equal((job.structuredContent as { verdict: string }).verdict, "passed");
  } finally {
    await client.close();
  }
});
