/**
 * Who is asking, and whether they may.
 *
 * ## Two modes, and the default is the old one
 *
 * `FLEET_AUTH` unset is the posture this project has always had and still
 * recommends for a fleet on a home LAN or a tailnet: the network is the access
 * control, every request is allowed, and FLEET_DASH_TOKEN remains the speed
 * bump it always was. Nothing here changes what such a collector does, except
 * that it now writes down who said they were asking -- unverified, and labelled
 * that way.
 *
 * `FLEET_AUTH=tokens` is for a collector that something beyond the house can
 * reach: a corporate network, a remote MCP gateway, a CI system on another
 * continent. Every control-API request then needs a bearer token, and every
 * token carries scopes:
 *
 * | scope      | what it allows                                                    |
 * |------------|-------------------------------------------------------------------|
 * | `read`     | every GET: devices, jobs, results, artifacts, the dashboard's data |
 * | `run`      | enqueue, validate, and cancel or retry jobs it started             |
 * | `admin`    | everything else: other people's jobs, devices, schedules, power    |
 * | `agent`    | the runner protocol, when FLEET_AUTH_PROTOCOL=token                |
 * | `delegate` | name the person a request is for (`X-Fleet-Actor`), for a gateway  |
 *
 * `admin` implies `run`, which implies `read`; `admin` also implies `agent`.
 * `delegate` is implied by nothing, because a token that can put a name on a
 * job is a token that can put *anyone's* name on it.
 *
 * ## Why the runner protocol stays open by default even with tokens on
 *
 * The phone, TV, Roku and browser runners are five codebases, three of which
 * cannot be rebuilt from this repository's CI, and none of which sends a token
 * today. Requiring one would switch the shelf off. `FLEET_AUTH_PROTOCOL=token`
 * closes it for fleets whose runners can (runner-machine and the host executor
 * send `FLEET_TOKEN`); otherwise the protocol keeps the network as its access
 * control, which is the trade the README already describes.
 *
 * ## Tokens are a file, not a table
 *
 * `tokens.json` beside the database, holding SHA-256 hashes and never a token.
 * A file because the first token has to be created by someone who has no token
 * yet -- `fleet token create` on the brain's own host -- and because revoking
 * one should not need the collector to be up. It is re-read when it changes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest, InjectOptions } from "fastify";
import { AUTH, AUTH_PROTOCOL, TOKENS_FILE } from "./config.js";
import { db } from "./db.js";

export const SCOPES = ["read", "run", "admin", "agent", "delegate"] as const;
export type Scope = (typeof SCOPES)[number];

export type TokenRecord = {
  id: string;
  name: string;
  /** `sha256:<hex>` of the token. The token itself is shown once, at creation. */
  hash: string;
  scopes: Scope[];
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
};

type TokenFile = { tokens: TokenRecord[] };

/** What the hook decided about a request, available to every handler. */
export type AuthContext = {
  mode: "off" | "tokens";
  /** A name: a token's, a delegated person's, or whatever an unauthenticated caller claimed. */
  actor: string | null;
  /** True when `actor` came from a token rather than from a header anyone could send. */
  verified: boolean;
  token: { id: string; name: string } | null;
  scopes: Set<Scope>;
  /** Which front door: mcp, cli, ci, dash, schedule... Declared by the caller. */
  source: string | null;
  internal: boolean;
};

// --- tokens -------------------------------------------------------------------

export const hashToken = (token: string) => `sha256:${createHash("sha256").update(token).digest("hex")}`;

/**
 * A new token. The `fr_` prefix is so a secret scanner -- GitHub's, or a
 * pre-commit hook -- can recognise one that ended up in a repository.
 */
export function generateToken(): string {
  return `fr_${randomBytes(32).toString("base64url")}`;
}

function expand(scopes: Iterable<string>): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of scopes) if ((SCOPES as readonly string[]).includes(s)) out.add(s as Scope);
  if (out.has("admin")) {
    out.add("run");
    out.add("agent");
  }
  if (out.has("run")) out.add("read");
  return out;
}

