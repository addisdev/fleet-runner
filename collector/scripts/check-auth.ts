// FLEET_AUTH=tokens, end to end, against a collector of its own.
//
// Auth is the part of the control API where a quiet regression is worst: a
// route that forgets its scope check still passes every functional test. So
// this drives every rule from outside, through HTTP, the way an attacker or a
// confused script would: no token, the wrong scope, someone else's job, a
// claimed identity, a revoked token, a cookie trying to mutate.
//
// Usage: tsx scripts/check-auth.ts   (starts and stops its own collector)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const dir = await mkdtemp(path.join(tmpdir(), "fleet-auth-"));
const TOKENS = path.join(dir, "tokens.json");

// Imported after the tokens file is decided, so config reads the same path.
process.env.FLEET_TOKENS_FILE = TOKENS;
process.env.FLEET_DATA_DIR = path.join(dir, "data");
const { createToken, revokeToken } = await import("../src/auth.js");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const port = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const a = srv.address();
    if (!a || typeof a === "string") return reject(new Error("no port"));
    srv.close(() => resolve(a.port));
  });
});
const BASE = `http://127.0.0.1:${port}`;

const tok = (name: string, scopes: string[]) => createToken({ name, scopes }, TOKENS).token;
const READ = tok("reader", ["read"]);
const ALICE = tok("alice", ["run"]);
const BOB = tok("bob", ["run"]);
const ADMIN = tok("ops", ["admin"]);
const AGENT = tok("shelf-runner", ["agent"]);
const GATEWAY = tok("mcp-gateway", ["run", "delegate"]);
const DOOMED = tok("doomed", ["read"]);

