/**
 * `fleet mcp --http` -- the remote MCP gateway, for chat clients and anyone in
 * the company who is not on a machine with `fleet` installed.
 *
 * MCP's Streamable HTTP transport, the stateless subset: every POST to /mcp is
 * one JSON-RPC message (or batch) answered with JSON. No server-initiated
 * stream (GET is 405) and no session id, so any number of gateway replicas can
 * sit behind a load balancer with nothing shared between them.
 *
 * Who is calling is decided by the company's identity provider, not here: the
 * client presents an OAuth access token, oauth.ts verifies it, and the person
 * it names travels to the collector as `X-Fleet-Actor` on a request
 * authenticated with the gateway's own token -- which must carry the
 * `delegate` scope for the collector to believe the name. So `requested_by`
 * on a job started from a chat window is the person, verified twice.
 *
 * What a remote caller cannot do, whatever their scopes: run a dangerous
 * workload (shell), wait longer than a proxy will hold a request, or learn the
 * collector's internal URL. Rate limits are per person.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FleetClient } from "../../../collector/src/client/index.js";
import { VERSION } from "../version.js";
import { resourceMetadata, TokenError, Verifier, type OAuthConfig, type Principal } from "./oauth.js";
import { handle, PROTOCOLS, type Request, type Session } from "./protocol.js";
import type { Tool } from "./tools.js";

export type GatewayOptions = {
  port: number;
  host: string;
  /** The collector, as the gateway reaches it. Never shown to callers. */
  collectorUrl: string;
  /** The gateway's collector token: run + delegate when the collector has auth on. */
  collectorToken: string | null;
  /** The gateway's public base URL, e.g. https://fleet-mcp.example.com. The resource is `${publicUrl}/mcp`. */
  publicUrl: string;
  /** null runs without OAuth, which the CLI allows only on loopback. */
  oauth: OAuthConfig | null;
  /** Browser origins allowed to call (DNS rebinding protection). Requests with no Origin are always allowed. */
  allowedOrigins: string[];
  limits: { callsPerMinute: number; runsPerHour: number };
  log?: (line: string) => void;
};

const MAX_BODY = 1024 * 1024;

