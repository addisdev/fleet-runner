/**
 * `fleet mcp --http`, the remote gateway, against a fake identity provider and
 * a real collector with FLEET_AUTH=tokens.
 *
 * The identity provider is an RSA key and a JWKS endpoint: enough to mint the
 * tokens Entra or Okta would, and to mint the ones they would not (wrong
 * audience, expired, HMAC-signed) to prove the gateway turns them away.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGateway, type GatewayOptions } from "../src/mcp/http.js";
import { fakeDevice, FLEET, startCollector, tempDir, TSX, type Collector } from "./helpers.js";

const AUDIENCE = "api://fleet-runner";
let issuer: string;
let idp: Server;
let key: KeyObject;
let c: Collector;
let admin: string;
let gatewayToken: string;
let gw: Awaited<ReturnType<typeof startGateway>>;
let device: Awaited<ReturnType<typeof fakeDevice>>;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: issuer, aud: AUDIENCE, iat: now, nbf: now, exp: now + 600, ...claims };
  const signing = `${b64(header)}.${b64(body)}`;
  const sig = header.alg === "HS256" ? createHmac("sha256", "secret").update(signing).digest() : sign("sha256", Buffer.from(signing), key);
  return `${signing}.${sig.toString("base64url")}`;
}

const alice = () => jwt({ preferred_username: "alice@example.com", scp: "fleet.read fleet.run" });
const reader = () => jwt({ preferred_username: "rita@example.com", scp: "fleet.read" });

function gatewayOptions(over: Partial<GatewayOptions> = {}): GatewayOptions {
  return {
    port: 0,
    host: "127.0.0.1",
    collectorUrl: c.base,
    collectorToken: gatewayToken,
    publicUrl: "https://fleet-mcp.example.com",
    oauth: { issuer, audience: AUDIENCE, scopes: { read: "fleet.read", run: "fleet.run" } },
    allowedOrigins: ["https://chat.example.com"],
    limits: { callsPerMinute: 1000, runsPerHour: 1000 },
    log: () => {},
    ...over,
  };
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const rpc = (base: string, token: string, method: string, params?: unknown, extra: Record<string, string> = {}) =>
  post(base, { jsonrpc: "2.0", id: 1, method, params }, { authorization: `Bearer ${token}`, ...extra });

before(async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  key = pair.privateKey;
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  idp = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys` }));
    if (req.url === "/keys") return res.end(JSON.stringify({ keys: [jwk] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  const dir = tempDir("fleet-gw-tokens-");
  const tokens = path.join(dir, "tokens.json");
  process.env.FLEET_DATA_DIR = path.join(dir, "data");
  const { createToken } = await import("../../collector/src/auth.js");
  admin = createToken({ name: "ops", scopes: ["admin"] }, tokens).token;
  gatewayToken = createToken({ name: "mcp-gateway", scopes: ["run", "delegate"] }, tokens).token;

  c = await startCollector({ FLEET_AUTH: "tokens", FLEET_TOKENS_FILE: tokens });
  device = await fakeDevice(c.base, "gw-phone");
  gw = await startGateway(gatewayOptions());
});

after(async () => {
  await gw?.close();
  await device?.stop();
  await c?.stop();
  await new Promise<void>((r) => (idp ? idp.close(() => r()) : r()));
});

test("RFC 9728 metadata names the resource and the issuer; no token is a 401 that points at it", async () => {
  const meta = await (await fetch(`${gw.url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, "https://fleet-mcp.example.com/mcp");
  assert.deepEqual(meta.authorization_servers, [issuer]);
  assert.deepEqual(meta.scopes_supported, ["fleet.read", "fleet.run"]);

  const none = await post(gw.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/fleet-mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("tokens the identity provider would not have issued for this app are refused", async () => {
  const cases: [string, string][] = [
    ["another app's audience", jwt({ preferred_username: "a@example.com", scp: "fleet.run", aud: "api://something-else" })],
    ["another issuer", jwt({ preferred_username: "a@example.com", scp: "fleet.run", iss: "https://evil.example.com" })],
    ["expired", jwt({ preferred_username: "a@example.com", scp: "fleet.run", exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["HMAC-signed", jwt({ preferred_username: "a@example.com", scp: "fleet.run" }, { alg: "HS256", kid: "k1" })],
    ["alg none", `${b64({ alg: "none", kid: "k1" })}.${b64({ iss: issuer, aud: AUDIENCE, exp: 9e9, sub: "x" })}.`],
    ["tampered", alice().replace(/\.[^.]+\./, `.${b64({ iss: issuer, aud: AUDIENCE, exp: 9e9, preferred_username: "mallory", scp: "fleet.run" })}.`)],
    ["not a JWT", "hello"],
  ];
  for (const [why, token] of cases) {
    const r = await rpc(gw.url, token, "tools/list");
    assert.equal(r.status, 401, why);
    assert.match(r.headers.get("www-authenticate") ?? "", /error="invalid_token"/, why);
  }
});

test("a valid token with no Fleet Runner scope is a 403 insufficient_scope", async () => {
  const r = await rpc(gw.url, jwt({ preferred_username: "nobody@example.com", scp: "User.Read" }), "tools/list");
  assert.equal(r.status, 403);
  assert.match(r.headers.get("www-authenticate") ?? "", /insufficient_scope/);
});

test("a read-only person does not see the run tools, and cannot call them by name", async () => {
  const list = await rpc(gw.url, reader(), "tools/list");
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("fleet_devices"));
  for (const n of ["fleet_run", "fleet_cancel", "fleet_retry"]) assert.ok(!names.includes(n), n);
  const call = await rpc(gw.url, reader(), "tools/call", { name: "fleet_run", arguments: { spec: { workload: "benchmark" } } });
  assert.equal(call.body.result.isError, true);
  assert.match(call.body.result.content[0].text, /run scope/);
});

test("interop: the SDK client runs a job through the gateway, recorded as the person", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${alice()}` } },
  });
  const client = new Client({ name: "fleet-gateway-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "fleet_run"));
    const r = await client.callTool({ name: "fleet_run", arguments: { spec: { workload: "benchmark", executor: "device", targets: { device_id: "gw-phone" } }, timeout_s: 30 } });
    assert.ok(!r.isError, JSON.stringify(r.content));
    const s = r.structuredContent as { verdict: string; job_id: string };
    assert.equal(s.verdict, "passed");

    const summary = await (await fetch(`${c.base}/api/v1/jobs/${s.job_id}/summary`, { headers: { authorization: `Bearer ${admin}` } })).json();
    assert.equal(summary.requested_by, "alice@example.com");
    assert.equal(summary.source, "mcp");
  } finally {
    await client.close();
  }
});

test("the shell workload is neither offered nor runnable remotely", async () => {
  const list = await rpc(gw.url, alice(), "tools/call", { name: "fleet_workloads", arguments: {} });
  const names = JSON.parse(list.body.result.content[0].text).workloads.map((w: { name: string }) => w.name);
  assert.ok(!names.includes("shell"));
  const run = await rpc(gw.url, alice(), "tools/call", { name: "fleet_run", arguments: { spec: { workload: "shell", executor: "device" }, wait: false } });
  assert.equal(run.body.result.isError, true);
  assert.match(run.body.result.content[0].text, /not available through the remote connector/);
});

test("the instructions do not reveal the collector's address", async () => {
  const init = await rpc(gw.url, alice(), "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.ok(!JSON.stringify(init.body).includes(c.base));
});

test("browser origins outside the allowlist are refused; an unknown protocol version is a 400", async () => {
  assert.equal((await rpc(gw.url, alice(), "tools/list", undefined, { origin: "https://evil.example.com" })).status, 403);
  assert.equal((await rpc(gw.url, alice(), "tools/list", undefined, { origin: "https://chat.example.com" })).status, 200);
  assert.equal((await rpc(gw.url, alice(), "tools/list", undefined, { "mcp-protocol-version": "1999-01-01" })).status, 400);
  assert.equal((await fetch(`${gw.url}/mcp`, { method: "GET" })).status, 405);
});

test("a notification is accepted with 202 and no body", async () => {
  const r = await post(gw.url, { jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: `Bearer ${alice()}` });
  assert.equal(r.status, 202);
});

test("rate limits are per person", async () => {
  const tight = await startGateway(gatewayOptions({ limits: { callsPerMinute: 2, runsPerHour: 1000 } }));
  try {
    const call = (token: string) => rpc(tight.url, token, "tools/call", { name: "fleet_whoami", arguments: {} });
    assert.ok(!(await call(alice())).body.result.isError);
    assert.ok(!(await call(alice())).body.result.isError);
    const third = await call(alice());
    assert.equal(third.body.result.isError, true);
    assert.match(third.body.result.content[0].text, /rate limited/);
    assert.ok(!(await call(reader())).body.result.isError, "someone else is not limited by alice");
  } finally {
    await tight.close();
  }
});

test("the CLI refuses --no-auth off loopback, and --issuer without --audience", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [TSX, path.join(FLEET, "src/cli.ts"), "mcp", "--http", "--url", c.base, ...args], {
      encoding: "utf8",
      env: { ...process.env, FLEET_HOME: tempDir("fleet-gw-home-"), FLEET_TOKEN: "", FLEET_RUNNER_URL: "", FLEET_RUNNER_TOKEN: "" },
      timeout: 30_000,
    });
  const open = cli("--no-auth", "--host", "0.0.0.0");
  assert.equal(open.status, 2, open.stderr);
  assert.match(open.stderr, /loopback/);
  const noAud = cli("--issuer", issuer);
  assert.equal(noAud.status, 2, noAud.stderr);
  assert.match(noAud.stderr, /--audience/);
});
