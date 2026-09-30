/**
 * `fleet mcp`, against a stub brain.
 *
 * The server is a thin layer over the collector's HTTP API, so what matters is
 * the layer: the protocol a client sees, what each tool asks the brain, and what
 * it hands back. A real collector would test the collector again; a stub makes
 * every answer deterministic, including the brain being unreachable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handle, resolveBrain, TOOLS } from "../src/mcp.js";

// A 1x1 PNG, so fleet_artifact has real image bytes to recognise.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

type Stub = { base: string; server: Server; jobs: Map<string, { status: string; polls: number }>; posted: unknown[] };

async function stubBrain(): Promise<Stub> {
  const jobs = new Map<string, { status: string; polls: number }>();
  const posted: unknown[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/api/devices") {
      return send(200, [
        { device_id: "s9", name: "Galaxy S9", status: "online", platform: "android",
          descriptor: { model: "SM-G960U1", os: "android-10", kind: "device", attached_to: "mac-dev" }, pools: [], capabilities: null },
        { device_id: "s8", name: "Galaxy S8+", status: "offline", platform: "android",
          descriptor: { model: "SM-G955U1", os: "android-9" }, pools: [] },
        { device_id: "atv", name: "Living Room", status: "online", platform: "tvos", descriptor: { model: "Apple TV 4K" }, pools: [] },
      ]);
    }
    if (req.method === "POST" && url.pathname === "/jobs") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const spec = JSON.parse(body);
        posted.push(spec);
        jobs.set(spec.job_id, { status: "queued", polls: 0 });
        send(201, { ok: true, job_id: spec.job_id, status: "queued" });
      });
      return;
    }
    const m = /^\/api\/jobs\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const j = jobs.get(decodeURIComponent(m[1]));
      if (!j) return send(404, { error: "unknown job" });
      // Finishes on the second look, so the wait loop really loops.
      j.polls += 1;
      if (j.polls >= 2) j.status = "done";
      return send(200, { job: { job_id: decodeURIComponent(m[1]), status: j.status, workload: "ui-test", claimed_by: "mac-dev" } });
    }
    if (req.method === "GET" && url.pathname === "/api/results") {
      return send(200, {
        results: [
          { job_id: url.searchParams.get("job") ?? "x", device_id: "s9", iter: 0, final: false, ok: false,
            payload: { error: "Assertion is false: \"Leaderboard\" is visible" }, test: { passed: 0, failed: 1, artifacts: ["a".repeat(64)] } },
          { job_id: url.searchParams.get("job") ?? "x", device_id: "host:mac-dev", iter: 0, final: true, ok: false },
        ],
      });
    }
    if (req.method === "GET" && url.pathname === `/artifacts/${"a".repeat(64)}`) return send(200, PNG, "application/octet-stream");
    if (req.method === "GET" && url.pathname === `/artifacts/${"b".repeat(64)}`) return send(200, "<testsuites/>\n", "application/octet-stream");
    send(404, { error: "no route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, jobs, posted };
}

const call = (base: string, name: string, args: Record<string, unknown> = {}) =>
  handle(base, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("initialize names the server, echoes the client's protocol, and offers tools", async () => {
  const out = (await handle("http://x", {
    jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" },
  })) as { result: { protocolVersion: string; capabilities: { tools?: object }; serverInfo: { name: string } } };
  assert.equal(out.result.protocolVersion, "2025-03-26");
  assert.ok(out.result.capabilities.tools);
  assert.equal(out.result.serverInfo.name, "fleet");
});

test("a notification gets no reply; an unknown request gets method-not-found", async () => {
  assert.equal(await handle("http://x", { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const out = (await handle("http://x", { jsonrpc: "2.0", id: 9, method: "resources/list" })) as { error: { code: number } };
  assert.equal(out.error.code, -32601);
});

test("tools/list offers the five tools, each with an input schema", async () => {
  const out = (await handle("http://x", { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
    result: { tools: { name: string; inputSchema: { type: string } }[] };
  };
  assert.deepEqual(out.result.tools.map((t) => t.name).sort(),
    ["fleet_artifact", "fleet_devices", "fleet_job", "fleet_results", "fleet_run"]);
  for (const t of out.result.tools) assert.equal(t.inputSchema.type, "object", t.name);
  assert.equal(TOOLS.length, 5);
});

test("fleet_devices lists what is online, reduced to what an agent chooses by", async () => {
  const s = await stubBrain();
  try {
    const out = (await call(s.base, "fleet_devices")) as { result: { content: { text: string }[] } };
    const devices = JSON.parse(out.result.content[0].text) as { device_id: string; model: string; attached_to: string }[];
    assert.deepEqual(devices.map((d) => d.device_id).sort(), ["atv", "s9"], "the offline S8+ is left out");
    assert.equal(devices.find((d) => d.device_id === "s9")?.attached_to, "mac-dev");

    const android = (await call(s.base, "fleet_devices", { platform: "android", include_offline: true })) as {
      result: { content: { text: string }[] };
    };
    assert.deepEqual(JSON.parse(android.result.content[0].text).map((d: { device_id: string }) => d.device_id).sort(), ["s8", "s9"]);
  } finally {
    s.server.close();
  }
});

test("fleet_run fills in the id and schema, waits for the verdict, and returns the failing step", async () => {
  const s = await stubBrain();
  try {
    const out = (await call(s.base, "fleet_run", {
      spec: { workload: "ui-test", executor: "host", suite: { kind: "maestro", flows: "greenfolio/smoke.yaml" } },
      timeout_s: 30,
    })) as { result: { content: { text: string }[]; isError?: boolean } };
    const posted = s.posted[0] as { schema: number; job_id: string };
    assert.equal(posted.schema, 1);
    assert.match(posted.job_id, /^mcp-ui-test-/);
    const report = JSON.parse(out.result.content[0].text) as { jobs: { status: string; results: { error?: string }[] }[] };
    assert.equal(report.jobs[0].status, "done", "it waited until the job finished");
    assert.ok(report.jobs[0].results.some((r) => r.error?.includes("Leaderboard")), "and the agent can read why it failed");
  } finally {
    s.server.close();
  }
});

test("fleet_run with wait=false queues and returns the id to follow", async () => {
  const s = await stubBrain();
  try {
    const out = (await call(s.base, "fleet_run", { spec: { workload: "benchmark", job_id: "b1" }, wait: false })) as {
      result: { content: { text: string }[] };
    };
    assert.deepEqual(JSON.parse(out.result.content[0].text).queued, ["b1"]);
  } finally {
    s.server.close();
  }
});

test("fleet_artifact returns a screenshot as an image and a report as text", async () => {
  const s = await stubBrain();
  try {
    const img = (await call(s.base, "fleet_artifact", { sha256: "a".repeat(64) })) as {
      result: { content: { type: string; mimeType?: string; data?: string }[] };
    };
    assert.equal(img.result.content[0].type, "image");
    assert.equal(img.result.content[0].mimeType, "image/png");
    assert.equal(Buffer.from(img.result.content[0].data ?? "", "base64").length, PNG.length);

    const txt = (await call(s.base, "fleet_artifact", { sha256: "b".repeat(64) })) as { result: { content: { text: string }[] } };
    assert.match(txt.result.content[0].text, /testsuites/);

    const bad = (await call(s.base, "fleet_artifact", { sha256: "nope" })) as { result: { isError?: boolean } };
    assert.equal(bad.result.isError, true);
  } finally {
    s.server.close();
  }
});

test("an unreachable brain is a tool error the agent can read, not a protocol error", async () => {
  // A port nothing listens on: the tool fails, the conversation does not.
  const out = (await call("http://127.0.0.1:9", "fleet_devices")) as {
    result?: { isError?: boolean; content: { text: string }[] }; error?: unknown;
  };
  assert.equal(out.error, undefined);
  assert.equal(out.result?.isError, true);
  assert.match(out.result?.content[0].text ?? "", /fleet_devices failed/);
});

test("an unknown tool is refused as invalid params", async () => {
  const out = (await call("http://x", "fleet_teleport")) as { error: { code: number } };
  assert.equal(out.error.code, -32602);
});

test("the brain comes from the flag, then FLEET_URL, then the config", () => {
  assert.equal(resolveBrain("http://a:1/", {}), "http://a:1");
  assert.equal(resolveBrain(undefined, { FLEET_URL: "http://b:2" }), "http://b:2");
  // With FLEET_HOME pointed somewhere empty, the config's default brain answers.
  assert.match(resolveBrain(undefined, { FLEET_HOME: "/nonexistent-fleet-home" }), /^http:\/\/127\.0\.0\.1:8788$/);
});