/** A sliding window of timestamps per key. Small, in-process, per replica. */
class Limiter {
  private hits = new Map<string, number[]>();
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < windowMs)) this.hits.delete(k);
    return true;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startGateway(opts: GatewayOptions): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const verifier = opts.oauth ? new Verifier(opts.oauth) : null;
  const resource = `${opts.publicUrl.replace(/\/+$/, "")}/mcp`;
  const metadataUrl = `${opts.publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp`;
  const calls = new Limiter();
  const runs = new Limiter();

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const challenge = (res: ServerResponse, e: TokenError | null, scope?: string) => {
    const parts = [`Bearer resource_metadata="${metadataUrl}"`];
    if (e) parts.push(`error="${e.code}"`, `error_description="${e.message.replace(/"/g, "'")}"`);
    if (scope) parts.push(`scope="${scope}"`);
    send(res, e?.status ?? 401, { error: e?.code ?? "invalid_token", error_description: e?.message ?? "a bearer token is required" }, { "www-authenticate": parts.join(", ") });
  };

  async function principalOf(req: IncomingMessage): Promise<Principal> {
    if (!verifier) return { subject: "local", scopes: new Set(["read", "run"]), granted: [], expiresAt: Infinity };
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw new TokenError(401, "invalid_token", "a bearer token is required");
    return verifier.verify(m[1]);
  }

  function sessionFor(p: Principal): Session {
    const client = new FleetClient({
      baseUrl: opts.collectorUrl,
      token: opts.collectorToken,
      source: "mcp",
      actor: verifier ? p.subject : null,
      timeoutMs: 30_000,
    });
    return {
      ctx: { client, remote: true },
      where: null,
      allowed: (tool: Tool) => p.scopes.has(tool.needs),
      admit: (tool: Tool) => {
        if (!calls.take(p.subject, opts.limits.callsPerMinute, 60_000)) return `rate limited: at most ${opts.limits.callsPerMinute} calls a minute`;
        if (tool.name === "fleet_run" && !runs.take(p.subject, opts.limits.runsPerHour, 3_600_000))
          return `rate limited: at most ${opts.limits.runsPerHour} jobs an hour through the connector`;
        return null;
      },
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const started = Date.now();
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION, oauth: !!verifier });

      if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        if (!opts.oauth) return send(res, 404, { error: "this gateway runs without OAuth" });
        return send(res, 200, resourceMetadata(resource, opts.oauth), { "access-control-allow-origin": "*" });
      }

      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });

      // A browser page on another origin must not be able to drive the lab
      // through a gateway on localhost (DNS rebinding).
      const origin = req.headers.origin;
      if (origin && !opts.allowedOrigins.includes(origin)) return send(res, 403, { error: "origin not allowed" });

      if (req.method === "OPTIONS") {
        return send(res, 204, undefined, {
          "access-control-allow-origin": origin ?? "*",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
        });
      }
      if (req.method !== "POST") return send(res, 405, { error: "POST only; this gateway offers no server-initiated stream" }, { allow: "POST" });

      let principal: Principal;
      try {
        principal = await principalOf(req);
      } catch (e) {
        if (e instanceof TokenError) return challenge(res, e);
        log(`oauth: ${(e as Error).message}`);
        return send(res, 503, { error: "the identity provider could not be reached" });
      }
      if (principal.scopes.size === 0) return challenge(res, new TokenError(403, "insufficient_scope", "the token grants no Fleet Runner scope"), opts.oauth?.scopes.read);

      const version = req.headers["mcp-protocol-version"];
      if (typeof version === "string" && !PROTOCOLS.includes(version))
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${version}` } });

      let parsed: Request | Request[];
      try {
        parsed = JSON.parse(await readBody(req)) as Request | Request[];
      } catch {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }

      const session = sessionFor(principal);
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const replies = (await Promise.all(messages.map((m) => handle(session, m)))).filter((r) => r !== null);
      const calledTools = messages.filter((m) => m?.method === "tools/call").map((m) => String(m.params?.name ?? "?"));
      if (calledTools.length) log(`${new Date().toISOString()} ${principal.subject} ${calledTools.join(",")} ${Date.now() - started}ms`);
      if (replies.length === 0) {
        res.writeHead(202);
        return res.end();
      }
      return send(res, 200, Array.isArray(parsed) ? replies : replies[0], origin ? { "access-control-allow-origin": origin } : {});
    } catch (e) {
      log(`gateway error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
  // A long fleet_job wait is 55 s; anything far past that is a stuck client.
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address.includes(":") ? `[${addr.address}]` : addr.address}:${addr.port}`;
  return { url, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** `fleet mcp --http`: flags to options, the safety checks, and a warning per misconfiguration. */
export async function serveGateway(flags: Record<string, string | boolean>, collectorUrl: string, collectorToken: string | null): Promise<number> {
  const str = (k: string, env?: string) => (typeof flags[k] === "string" ? (flags[k] as string) : env ? process.env[env] : undefined);
  const host = str("host", "FLEET_MCP_HOST") ?? "127.0.0.1";
  const port = Number(str("port", "FLEET_MCP_PORT") ?? 8790);
  const issuer = str("issuer", "FLEET_MCP_ISSUER");
  const audience = str("audience", "FLEET_MCP_AUDIENCE");
  const insecure = flags["no-auth"] === true;

  if (!issuer && !insecure) {
    console.error("fleet mcp --http needs --issuer and --audience (your identity provider), or --no-auth on loopback for development.");
    return 2;
  }
  if (insecure && !LOOPBACK.has(host)) {
    console.error(`refusing --no-auth on ${host}: without OAuth the gateway trusts every caller, so it binds to loopback only.`);
    return 2;
  }
  if (issuer && !audience) {
    console.error("--audience is required with --issuer: it is what stops a token minted for another app from working here.");
    return 2;
  }

  const oauth: OAuthConfig | null = issuer
    ? {
        issuer,
        audience: audience!,
        jwksUri: str("jwks", "FLEET_MCP_JWKS"),
        scopes: { read: str("scope-read", "FLEET_MCP_SCOPE_READ") ?? "fleet.read", run: str("scope-run", "FLEET_MCP_SCOPE_RUN") ?? "fleet.run" },
        identityClaims: str("identity-claim", "FLEET_MCP_IDENTITY_CLAIM")?.split(","),
      }
    : null;
  const publicUrl = str("public-url", "FLEET_MCP_PUBLIC_URL") ?? `http://${host}:${port}`;
  const origins = (str("allow-origin", "FLEET_MCP_ALLOW_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Say what the collector thinks of the gateway's token before taking traffic.
  try {
    const me = await new FleetClient({ baseUrl: collectorUrl, token: collectorToken, source: "mcp" }).whoami();
    if (me.auth === "tokens" && !me.scopes.includes("delegate"))
      console.warn("warning: the gateway's collector token lacks the delegate scope, so every job will be recorded as the gateway, not the person.");
    if (me.auth === "tokens" && !me.scopes.includes("run")) console.warn("warning: the gateway's collector token lacks run; fleet_run will be refused.");
    if (me.auth === "off" && oauth) console.warn("warning: the collector runs with FLEET_AUTH off; anyone who can reach it directly bypasses this gateway.");
  } catch (e) {
    console.warn(`warning: the collector at ${collectorUrl} did not answer (${(e as Error).message}); starting anyway.`);
  }

  const gw = await startGateway({
    port, host, collectorUrl, collectorToken, publicUrl, oauth, allowedOrigins: origins,
    limits: {
      callsPerMinute: Number(str("calls-per-minute", "FLEET_MCP_CALLS_PER_MINUTE") ?? 60),
      runsPerHour: Number(str("runs-per-hour", "FLEET_MCP_RUNS_PER_HOUR") ?? 30),
    },
  });
  console.log(`fleet mcp gateway ${VERSION}`);
  console.log(`  listening  ${gw.url}/mcp`);
  console.log(`  resource   ${publicUrl.replace(/\/+$/, "")}/mcp`);
  console.log(`  oauth      ${oauth ? `${oauth.issuer} (aud ${oauth.audience}; scopes ${oauth.scopes.read}, ${oauth.scopes.run})` : "OFF (loopback development only)"}`);
  console.log(`  collector  ${collectorUrl}`);
  await new Promise<void>((resolve) => {
    for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => resolve());
  });
  await gw.close();
  return 0;
}