export function readTokenFile(file: string = TOKENS_FILE): TokenFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TokenFile>;
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [] };
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function writeTokenFile(file: string, data: TokenFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // Written beside and renamed over, so a collector reading it mid-write sees
  // the old file or the new one and never half of each.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Create a token. Returns the only copy of it that will ever exist. */
export function createToken(
  opts: { name: string; scopes: string[]; expiresDays?: number },
  file: string = TOKENS_FILE,
): { token: string; record: TokenRecord } {
  const name = opts.name.trim();
  if (!/^[\w.@:-]{1,64}$/.test(name)) throw new Error("token name must be 1-64 of letters, digits, . _ - @ :");
  const unknown = opts.scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown scope(s): ${unknown.join(", ")}. Scopes are ${SCOPES.join(", ")}.`);
  if (opts.scopes.length === 0) throw new Error("a token needs at least one scope");
  const data = readTokenFile(file);
  if (data.tokens.some((t) => t.name === name && !t.revoked_at))
    throw new Error(`a live token named ${name} already exists; revoke it first`);
  const token = generateToken();
  const record: TokenRecord = {
    id: randomBytes(6).toString("hex"),
    name,
    hash: hashToken(token),
    scopes: [...new Set(opts.scopes)] as Scope[],
    created_at: new Date().toISOString(),
    expires_at: opts.expiresDays ? new Date(Date.now() + opts.expiresDays * 86_400_000).toISOString() : null,
    revoked_at: null,
  };
  data.tokens.push(record);
  writeTokenFile(file, data);
  return { token, record };
}

/** Revoke by id or name. Returns how many were revoked. */
export function revokeToken(idOrName: string, file: string = TOKENS_FILE): number {
  const data = readTokenFile(file);
  let n = 0;
  for (const t of data.tokens) {
    if ((t.id === idOrName || t.name === idOrName) && !t.revoked_at) {
      t.revoked_at = new Date().toISOString();
      n++;
    }
  }
  if (n) writeTokenFile(file, data);
  return n;
}

let cache: { file: string; mtimeMs: number; checkedAt: number; data: TokenFile } | null = null;

/** The token file, re-read at most once a second and only when it changed. */
function liveTokens(): TokenFile {
  const now = Date.now();
  if (cache && cache.file === TOKENS_FILE && now - cache.checkedAt < 1_000) return cache.data;
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(TOKENS_FILE).mtimeMs;
  } catch {
    /* no file is no tokens */
  }
  if (cache && cache.file === TOKENS_FILE && cache.mtimeMs === mtimeMs) {
    cache.checkedAt = now;
    return cache.data;
  }
  let data: TokenFile = { tokens: [] };
  try {
    data = readTokenFile(TOKENS_FILE);
  } catch {
    // A corrupt file denies everything rather than allowing everything.
  }
  cache = { file: TOKENS_FILE, mtimeMs, checkedAt: now, data };
  return data;
}

function lookup(token: string): TokenRecord | null {
  const want = Buffer.from(hashToken(token));
  const now = Date.now();
  for (const t of liveTokens().tokens) {
    const have = Buffer.from(t.hash);
    if (have.length !== want.length || !timingSafeEqual(have, want)) continue;
    if (t.revoked_at) return null;
    if (t.expires_at && Date.parse(t.expires_at) <= now) return null;
    return t;
  }
  return null;
}

/**
 * Things an operator should hear at startup rather than discover from a wall
 * of 401s: a misspelt FLEET_AUTH that left auth off, or auth on with nothing
 * that could ever pass it.
 */
export function authWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const raw = env.FLEET_AUTH;
  if (raw !== undefined && raw !== "" && raw !== "off" && raw !== "tokens")
    out.push(`FLEET_AUTH=${raw} is not a mode (off, tokens); auth is OFF and every request is trusted`);
  if (AUTH === "tokens") {
    const live = liveTokens().tokens.filter((t) => !t.revoked_at);
    if (live.length === 0)
      out.push(`FLEET_AUTH=tokens but ${TOKENS_FILE} has no live tokens; every control request will be refused. Create one: fleet token create <name> --scope admin`);
    if (AUTH_PROTOCOL === "token" && !live.some((t) => t.scopes.includes("agent") || t.scopes.includes("admin")))
      out.push("FLEET_AUTH_PROTOCOL=token but no token has the agent scope; no runner will be able to register");
  }
  return out;
}

// --- which routes need what ----------------------------------------------------

type Need = "public" | "protocol" | Scope;

const PROTOCOL_ROUTES: [string, RegExp][] = [
  ["POST", /^\/devices\/register$/],
  ["GET", /^\/devices\/[^/]+\/next-job$/],
  ["GET", /^\/executor\/next-job$/],
  ["POST", /^\/results$/],
  ["POST", /^\/jobs\/[^/]+\/release$/],
  ["POST", /^\/locks\/(acquire|release)$/],
  ["POST", /^\/artifacts$/],
  ["POST", /^\/events\/[^/]+$/],
  ["GET", /^\/events\/[^/]+\/poll$/],
  ["POST", /^\/api\/jobs\/[^/]+\/mirror$/],
  ["POST", /^\/findings$/],
];

const RUN_ROUTES: [string, RegExp][] = [
  ["POST", /^\/jobs$/],
  ["POST", /^\/api\/jobs$/],
  ["POST", /^\/api\/jobs\/preview-targets$/],
  ["POST", /^\/api\/jobs\/[^/]+\/(cancel|retry)$/],
  ["POST", /^\/api\/v1\/jobs$/],
  ["POST", /^\/api\/v1\/jobs\/validate$/],
  ["POST", /^\/api\/v1\/jobs\/[^/]+\/(cancel|retry)$/],
];

/** What a request needs. Exported so the rule table can be tested and documented. */
export function requirement(method: string, url: string): Need {
  const p = url.split("?")[0];
  const m = method === "HEAD" ? "GET" : method;
  if (m === "OPTIONS") return "public";
  if (m === "GET" && (
    p === "/" || p === "/runner" || p === "/get" || p === "/dash" || p.startsWith("/dash/") ||
    p === "/api/health" || p === "/api/v1/health" || p === "/api/v1/openapi.json" ||
    p === "/api/v1/whoami" || p.startsWith("/.well-known/")
  )) return "public";
  if (p === "/api/session") return "public";
  if (PROTOCOL_ROUTES.some(([rm, re]) => rm === m && re.test(p))) return "protocol";
  // Artifacts are read by runners (models, builds) and by people (screenshots).
  if (m === "GET" && /^\/artifacts\/[a-f0-9]{64}$/.test(p)) return "protocol";
  if (RUN_ROUTES.some(([rm, re]) => rm === m && re.test(p))) return "run";
  // Who did what is not something every reader should be able to list.
  if (p === "/api/v1/audit") return "admin";
  if (m === "GET") return "read";
  return "admin";
}

// --- the hook --------------------------------------------------------------------

/**
 * Proof that a request came from inside this process -- the scheduler, a route
 * forwarding to another route. Random per process, so nothing outside can send it.
 */
const INTERNAL_SECRET = randomBytes(24).toString("hex");

const contexts = new WeakMap<FastifyRequest, AuthContext>();

const OFF: AuthContext = {
  mode: "off", actor: null, verified: false, token: null, scopes: new Set(SCOPES), source: null, internal: false,
};

export function authOf(req: FastifyRequest): AuthContext {
  return contexts.get(req) ?? { ...OFF, mode: AUTH };
}

/** What gets written on a job as `requested_by` and `source`. */
export function provenanceOf(req: FastifyRequest): { requested_by: string | null; source: string | null } {
  const ctx = authOf(req);
  return { requested_by: ctx.actor, source: ctx.source };
}

const label = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, max);
  return /^[\w.@:+\- ]+$/.test(v) && v.length > 0 ? v : null;
};

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && /^Bearer\s+\S+$/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  const legacy = req.headers["x-fleet-token"];
  if (typeof legacy === "string" && legacy) return legacy;
  // The dashboard's <img> tags and its EventSource cannot set a header, so a
  // session cookie stands in -- for reads only. A cookie that could mutate
  // would be a cross-site request forgery waiting for a link.
  if (req.method === "GET" || req.method === "HEAD") {
    const cookie = req.headers.cookie ?? "";
    const m = /(?:^|;\s*)fleet_token=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function resolveContext(req: FastifyRequest): AuthContext {
  const source = label(req.headers["x-fleet-source"], 40);
  const claimed = label(req.headers["x-fleet-actor"], 120);
  if (req.headers["x-fleet-internal"] === INTERNAL_SECRET) {
    return {
      mode: AUTH, actor: claimed, verified: req.headers["x-fleet-verified"] === "1",
      token: null, scopes: new Set(SCOPES), source, internal: true,
    };
  }
  if (AUTH === "off") {
    return { mode: "off", actor: claimed, verified: false, token: null, scopes: new Set(SCOPES), source, internal: false };
  }
  const presented = bearer(req);
  const record = presented ? lookup(presented) : null;
  if (!record) {
    return { mode: "tokens", actor: null, verified: false, token: null, scopes: new Set(), source, internal: false };
  }
  const scopes = expand(record.scopes);
  // A delegating token vouches for the person it names: the gateway checked
  // their OAuth token before it got here. Any other token is its own name.
  const actor = scopes.has("delegate") && claimed ? claimed : record.name;
  return {
    mode: "tokens", actor, verified: true, token: { id: record.id, name: record.name }, scopes, source, internal: false,
  };
}

function deny(req: FastifyRequest, reply: FastifyReply, status: 401 | 403, code: string, message: string, need?: string) {
  if (status === 401) reply.header("www-authenticate", 'Bearer realm="fleet"');
  else reply.header("www-authenticate", `Bearer realm="fleet", error="insufficient_scope", scope="${need}"`);
  // The control API speaks in codes; the older endpoints in sentences, because
  // the dashboard reads `error` as a string.
  const body = req.url.startsWith("/api/v1/")
    ? { error: { code, message, ...(need ? { required_scope: need } : {}) } }
    : { error: message };
  return reply.code(status).send(body);
}

/** Routes whose traffic is the fleet breathing, not a person deciding. Never audited. */
const QUIET = /^\/(results|devices\/register|devices\/[^/]+\/next-job|executor\/next-job|locks\/|events\/|artifacts$|findings$|api\/jobs\/[^/]+\/mirror$|api\/session$)/;

export function registerAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    const ctx = resolveContext(req);
    contexts.set(req, ctx);
    if (ctx.mode === "off" || ctx.internal) return;

    const need = requirement(req.method, req.url);
    if (need === "public") return;
    if (need === "protocol") {
      if (AUTH_PROTOCOL === "open") return;
      // A person reading a screenshot holds `read`, a runner holds `agent`.
      const artifactRead = req.method === "GET" && ctx.scopes.has("read");
      if (ctx.scopes.has("agent") || artifactRead) return;
      if (!ctx.token) return deny(req, reply, 401, "unauthorized", "a token with the agent scope is required");
      return deny(req, reply, 403, "insufficient_scope", "this token cannot speak the runner protocol", "agent");
    }
    if (!ctx.token) return deny(req, reply, 401, "unauthorized", "a bearer token is required (FLEET_AUTH=tokens)");
    if (!ctx.scopes.has(need)) return deny(req, reply, 403, "insufficient_scope", `this needs the ${need} scope`, need);
  });

  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const ctx = contexts.get(req);
    // A forwarded request is the same decision as the request that forwarded it.
    if (!ctx || ctx.internal) return;
    const route = req.url.split("?")[0];
    if (QUIET.test(route)) return;
    const params = (req.params ?? {}) as Record<string, string>;
    try {
      db.prepare(
        `INSERT INTO audit_log (actor, verified, token_id, source, method, route, status, subject, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ctx.actor, ctx.verified ? 1 : 0, ctx.token?.id ?? null, ctx.source, req.method, route.slice(0, 300),
        reply.statusCode, params.id ?? params.sha256 ?? null, req.ip ?? null,
      );
    } catch {
      // The audit log is a record, not a gate: a full disk must not turn a
      // cancel that succeeded into a 500.
    }
  });

  // Exchange a header token for a read-only session cookie, so the dashboard's
  // images and live stream work once a token has been pasted.
  app.post("/api/session", async (req, reply) => {
    if (AUTH === "off") return { ok: true, auth: "off" };
    const presented = bearer(req);
    const record = presented ? lookup(presented) : null;
    if (!presented || !record) return reply.code(401).send({ error: "a valid token is required" });
    const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
    reply.header(
      "set-cookie",
      `fleet_token=${encodeURIComponent(presented)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86_400}${secure ? "; Secure" : ""}`,
    );
    return { ok: true, auth: "tokens", name: record.name, scopes: [...expand(record.scopes)] };
  });
  app.delete("/api/session", async (_req, reply) => {
    reply.header("set-cookie", "fleet_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return { ok: true };
  });
}

/**
 * `app.inject`, carrying the original caller with it.
 *
 * Routes forward to other routes so that validation has one implementation;
 * the forwarded request must neither be refused for lacking a token the
 * original already showed, nor lose the name of who asked.
 */
export function forward(app: FastifyInstance, from: FastifyRequest | null, opts: InjectOptions) {
  const ctx = from ? authOf(from) : null;
  const headers: Record<string, string> = { "x-fleet-internal": INTERNAL_SECRET };
  if (ctx?.actor) headers["x-fleet-actor"] = ctx.actor;
  if (ctx?.source) headers["x-fleet-source"] = ctx.source;
  if (ctx?.verified) headers["x-fleet-verified"] = "1";
  return app.inject({ ...opts, headers: { ...(opts.headers ?? {}), ...headers } });
}
