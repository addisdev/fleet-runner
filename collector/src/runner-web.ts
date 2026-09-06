/**
 * Serves the browser runner at `/runner`.
 *
 * One file, no build step, read from disk on every request. That is not
 * laziness: the whole value of this runner is that a device with nothing
 * installed can join the fleet by opening a URL, and a page that needed a
 * bundler would put a build between the collector and its own most reachable
 * agent. The dashboard has a build step because it is an application; this is
 * one HTML file and should stay one HTML file.
 *
 * Read per request rather than cached at startup so that editing it and hitting
 * reload works, which is how it is actually developed.
 */
import type { FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this module, not from cwd: the collector is started by a
// LaunchAgent whose working directory is not the repository.
const RUNNER_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../runner-web/index.html",
);

export function registerRunnerWeb(app: FastifyInstance) {
  app.get("/runner", async (_req, reply) => {
    if (!existsSync(RUNNER_HTML)) {
      return reply.code(404).type("text/plain").send(
        "The browser runner is missing from this checkout (collector/runner-web/index.html).",
      );
    }
    return reply
      .type("text/html; charset=utf-8")
      // The page is a runner, not a document: a cached copy that outlives a
      // protocol change is an agent speaking last month's dialect.
      .header("cache-control", "no-store")
      .send(readFileSync(RUNNER_HTML, "utf8"));
  });
}
