/**
 * The gateway as an OAuth 2.1 resource server: verify the bearer token a chat
 * client got from the company's identity provider, and say who it names.
 *
 * Resource server only. The gateway never sees a password, never issues a
 * token and never runs a login page: the identity provider (Entra ID, Okta,
 * whichever) does all of that, and the MCP client finds it through the RFC 9728
 * metadata this module describes. What is left here is checking a JWT, which
 * node:crypto does without a library:
 *
 * - the signature, against the provider's published keys (JWKS), RS256/PS256/ES256
 * - `iss` is the configured issuer, `aud` includes the configured audience
 * - `exp` and `nbf`, with a minute of clock skew
 * - the scopes, from `scp` (Entra), `scope` (RFC 8693 style) or `roles` (app roles)
 *
 * `alg: none` and HMAC algorithms are refused outright: a resource server that
 * accepts a symmetric algorithm can be handed a token signed with its own
 * public key.
 */
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export type OAuthConfig = {
  /** The authorization server's issuer, exactly as it appears in `iss`. */
  issuer: string;
  /** This resource's identifier, as it appears in `aud` (an app ID URI or client id). */
  audience: string;
  /** Where the signing keys are. Discovered from the issuer's OpenID configuration when omitted. */
  jwksUri?: string;
  /** Which token scope (or app role) grants which gateway scope. */
  scopes: { read: string; run: string };
  /** Which claims name the person, in order of preference. */
  identityClaims?: string[];
  fetch?: typeof fetch;
};

export type Principal = {
  /** The person, for requested_by and the audit log. */
  subject: string;
  scopes: Set<"read" | "run">;
  /** Every scope or role the token carried, for diagnostics. */
  granted: string[];
  expiresAt: number;
};

export class TokenError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
  }
}

const b64url = (s: string) => Buffer.from(s, "base64url");
const SKEW_S = 60;

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string; kty: string };

export class Verifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private jwksUri: string | null;
  private readonly fetcher: typeof fetch;

  constructor(readonly config: OAuthConfig) {
    this.jwksUri = config.jwksUri ?? null;
    this.fetcher = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** The keys, fetched at most every ten minutes, or once a minute when a kid is unknown. */
  private async refresh(force: boolean): Promise<void> {
    const age = Date.now() - this.fetchedAt;
    if (!force && age < 10 * 60_000 && this.keys.size) return;
    if (force && age < 60_000) return;
    if (!this.jwksUri) {
      const wellKnown = `${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
      const res = await this.fetcher(wellKnown, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`cannot read ${wellKnown}: HTTP ${res.status}`);
      const meta = (await res.json()) as { jwks_uri?: string };
      if (!meta.jwks_uri) throw new Error(`${wellKnown} names no jwks_uri`);
      this.jwksUri = meta.jwks_uri;
    }
    const res = await this.fetcher(this.jwksUri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`cannot read ${this.jwksUri}: HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const k of keys ?? []) {
      if (k.use && k.use !== "sig") continue;
      try {
        next.set(k.kid ?? "", createPublicKey({ key: k, format: "jwk" }));
      } catch { /* a key type this node cannot load is not one it can verify with */ }
    }
    this.keys = next;
    this.fetchedAt = Date.now();
  }

  private async key(kid: string | undefined): Promise<KeyObject> {
    await this.refresh(false);
    let k = this.keys.get(kid ?? "") ?? (kid === undefined && this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
    if (!k) {
      await this.refresh(true);
      k = this.keys.get(kid ?? "");
    }
    if (!k) throw new TokenError(401, "invalid_token", "the token was signed with a key the issuer does not publish");
    return k;
  }

  async verify(token: string, now = Date.now()): Promise<Principal> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new TokenError(401, "invalid_token", "not a JWT");
    let header: { alg?: string; kid?: string; typ?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64url(parts[0]).toString("utf8"));
      claims = JSON.parse(b64url(parts[1]).toString("utf8"));
    } catch {
      throw new TokenError(401, "invalid_token", "the token is not valid JSON");
    }

    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = b64url(parts[2]);
    const key = await this.key(header.kid);
    let valid: boolean;
    switch (header.alg) {
      case "RS256":
        valid = verify("sha256", signed, key, signature);
        break;
      case "PS256":
        valid = verify("sha256", signed, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, signature);
        break;
      case "ES256":
        valid = verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
        break;
      default:
        throw new TokenError(401, "invalid_token", `algorithm ${String(header.alg)} is not accepted`);
    }
    if (!valid) throw new TokenError(401, "invalid_token", "bad signature");

    const t = Math.floor(now / 1000);
    if (claims.iss !== this.config.issuer) throw new TokenError(401, "invalid_token", "wrong issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.audience)) throw new TokenError(401, "invalid_token", "this token is not for this resource");
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < t) throw new TokenError(401, "invalid_token", "expired");
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > t) throw new TokenError(401, "invalid_token", "not yet valid");

    const granted = [
      ...(typeof claims.scp === "string" ? claims.scp.split(" ") : []),
      ...(typeof claims.scope === "string" ? claims.scope.split(" ") : []),
      ...(Array.isArray(claims.scp) ? claims.scp.map(String) : []),
      ...(Array.isArray(claims.roles) ? claims.roles.map(String) : []),
    ].filter(Boolean);
    const scopes = new Set<"read" | "run">();
    if (granted.includes(this.config.scopes.run)) scopes.add("run").add("read");
    if (granted.includes(this.config.scopes.read)) scopes.add("read");

    const subject = (this.config.identityClaims ?? ["preferred_username", "upn", "email", "unique_name", "sub"])
      .map((c) => claims[c])
      .find((v): v is string => typeof v === "string" && v.length > 0);
    if (!subject) throw new TokenError(401, "invalid_token", "the token names nobody");
    return { subject: subject.slice(0, 120), scopes, granted, expiresAt: (claims.exp as number) * 1000 };
  }
}

/** RFC 9728 protected resource metadata, for /.well-known/oauth-protected-resource. */
export function resourceMetadata(resource: string, config: OAuthConfig) {
  return {
    resource,
    authorization_servers: [config.issuer],
    scopes_supported: [config.scopes.read, config.scopes.run],
    bearer_methods_supported: ["header"],
    resource_name: "Fleet Runner device lab",
    resource_documentation: "https://addisdev.github.io/fleet-runner/agents/",
  };
}
