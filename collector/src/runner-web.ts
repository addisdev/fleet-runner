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
import { db } from "./db.js";
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
  /**
   * `/get` -- the enrolment page for a device with no camera.
   *
   * The dashboard's own enrolment screen shows a QR code, which is the right
   * answer for a phone and no answer at all for a television. A Fire TV is
   * enrolled by opening its Downloader app and typing a URL with a remote, so
   * the URL has to be short enough to type that way and the page it lands on
   * has to be readable across a room.
   *
   * That rules out the dashboard: it is a Preact bundle behind a route with a
   * hyphen in it, its download link is a 64-character content hash, and its
   * text is sized for a laptop. So this is a separate page, at the shortest
   * path that was free, in one file with no build step -- the same bargain the
   * browser runner makes and for the same reason.
   *
   * Everything on it is large, high-contrast, and reachable with a D-pad.
   */
  app.get("/get", async (req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(getPage(req.headers.host ?? null));
  });

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

/**
 * The `/get` page.
 *
 * Rendered from a template rather than served from a file because the one thing
 * it must get right -- the address of the newest runner build -- is a database
 * lookup, and because there is nothing here worth a second file.
 *
 * `host` comes from the request rather than from the collector's interfaces,
 * which is the opposite of what `/api/enroll` does and is right for the
 * opposite reason. That endpoint answers "what address should I put in a QR
 * code for a device that is not here yet", where the browser's own origin is
 * useless. This page is being read ON the device, through an address that
 * demonstrably reaches this collector -- so that address is the best one there
 * is, and deriving a different one would hand the television a link it might
 * not be able to follow.
 */
function getPage(host: string | null): string {
  const base = host ? `http://${host}` : "";
  const apk = db
    .prepare(
      `SELECT sha256, name FROM artifacts
       WHERE name LIKE '%.apk' ORDER BY COALESCE(publish_seq, rowid) DESC LIMIT 1`,
    )
    .get() as { sha256: string; name: string } | undefined;
  const apkHref = apk ? `${base}/artifacts/${apk.sha256}?filename=${encodeURIComponent(apk.name)}` : null;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join this fleet</title>
<style>
  /* Sized for a television at three metres, not a laptop at fifty centimetres.
     A TV browser's default 16px body text is unreadable from a sofa, and the
     whole point of this page is that somebody is looking at it from one. */
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 4vh 6vw;
    background: #1C2025; color: #E8EAED;
    font: 2.2vh/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 4.4vh; margin: 0 0 0.4em; font-weight: 650; }
  h2 { font-size: 2.8vh; margin: 1.6em 0 0.4em; color: #E3A44A; font-weight: 600; }
  .addr {
    font: 600 5vh/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #E3A44A; word-break: break-all; margin: 0.3em 0 0.8em;
  }
  ol { padding-left: 1.4em; } li { margin: 0.5em 0; }
  a { color: #E3A44A; }
  /* Focus has to be obvious: a D-pad user has no cursor and no hover. */
  a:focus, a:hover { outline: 3px solid #E3A44A; outline-offset: 4px; background: #E3A44A; color: #1C2025; }
  .big {
    display: inline-block; padding: 0.6em 1.2em; margin: 0.4em 0.6em 0.4em 0;
    border: 2px solid #E3A44A; border-radius: 6px; text-decoration: none; font-size: 2.6vh;
  }
  .faint { color: #9AA4B0; font-size: 1.9vh; }
</style>
</head><body>
<h1>Join this fleet</h1>
<p class="faint">This collector is at</p>
<div class="addr">${escapeHtml(host ?? "(unknown)")}</div>

<h2>Any browser — nothing to install</h2>
<p>Open <a class="big" href="${base}/runner">${escapeHtml(host ?? "")}/runner</a> and leave the page open.
A smart TV's browser, a console, a Chromebook, an old tablet.</p>
<p class="faint">It leaves the shelf when the tab closes, which is deliberate.</p>

<h2>Android, Fire TV, Google TV</h2>
${
  apkHref
    ? `<ol>
<li>Open <b>Downloader</b> (or any browser) on the device.</li>
<li>Go to <b>${escapeHtml(host ?? "")}/get</b> — this page.</li>
<li><a class="big" href="${apkHref}">Download the runner</a> and install it.</li>
<li>The address above is already filled in. Press <b>Start</b>.</li>
</ol>`
    : `<p class="faint">No runner build has been published to this collector yet, so there is
nothing to download here. Build one and upload it, or install from a checkout with
<code>runner-android/enroll.sh</code>.</p>`
}

<h2>Everything else</h2>
<p class="faint">
iPhone and Apple TV install from Xcode or TestFlight; a Roku sideloads its channel with
<code>runner-roku/build.sh</code>; a laptop or desktop runs <code>fleet join ${escapeHtml(host ? `http://${host}` : "&lt;this address&gt;")}</code>.
Full instructions are on the dashboard at <a href="${base}/dash/devices/new">/dash/devices/new</a>.
</p>
</body></html>
`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