type Opts = { token?: string; body?: unknown; headers?: Record<string, string> };
async function call(method: string, url: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

let server: ChildProcess | undefined;
let log = "";
try {
  server = spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_BIND: "127.0.0.1",
      FLEET_DATA_DIR: path.join(dir, "data"),
      FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, "collector.log"),
      FLEET_AUTH: "tokens",
      FLEET_AUTH_PROTOCOL: "token",
      FLEET_TOKENS_FILE: TOKENS,
      FLEET_SWEEP_MS: "60000",
      FLEET_SCHEDULER_TICK_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => { log += d; });
  server.stderr?.on("data", (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`collector exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${BASE}/api/v1/health`)).ok) break;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error("collector did not come up");
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("public");
  {
    const h = await call("GET", "/api/v1/health");
    check("health is public and says auth is on", h.status === 200 && h.body.auth === "tokens" && h.body.auth_protocol === "token");
    const w = await call("GET", "/api/v1/whoami");
    check("whoami without a token: no scopes", w.status === 200 && w.body.scopes.length === 0 && w.body.actor === null);
    check("the openapi document is public", (await call("GET", "/api/v1/openapi.json")).status === 200);
  }

  console.log("no token");
  {
    const v1 = await call("GET", "/api/v1/devices");
    check("v1 read without a token is 401", v1.status === 401 && v1.body.error.code === "unauthorized");
    check("with a WWW-Authenticate challenge", (v1.headers.get("www-authenticate") ?? "").startsWith("Bearer"));
    const legacy = await call("GET", "/api/devices");
    check("legacy read without a token is 401 with a string error", legacy.status === 401 && typeof legacy.body.error === "string");
    const bogus = await call("GET", "/api/v1/devices", { token: "fr_not-a-real-token" });
    check("an unknown token is 401", bogus.status === 401);
    check("/metrics needs read", (await call("GET", "/metrics")).status === 401);
  }

  console.log("runner protocol (FLEET_AUTH_PROTOCOL=token)");
  const device = { device_id: "auth-dev", descriptor: { model: "Auth Phone", os: "Android 15" }, pools: ["auth"], capabilities: ["benchmark", "shell"] };
  {
    check("register without a token is 401", (await call("POST", "/devices/register", { body: device })).status === 401);
    const wrong = await call("POST", "/devices/register", { body: device, token: ALICE });
    check("register with a run token is 403", wrong.status === 403);
    check("register with an agent token works", (await call("POST", "/devices/register", { body: device, token: AGENT })).status === 200);
    const art = await call("GET", `/artifacts/${"0".repeat(64)}`, { token: READ });
    check("a read token may fetch artifact bytes", art.status === 404, String(art.status));
  }

  console.log("scopes");
  const spec = { workload: "benchmark", executor: "device", backend: "synthetic", targets: { device_id: "auth-dev" } };
  {
    check("read token can list devices", (await call("GET", "/api/v1/devices", { token: READ })).status === 200);
    const denied = await call("POST", "/api/v1/jobs", { token: READ, body: spec });
    check("read token cannot create a job: 403 insufficient_scope run", denied.status === 403 && denied.body.error.code === "insufficient_scope" && denied.body.error.required_scope === "run", JSON.stringify(denied.body));
    check("read token cannot use the legacy enqueue either", (await call("POST", "/jobs", { token: READ, body: { ...spec, schema: 1, job_id: "legacy-denied" } })).status === 403);
    check("audit needs admin", (await call("GET", "/api/v1/audit", { token: ALICE })).status === 403);
    check("admin can read the audit log", (await call("GET", "/api/v1/audit", { token: ADMIN })).status === 200);
    const w = await call("GET", "/api/v1/whoami", { token: ADMIN });
    check("admin implies run, read and agent", ["admin", "agent", "read", "run"].every((s) => w.body.scopes.includes(s)), JSON.stringify(w.body.scopes));
  }

  console.log("provenance and ownership");
  let alicesJob = "";
  {
    const spoof = await call("POST", "/api/v1/jobs", { token: ALICE, body: spec, headers: { "x-fleet-actor": "the-ceo", "x-fleet-source": "cli" } });
    alicesJob = spoof.body.job_id;
    const s = await call("GET", `/api/v1/jobs/${alicesJob}/summary`, { token: READ });
    check("requested_by is the token's name, not a claimed header", s.body.requested_by === "alice", s.body.requested_by);
    check("source is recorded", s.body.source === "cli");

    const shell = await call("POST", "/api/v1/jobs", { token: ALICE, body: { workload: "shell", executor: "device", params: { script: "x" } } });
    check("the shell workload is refused to a run token", shell.status === 403 && shell.body.error.code === "forbidden", JSON.stringify(shell.body));

    const theft = await call("POST", `/api/v1/jobs/${alicesJob}/cancel`, { token: BOB });
    check("bob cannot cancel alice's job", theft.status === 403 && theft.body.error.code === "forbidden");
    check("bob cannot retry it either", (await call("POST", `/api/v1/jobs/${alicesJob}/retry`, { token: BOB, body: {} })).status === 403);
    const own = await call("POST", `/api/v1/jobs/${alicesJob}/cancel`, { token: ALICE });
    check("alice can cancel her own job", own.status === 200, JSON.stringify(own.body));

    const another = await call("POST", "/api/v1/jobs", { token: ALICE, body: spec });
    check("admin can cancel anyone's job", (await call("POST", `/api/v1/jobs/${another.body.job_id}/cancel`, { token: ADMIN })).status === 200);

    // A legacy route that forwards internally must keep working under auth.
    const retry = await call("POST", `/api/jobs/${alicesJob}/retry`, { token: ALICE, body: {} });
    check("legacy retry (which forwards internally) works with a run token", retry.status === 201, JSON.stringify(retry.body));
    const r = await call("GET", `/api/v1/jobs/${retry.body.job_id}/summary`, { token: READ });
    check("and the forwarded enqueue keeps the caller's name", r.body.requested_by === "alice", r.body.requested_by);
  }

  console.log("delegation");
  {
    const w = await call("GET", "/api/v1/whoami", { token: GATEWAY, headers: { "x-fleet-actor": "carol@wbd.com" } });
    check("a delegate token may name the person it acts for", w.body.actor === "carol@wbd.com" && w.body.verified === true, JSON.stringify(w.body));
    const j = await call("POST", "/api/v1/jobs", { token: GATEWAY, body: spec, headers: { "x-fleet-actor": "carol@wbd.com", "x-fleet-source": "mcp" } });
    const s = await call("GET", `/api/v1/jobs/${j.body.job_id}/summary`, { token: READ });
    check("the job is carol's", s.body.requested_by === "carol@wbd.com" && s.body.source === "mcp", JSON.stringify([s.body.requested_by, s.body.source]));
    const other = await call("POST", `/api/v1/jobs/${j.body.job_id}/cancel`, { token: GATEWAY, headers: { "x-fleet-actor": "dave@wbd.com" } });
    check("dave, through the same gateway, cannot cancel carol's job", other.status === 403);
    const audit = await call("GET", "/api/v1/audit?actor=carol%40wbd.com", { token: ADMIN });
    check("the audit log names carol, via mcp", audit.body.items.some((e: any) => e.source === "mcp" && e.verified === true), JSON.stringify(audit.body.items[0]));
  }

  console.log("revocation");
  {
    check("a token works before revocation", (await call("GET", "/api/v1/devices", { token: DOOMED })).status === 200);
    revokeToken("doomed", TOKENS);
    await new Promise((r) => setTimeout(r, 1_200)); // the file is re-read at most once a second
    check("and not after", (await call("GET", "/api/v1/devices", { token: DOOMED })).status === 401);
  }

  console.log("session cookie");
  {
    const s = await call("POST", "/api/session", { token: ALICE });
    const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0];
    check("a token can be exchanged for an HttpOnly SameSite=Strict cookie", s.status === 200 && /HttpOnly/.test(s.headers.get("set-cookie") ?? "") && /SameSite=Strict/.test(s.headers.get("set-cookie") ?? ""));
    check("the cookie reads", (await call("GET", "/api/v1/devices", { headers: { cookie } })).status === 200);
    const csrf = await call("POST", "/api/v1/jobs", { headers: { cookie }, body: spec });
    check("the cookie cannot mutate (no CSRF)", csrf.status === 401, String(csrf.status));
  }

  console.log("dashboard");
  {
    const health = await call("GET", "/api/health");
    check("/api/health tells the dashboard every read needs a token", health.status === 200 && health.body.auth === "tokens" && health.body.guard === true);
    check("the dashboard's reads carry X-Fleet-Token", (await call("GET", "/api/devices", { headers: { "x-fleet-token": READ } })).status === 200);
    check("and fail without it", (await call("GET", "/api/devices")).status === 401);
  }
} catch (e) {
  failures++;
  console.error(`  FAIL  ${(e as Error).message}`);
} finally {
  if (failures) console.error(`\n--- collector output ---\n${log.slice(-4000)}`);
  const child = server;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
