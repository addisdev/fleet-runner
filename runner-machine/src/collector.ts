/**
 * HTTP client for the collector.
 *
 * The same primitives as fleet-collector/src/fleet-client.ts, re-implemented
 * rather than imported — for the same reason the Android and iOS runners have
 * their own: an agent that is a device on the fleet should depend on the
 * protocol, not on the collector's source tree.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, mkdir, stat, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import type { JobSpec, RegisterPost, ResultPost } from "./protocol.js";

export const DEFAULT_BASE = "http://127.0.0.1:8788";

/**
 * The collector holds a next-job long-poll for ~25 s, the same as it does for
 * the phones. Both phone runners set a 40 s socket timeout above it; this one
 * aborts at 40 s too, which is also what makes a laptop recover from sleep —
 * the socket the poll was waiting on is dead on the other side of a suspend,
 * and without a deadline the agent would wait on it forever.
 */
const POLL_TIMEOUT_MS = 40_000;
const POST_TIMEOUT_MS = 30_000;

export class CollectorError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`${path} failed: HTTP ${status}`);
  }
}

export class CollectorClient {
  readonly base: string;

  constructor(baseUrl: string = process.env.FLEET_URL ?? DEFAULT_BASE) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async register(body: RegisterPost): Promise<void> {
    await this.post("/devices/register", body);
  }

  /** Long-polls for work; null when the poll expired with no job (HTTP 204). */
  async nextJob(deviceId: string): Promise<JobSpec | null> {
    const res = await fetch(`${this.base}/devices/${encodeURIComponent(deviceId)}/next-job`, {
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new CollectorError(res.status, "next-job");
    return (await res.json()) as JobSpec;
  }

  async postResult(row: ResultPost): Promise<void> {
    await this.post("/results", row);
  }

  /**
   * Posts a beacon and returns the collector's `lease_renewed`.
   *
   * False means the claim on this beacon's job is gone — cancelled from the
   * dashboard, or swept for a missed lease — and the workload should stop.
   * Only an explicit `false` in a 2xx body says that: a non-2xx response or a
   * transport failure throws instead, so a collector this agent cannot reach
   * can never be mistaken for a collector telling it to stop.
   */
  async postBeacon(row: ResultPost): Promise<boolean> {
    const body = await this.post("/results", row);
    return leaseRenewedIn(body);
  }

  /**
   * Downloads an artifact and verifies its content hash before the rename, so
   * a truncated or substituted file can never be handed to a backend under a
   * name that says it is the model somebody asked for.
   */
  async fetchArtifact(sha256: string, dest: string): Promise<void> {
    await mkdir(path.dirname(dest), { recursive: true });
    const res = await fetch(`${this.base}/artifacts/${sha256}`);
    if (!res.ok || !res.body) throw new CollectorError(res.status, `artifact ${sha256}`);
    const tmp = `${dest}.part`;
    const hash = createHash("sha256");
    const tee = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), tee, createWriteStream(tmp));
    const got = hash.digest("hex");
    if (got !== sha256) throw new Error(`artifact hash mismatch: wanted ${sha256} got ${got}`);
    await rename(tmp, dest);
  }

  private async post(p: string, body: unknown): Promise<string> {
    const res = await fetch(`${this.base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new CollectorError(res.status, p);
    return text;
  }
}

/**
 * Reads `lease_renewed` out of a 2xx /results body.
 *
 * Only a JSON `false` counts. An absent field, an empty body, an HTML error
 * page a proxy substituted, or a `"false"` that arrived as a string all read
 * as renewed — because a flaky network must never look like a cancellation,
 * and stopping work is the expensive direction to be wrong in. This is the
 * bug both phone runners shipped and fixed; it is not reintroduced here.
 */
export function leaseRenewedIn(body: string | null | undefined): boolean {
  if (!body || body.trim() === "") return true;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
    const v = (parsed as Record<string, unknown>).lease_renewed;
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

/** Verifies a file already on disk against the hash it is named for. */
export async function fileMatchesHash(file: string, sha256: string): Promise<boolean> {
  try {
    if ((await stat(file)).size === 0) return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  const fh = await open(file, "r");
  try {
    await pipeline(fh.createReadStream(), new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }));
  } finally {
    await fh.close();
  }
  return hash.digest("hex") === sha256;
}
