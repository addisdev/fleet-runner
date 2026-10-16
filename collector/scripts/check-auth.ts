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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const a = srv.address();
    if (!a || typeof a === "string") return reject(new Error("no port"));
    srv.close(() => resolve(a.port));
  });
});
const port = await freePort();

async function up(base: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`collector exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/v1/health`)).ok) return;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error("collector did not come up");
    await new Promise((r) => setTimeout(r, 300));
  }
}
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
let peer: ChildProcess | undefined;
let guarded: ChildProcess | undefined;
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
  await up(BASE, server);

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
    const verdictDenied = await call("POST", "/api/v1/findings/1/verdict", { token: READ, body: { verdict: "real" } });
    check("read token cannot judge a finding: 403 insufficient_scope run", verdictDenied.status === 403 && verdictDenied.body.error.required_scope === "run", JSON.stringify(verdictDenied.body));
    const verdictRun = await call("POST", "/api/v1/findings/999999/verdict", { token: ALICE, body: { verdict: "real" } });
    check("a run token may judge one (this one does not exist: 404)", verdictRun.status === 404, JSON.stringify(verdictRun.body));
    check("read token can list findings", (await call("GET", "/api/v1/findings", { token: READ })).status === 200);
    check("an agent token can pull regression flows", (await call("GET", "/findings/regressions?app=x", { token: AGENT })).status === 200);
    check("an agent token can report a regression run (none here: 404)",
      (await call("POST", "/findings/999999/regression", { token: AGENT, body: { job_id: "j", device_id: "d", outcome: "passed" } })).status === 404);
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

  console.log("the older routes make the same two checks");
  {
    const j = await call("POST", "/api/v1/jobs", { token: ALICE, body: spec });
    const id = j.body.job_id;
    const theft = await call("POST", `/api/jobs/${id}/cancel`, { token: BOB });
    check("bob cannot cancel alice's job through /api/jobs/:id/cancel", theft.status === 403 && typeof theft.body.error === "string", JSON.stringify(theft.body));
    check("nor retry it through /api/jobs/:id/retry", (await call("POST", `/api/jobs/${id}/retry`, { token: BOB, body: {} })).status === 403);
    const own = await call("POST", `/api/jobs/${id}/cancel`, { token: ALICE });
    check("alice can, through the same route", own.status === 200, JSON.stringify(own.body));
    const k = await call("POST", "/api/v1/jobs", { token: ALICE, body: spec });
    check("admin can cancel anyone's through it", (await call("POST", `/api/jobs/${k.body.job_id}/cancel`, { token: ADMIN })).status === 200);

    const shellSpec = { schema: 1, workload: "shell", executor: "device", params: { script: "x" }, targets: { device_id: "auth-dev" } };
    const viaJobs = await call("POST", "/jobs", { token: ALICE, body: { ...shellSpec, job_id: "legacy-shell-1" } });
    check("POST /jobs refuses shell to a run token", viaJobs.status === 403 && /admin/.test(viaJobs.body.error), JSON.stringify(viaJobs.body));
    const viaApi = await call("POST", "/api/jobs", { token: ALICE, body: { ...shellSpec, job_id: "legacy-shell-2" } });
    check("POST /api/jobs refuses it too (its forward is internal)", viaApi.status === 403, JSON.stringify(viaApi.body));
    const asAdmin = await call("POST", "/jobs", { token: ADMIN, body: { ...shellSpec, job_id: "legacy-shell-3" } });
    check("admin may queue shell through POST /jobs", asAdmin.status === 201, JSON.stringify(asAdmin.body));
    if (asAdmin.status === 201) await call("POST", "/api/v1/jobs/legacy-shell-3/cancel", { token: ADMIN });
  }

  console.log("ci-enqueue and ci-upload with tokens on");
  {
    // A device of its own, so nothing queued above is claimed instead.
    const CI_DEV = "auth-ci-dev";
    await call("POST", "/devices/register", { token: AGENT, body: { device_id: CI_DEV, descriptor: { model: "CI Phone", os: "Android 15" }, pools: ["auth-ci"], capabilities: ["benchmark"] } });
    const ciSpec = (id: string) => ({ schema: 1, job_id: id, workload: "benchmark", executor: "device", backend: "synthetic", targets: { device_id: CI_DEV } });
    const specFile = async (id: string, body: unknown = ciSpec(id)) => {
      const f = path.join(dir, `${id}.json`);
      await writeFile(f, JSON.stringify(body));
      return f;
    };
    const runScript = (script: string, args: string[], env: Record<string, string>) => {
      const child = spawn(process.execPath, [TSX, `scripts/${script}`, ...args], {
        cwd: ROOT,
        env: { ...process.env, FLEET_URL: BASE, FLEET_TOKEN: "", FLEET_RUNNER_TOKEN: "", FLEET_DASH_TOKEN: "", GITHUB_EVENT_NAME: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { out += d; });
      return new Promise<{ code: number | null; out: string }>((resolve) => child.on("exit", (code) => resolve({ code, out })));
    };
    const settle = async (id: string, result: Record<string, unknown>) => {
      for (let i = 0; i < 100; i++) {
        if ((await call("GET", `/api/v1/jobs/${id}/summary`, { token: READ })).status === 200) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const claimed = await call("GET", `/devices/${CI_DEV}/next-job`, { token: AGENT });
      check(`the device claims ${id}`, claimed.status === 200 && claimed.body?.job_id === id, JSON.stringify(claimed.body)?.slice(0, 200));
      await call("POST", "/results", { token: AGENT, body: { schema: 1, kind: "result", job_id: id, device_id: CI_DEV, iter: 0, final: true, ...result } });
    };

    const anon = await runScript("ci-enqueue.ts", ["--job", await specFile("ci-anon"), "--timeout", "0"], {});
    check("ci-enqueue without a token exits 5", anon.code === 5, `${anon.code}: ${anon.out.slice(-300)}`);
    const queued = await runScript("ci-enqueue.ts", ["--job", await specFile("ci-queued"), "--timeout", "0"], { FLEET_RUNNER_TOKEN: ALICE });
    check("with FLEET_RUNNER_TOKEN it enqueues, and a job still queued at the timeout exits 3", queued.code === 3, `${queued.code}: ${queued.out.slice(-300)}`);
    const q = await call("GET", "/api/v1/jobs/ci-queued/summary", { token: READ });
    check("the job is alice's, from ci", q.body?.requested_by === "alice" && q.body?.source === "ci", JSON.stringify([q.body?.requested_by, q.body?.source]));
    await call("POST", "/api/v1/jobs/ci-queued/cancel", { token: ALICE });
    const invalid = await runScript("ci-enqueue.ts", ["--job", await specFile("ci-invalid", { schema: 1, job_id: "ci-invalid", workload: "benchmark", executor: "device", target: {} })], { FLEET_TOKEN: ALICE });
    check("an invalid spec exits 2 (FLEET_TOKEN works too)", invalid.code === 2, `${invalid.code}: ${invalid.out.slice(-300)}`);

    const skipping = runScript("ci-enqueue.ts", ["--job", await specFile("ci-skipped"), "--timeout", "60"], { FLEET_RUNNER_TOKEN: ALICE });
    await settle("ci-skipped", { ok: true, error: "skipped: no device attached" });
    const skipped = await skipping;
    check("a skipped job exits 4, not 0", skipped.code === 4, `${skipped.code}: ${skipped.out.slice(-300)}`);
    const passing = runScript("ci-enqueue.ts", ["--job", await specFile("ci-passed"), "--timeout", "60"], { FLEET_RUNNER_TOKEN: ALICE });
    await settle("ci-passed", { ok: true, metrics: { decode_tps: 1 } });
    const passed = await passing;
    check("a passed job exits 0", passed.code === 0, `${passed.code}: ${passed.out.slice(-300)}`);
    const failing = runScript("ci-enqueue.ts", ["--job", await specFile("ci-failed"), "--timeout", "60"], { FLEET_RUNNER_TOKEN: ALICE });
    await settle("ci-failed", { ok: false, error: "boom" });
    const failed = await failing;
    check("a failed job exits 1", failed.code === 1, `${failed.code}: ${failed.out.slice(-300)}`);

    const apk = path.join(dir, "app.apk");
    await writeFile(apk, `apk-${Date.now()}`);
    const upArgs = ["--artifact", apk, "--app", "auth-app", "--build", "1.0"];
    const upAnon = await runScript("ci-upload.ts", upArgs, {});
    check("ci-upload without a token is refused (protocol needs agent) and exits 5", upAnon.code === 5, `${upAnon.code}: ${upAnon.out.slice(-300)}`);
    const up = await runScript("ci-upload.ts", upArgs, { FLEET_RUNNER_TOKEN: ADMIN, GITHUB_EVENT_NAME: "pull_request" });
    check("ci-upload sends the bearer token, and a pull_request event publishes on the pr channel", up.code === 0 && /pr channel/.test(up.out), `${up.code}: ${up.out.slice(-300)}`);
  }

  console.log("a peer with tokens on, read through another brain");
  {
    // A second collector, auth off, that lists this one as a peer. Without a
    // token this brain answers its overview with 401; FLEET_PEER_TOKENS is
    // what lets the other brain's switcher read it.
    const port2 = await freePort();
    const BASE2 = `http://127.0.0.1:${port2}`;
    peer = spawn(process.execPath, [TSX, "src/server.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLEET_PORT: String(port2), FLEET_BIND: "127.0.0.1",
        FLEET_DATA_DIR: path.join(dir, "data2"), FLEET_ARTIFACT_DIR: path.join(dir, "artifacts2"),
        FLEET_LOG_FILE: path.join(dir, "collector2.log"), FLEET_TOKENS_FILE: path.join(dir, "tokens2.json"),
        FLEET_AUTH: "", FLEET_AUTH_PROTOCOL: "",
        FLEET_SWEEP_MS: "60000", FLEET_SCHEDULER_TICK_MS: "60000",
        FLEET_PEERS: `${BASE}/`,
        FLEET_PEER_TOKENS: JSON.stringify({ [BASE]: READ }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    peer.stdout?.on("data", (d) => { log += d; });
    peer.stderr?.on("data", (d) => { log += d; });
    await up(BASE2, peer);
    const listed = await (await fetch(`${BASE2}/api/peers`)).json() as { peers: { id: string; reachable: boolean; devices: { total: number } | null }[] };
    const me = listed.peers[0];
    check("the other brain sees this one, with device counts it needed a token for",
      !!me && me.reachable && (me.devices?.total ?? 0) >= 1, JSON.stringify(listed));
    const proxied = await fetch(`${BASE2}/api/peers/${me?.id}/devices`);
    check("and its proxy reads this brain's devices with the peer token", proxied.status === 200, String(proxied.status));
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
    // The dashboard reads devices and jobs through the generated v1 client,
    // which it gives the same header rather than a bearer token.
    check("its /api/v1 reads carry X-Fleet-Token too", (await call("GET", "/api/v1/devices", { headers: { "x-fleet-token": READ } })).status === 200);
    const mine = await call("POST", "/api/v1/jobs", { headers: { "x-fleet-token": ALICE, "x-fleet-source": "dash" }, body: spec });
    check("and so does its enqueue, recorded as from the dashboard", mine.status === 201, `${mine.status} ${JSON.stringify(mine.body)}`);
    const s = await call("GET", `/api/v1/jobs/${mine.body.job_id}/summary`, { token: READ });
    check("as alice, via dash", s.body.requested_by === "alice" && s.body.source === "dash", JSON.stringify([s.body.requested_by, s.body.source]));
  }

  console.log("FLEET_DASH_TOKEN with auth off: /api/v1 cancel and retry carry the guard");
  {
    // A third collector: no tokens, only the dashboard's speed bump. v1 cancel
    // and retry forward to the guarded unversioned routes, and used to drop
    // the header on the way, so every one was a 401 whatever was sent.
    const port3 = await freePort();
    const BASE3 = `http://127.0.0.1:${port3}`;
    guarded = spawn(process.execPath, [TSX, "src/server.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLEET_PORT: String(port3), FLEET_BIND: "127.0.0.1",
        FLEET_DATA_DIR: path.join(dir, "data3"), FLEET_ARTIFACT_DIR: path.join(dir, "artifacts3"),
        FLEET_LOG_FILE: path.join(dir, "collector3.log"), FLEET_TOKENS_FILE: path.join(dir, "tokens3.json"),
        FLEET_AUTH: "", FLEET_AUTH_PROTOCOL: "", FLEET_DASH_TOKEN: "speed-bump",
        FLEET_SWEEP_MS: "60000", FLEET_SCHEDULER_TICK_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    guarded.stdout?.on("data", (d) => { log += d; });
    guarded.stderr?.on("data", (d) => { log += d; });
    await up(BASE3, guarded);
    const at = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${BASE3}${url}`, {
        method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    await at("POST", "/devices/register", { ...device, device_id: "guard-dev" });
    const job = await at("POST", "/api/v1/jobs", { ...spec, targets: { device_id: "guard-dev" } });
    check("enqueue is open, as POST /jobs is", job.status === 201, `${job.status} ${JSON.stringify(job.body)}`);
    const bare = await at("POST", `/api/v1/jobs/${job.body.job_id}/cancel`, {});
    check("cancel without the token is refused, as unauthorized", bare.status === 401 && bare.body.error.code === "unauthorized", JSON.stringify(bare));
    const wrong = await at("POST", `/api/v1/jobs/${job.body.job_id}/cancel`, {}, { "x-fleet-token": "nope" });
    check("and with the wrong one", wrong.status === 401, String(wrong.status));
    const ok = await at("POST", `/api/v1/jobs/${job.body.job_id}/cancel`, { reason: "cancelled from the dashboard" }, { "x-fleet-token": "speed-bump" });
    check("cancel with the token works", ok.status === 200 && ok.body.cancelled?.[0] === job.body.job_id, `${ok.status} ${JSON.stringify(ok.body)}`);
    const again = await at("POST", `/api/v1/jobs/${job.body.job_id}/retry`, {}, { "x-fleet-token": "speed-bump" });
    check("and so does retry", again.status === 201 && again.body.retry_of === job.body.job_id, `${again.status} ${JSON.stringify(again.body)}`);
  }
} catch (e) {
  failures++;
  console.error(`  FAIL  ${(e as Error).message}`);
} finally {
  if (failures) console.error(`\n--- collector output ---\n${log.slice(-4000)}`);
  for (const child of [server, peer, guarded]) {
    if (!child || child.exitCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
