/**
 * Other brains, seen from this one.
 *
 * ## What a peer is, and what it is not
 *
 * A peer is a collector this one knows the address of. That is the whole
 * relationship. Peers do **not** share a database, do not forward jobs to each
 * other, do not replicate results, and do not elect anything. A job enqueued on
 * brain A is A's job and lands in A's database, whatever device ran it.
 *
 * That restraint is the design. The collector is one SQLite file and a shelf;
 * everything past "read the other one's API" is a distributed system, and this
 * project is emphatically not one. What multi-homing needed was for a *device*
 * to belong to two fleets, and that is solved in the agent's claim gate and the
 * queue's `busy` check. This exists for the much smaller problem of a person
 * with two fleets wanting one screen.
 *
 * ## Why the collector proxies instead of the browser calling directly
 *
 * Because there is no authentication, by design, and CORS would be the wrong
 * end of the stick. Opening the read API cross-origin would let any website
 * open in the operator's browser read their entire fleet -- device names,
 * network prefixes, job history -- from any tab. The proxy keeps one origin,
 * one token, and one place that decides what may be asked for.
 *
 * ## Read-only, and enforced rather than intended
 *
 * Only `GET`, only paths under `/api/`, and a deny-list is not used -- an
 * allow-list of prefixes is, because the failure of a deny-list is that the
 * next endpoint somebody adds is exposed by default. Enqueueing on another
 * brain means switching to it, which navigates to that brain's own dashboard:
 * one origin, one owner of that queue, and no question about which fleet a
 * button just acted on.
 */
import type { FastifyInstance } from "fastify";
import { PEERS } from "../config.js";
import { identity } from "../identity.js";
import { DATA_DIR } from "../config.js";

/** How long to wait on a peer before calling it unreachable. */
const PEER_TIMEOUT_MS = 4_000;

/**
 * What may be proxied.
 *
 * An allow-list of prefixes rather than a rule about methods alone, because
 * `GET /api/artifacts/:sha` streams bytes and `GET /api/stream` is an endless
 * SSE response -- neither belongs on a path whose whole purpose is to fill in a
 * summary table. Everything here answers with a bounded JSON document.
 */
const PROXYABLE = [
  "overview",
  "health",
  "devices",
  "jobs",
  "results",
  "alerts",
  "executors",
  "schedules",
];

function proxyable(rest: string): boolean {
  const head = rest.split("?")[0].split("/")[0];
  return PROXYABLE.includes(head);
}

export type PeerStatus = {
  url: string;
  id: string | null;
  name: string | null;
  version: string | null;
  reachable: boolean;
  /** Why not, when it is not. Shown in the UI rather than swallowed. */
  error: string | null;
  devices: { total: number; online: number } | null;
};

async function ask(url: string): Promise<PeerStatus> {
  const base = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
    if (!res.ok) {
      return { url: base, id: null, name: null, version: null, reachable: false, error: `HTTP ${res.status}`, devices: null };
    }
    const health = (await res.json()) as { collector?: string; name?: string; version?: string };
    let devices: PeerStatus["devices"] = null;
    try {
      const overview = (await fetch(`${base}/api/overview`, {
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      }).then((r) => r.json())) as { devices?: { total?: number; online?: number } };
      if (overview.devices) {
        devices = { total: overview.devices.total ?? 0, online: overview.devices.online ?? 0 };
      }
    } catch {
      // A brain that answers health and not overview is up and busy or
      // half-started. Worth showing as reachable with no counts rather than as
      // down, which is a different problem with a different fix.
    }
    return {
      url: base,
      // A collector older than this build answers health without them. Not an
      // error: both fields are additive, and refusing to list such a peer would
      // mean this feature only works once every brain is upgraded.
      id: health.collector ?? null,
      name: health.name ?? null,
      version: health.version ?? null,
      reachable: true,
      error: null,
      devices,
    };
  } catch (e) {
    return {
      url: base,
      id: null,
      name: null,
      version: null,
      reachable: false,
      error: (e as Error).message,
      devices: null,
    };
  }
}

export function registerPeers(app: FastifyInstance) {
  app.get("/api/peers", async () => {
    const me = identity(DATA_DIR);
    // Asked in parallel and every one time-boxed, because this endpoint backs a
    // screen and one unreachable brain must not make the page take as long as
    // its timeout multiplied by however many peers there are.
    const peers = await Promise.all(PEERS.map(ask));
    return {
      self: { id: me.id, name: me.name },
      // A peer list that included this collector would make every "all brains"
      // view double-count its own devices.
      peers: peers.filter((p) => p.id === null || p.id !== me.id),
      configured: PEERS.length,
    };
  });

  /**
   * `GET /api/peers/:id/*` -- one peer's read API, fetched server to server.
   *
   * Addressed by the peer's stable id rather than by its URL, so that a
   * dashboard link cannot be turned into a request to an arbitrary host by
   * editing the address bar. The id has to already be in this collector's
   * configured peer list; anything else is a 404, not a fetch.
   */
  app.get("/api/peers/:id/*", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rest = (req.params as { "*": string })["*"];
    if (!proxyable(rest)) {
      return reply.code(403).send({ error: `not proxyable: /api/${rest}` });
    }

    // Resolved against the configured list, so only a brain the operator named
    // can be reached -- the id in the URL selects, it does not address.
    const statuses = await Promise.all(PEERS.map(ask));
    const peer = statuses.find((p) => p.id === id);
    if (!peer) return reply.code(404).send({ error: `no configured peer with id ${id}` });
    if (!peer.reachable) return reply.code(502).send({ error: `peer ${peer.url} is unreachable: ${peer.error}` });

    const query = req.raw.url?.includes("?") ? req.raw.url.slice(req.raw.url.indexOf("?")) : "";
    try {
      const res = await fetch(`${peer.url}/api/${rest}${query}`, {
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      const body = await res.text();
      return reply.code(res.status).type(res.headers.get("content-type") ?? "application/json").send(body);
    } catch (e) {
      return reply.code(502).send({ error: `peer ${peer.url} did not answer: ${(e as Error).message}` });
    }
  });
}
