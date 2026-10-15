/**
 * The older read and enqueue endpoints, marked as superseded.
 *
 * They keep working -- the dashboard, the runners and every script written in
 * the last year call them -- but a client that reads headers learns there is a
 * successor (RFC 9745 `Deprecation`, RFC 8288 `Link` with successor-version).
 * Nothing here has a Sunset: removing them is a decision for a later release,
 * not a date this one sets.
 *
 * The runner protocol is not on this list. It is not superseded; it is a
 * different audience.
 */
import type { FastifyInstance } from "fastify";

/** 2026-10-14, when /api/v1 shipped, as the RFC 9745 `@<epoch seconds>` form. */
const SINCE = `@${Math.floor(Date.UTC(2026, 9, 14) / 1000)}`;

const SUCCESSORS: [method: string, pattern: RegExp, successor: (m: RegExpExecArray) => string][] = [
  ["GET", /^\/api\/devices$/, () => "/api/v1/devices"],
  ["GET", /^\/api\/devices\/([^/]+)$/, (m) => `/api/v1/devices/${m[1]}`],
  ["GET", /^\/api\/jobs$/, () => "/api/v1/jobs"],
  ["GET", /^\/api\/jobs\/([^/]+)$/, (m) => `/api/v1/jobs/${m[1]}`],
  ["GET", /^\/jobs\/([^/]+)$/, (m) => `/api/v1/jobs/${m[1]}`],
  ["POST", /^\/api\/jobs$/, () => "/api/v1/jobs"],
  ["POST", /^\/jobs$/, () => "/api/v1/jobs"],
  ["GET", /^\/api\/results$/, () => "/api/v1/results"],
  ["GET", /^\/devices$/, () => "/api/v1/devices"],
  ["GET", /^\/schedules$/, () => "/api/v1/schedules"],
];

/** Must run before any route is declared, like every root hook. */
export function registerDeprecations(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const p = req.url.split("?")[0];
    for (const [method, re, successor] of SUCCESSORS) {
      if (req.method !== method) continue;
      const m = re.exec(p);
      if (!m) continue;
      reply.header("deprecation", SINCE).header("link", `<${successor(m)}>; rel="successor-version"`);
      break;
    }
    return payload;
  });
}
