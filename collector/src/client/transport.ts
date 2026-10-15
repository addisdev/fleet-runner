/**
 * The HTTP half of the Fleet Runner client. The other half, api.gen.ts, is
 * generated from the route table and only knows operation names and shapes.
 *
 * Zero dependencies and nothing Node-specific, because four things import it:
 * the fleet CLI, the MCP server, the dashboard (in a browser) and the host
 * executor. `fetch` and `AbortSignal.timeout` are in every one of those.
 */

export type ClientOptions = {
  /** The collector, e.g. http://fleet.local:8788. No trailing /api/v1. */
  baseUrl: string;
  /** A Fleet Runner token. Sent as `Authorization: Bearer`. */
  token?: string | null;
  /** Which front door this is: cli, mcp, ci, dash... Recorded on every job created. */
  source?: string;
  /** The person this acts for. Believed only from a token with the delegate scope. */
  actor?: string | null;
  /** Per-request timeout. Long-polls add their own wait to it. Default 30 s. */
  timeoutMs?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Return the Response untouched (for artifact bytes). */
  raw?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** A refusal from the collector, carrying the v1 error envelope's fields. */
export class FleetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "FleetApiError";
  }
}

export class Transport {
  readonly baseUrl: string;
  token: string | null;
  source: string | undefined;
  actor: string | null;
  private readonly timeoutMs: number;
  private readonly extra: Record<string, string>;
  private readonly fetcher: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.source = opts.source;
    this.actor = opts.actor ?? null;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.extra = opts.headers ?? {};
    this.fetcher = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { ...this.extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.source) h["x-fleet-source"] = this.source;
    if (this.actor) h["x-fleet-actor"] = this.actor;
    return h;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ""}`;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers = this.headers();
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await this.fetcher(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    } catch (e) {
      const err = e as Error;
      const why = err.name === "TimeoutError" ? "timed out" : err.message;
      throw new FleetApiError(0, "unreachable", `cannot reach ${this.baseUrl}: ${why}`, "is the collector running, and is the URL right?");
    }
    if (opts.raw && res.ok) return res as unknown as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const e = (body as { error?: unknown } | null)?.error;
      if (e && typeof e === "object") {
        const { code, message, hint, details } = e as { code?: string; message?: string; hint?: string; details?: unknown };
        throw new FleetApiError(res.status, code ?? "error", message ?? `HTTP ${res.status}`, hint, details);
      }
      throw new FleetApiError(res.status, res.status === 404 ? "not_found" : "error", typeof e === "string" ? e : `HTTP ${res.status}`);
    }
    return body as T;
  }
}

export const enc = encodeURIComponent;
