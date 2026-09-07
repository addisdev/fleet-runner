// Dashboard screenshots, captured against a throwaway collector with real
// agents doing real work.
//
//   npm run shoot:dash
//
// Nothing here is seeded or faked: it starts a collector on a spare port with
// its own data directory, starts the machine agent against it, enqueues the
// same job the getting-started guide tells you to enqueue, and photographs the
// result. The self-check that opens the alert fails honestly — the agent was
// started by hand rather than by launchd, which is exactly what it reports.
//
// What this script must NOT be used for is `results.png`, which shows stored
// llama.cpp history from a real Android phone. A fresh database cannot have
// that, and a throwaway collector would replace real measurements with
// synthetic ones. See docs/brand.md.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const MACHINE = path.resolve(ROOT, "../runner-machine");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
// The documentation site's image tree, not the collector's: mkdocs builds with
// --strict and treats a link that climbs out of docs/ as broken.
const OUT = path.resolve(ROOT, "../docs/img");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (typeof a === "string" || a === null) return reject(new Error("no port"));
      srv.close(() => resolve(a.port));
    });
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "fleet-dash-"));
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
// Every child this script starts, so the finally block can stop exactly these
// and nothing else. Killing by port or by process name would reach whatever
// else on this machine happens to match.
const children: ChildProcess[] = [];

const api = async (p: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${p}`, init);
  if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};

/** Waits for `check` to hold, polling, and gives up rather than hanging CI. */
async function until<T>(what: string, check: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await check().catch(() => null);
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function shoot(page: Page, route: string, name: string) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  // The dashboard renders from its own fetches, not from the document.
  await page.waitForTimeout(1500);
  // Crop to what is actually on the page. These screens are shorter than the
  // viewport, and half an image of empty background reads as an empty product.
  const height = await page.evaluate(() => {
    const foot = document.querySelector("footer") ?? document.body.lastElementChild;
    const bottom = foot ? foot.getBoundingClientRect().bottom + window.scrollY : document.body.scrollHeight;
    return Math.ceil(bottom + 24);
  });
  const target = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: target, clip: { x: 0, y: 0, width: 1440, height: Math.min(height, 900) } });
  console.log(`wrote ${name}.png`);
}

await mkdir(OUT, { recursive: true });

try {
  const collector = spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_DATA_DIR: path.join(dir, "data"),
      FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, "collector.log"),
      FLEET_SCHEDULER_TICK_MS: "60000",
    },
    stdio: "ignore",
  });
  children.push(collector);
  await until("the collector", async () => ((await fetch(`${BASE}/api/health`)).ok ? true : null), 30_000);

  const agent = spawn(process.execPath, [TSX, "src/agent.ts"], {
    cwd: MACHINE,
    env: { ...process.env, FLEET_URL: BASE },
    stdio: "ignore",
  });
  children.push(agent);
  const device = await until("the machine agent to register", async () => {
    const b = await api("/api/devices");
    return b.devices.find((d: any) => d.platform === "macos" || d.platform === "linux") ?? null;
  });
  console.log(`registered: ${device.device_id}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ colorScheme: "dark" });

  // ── 1. the getting-started job, and the screen it tells you to open ──
  //
  // Byte for byte the spec in docs/getting-started.md. If that guide changes,
  // this has to change with it, or the picture stops being of the thing the
  // reader just did.
  await api("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: 1,
      job_id: "hello-fleet",
      workload: "benchmark",
      executor: "device",
      backend: "synthetic",
      params: { prompt_tokens: 256, gen_tokens: 64, warmup_iters: 1, measure_iters: 3 },
      targets: { pool: "machines" },
    }),
  });
  await until("hello-fleet to finish", async () => {
    const j = await api("/jobs/hello-fleet");
    return j.status === "done" ? j : null;
  });
  await shoot(page, "/dash/results", "first-result");

  // ── 2. an alert, opened by a job that genuinely failed ───────────────
  //
  // self-check asks whether the agent is loaded under launchd. This one was
  // started by hand, so it is not, and it says so. That is the same failure
  // the live overview screenshot caught on 2026-09-05.
  await api("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: 1,
      job_id: "self-check-nightly",
      workload: "self-check",
      executor: "device",
      targets: { pool: "machines" },
    }),
  });
  await until("self-check to close", async () => {
    const j = await api("/jobs/self-check-nightly");
    return j.status === "failed" || j.status === "done" ? j : null;
  });
  // The alert engine runs on a timer; ask it now rather than waiting it out.
  await api("/api/alerts/tick", { method: "POST" });
  await shoot(page, "/dash/alerts", "alerts");

  // ── 3. a real visual regression, start to finish ─────────────────────
  //
  // Shoot this project's own built documentation site, accept those shots as
  // the baseline, then serve the same site with a stylesheet change and shoot
  // it again. The divergence on the Visual page is measured from pixels that
  // really differ; nothing about the matrix is seeded.
  const sitePort = await freePort();
  const siteDir = path.resolve(ROOT, "../site");
  if (!existsSync(path.join(siteDir, "index.html"))) {
    throw new Error(`no built docs at ${siteDir} — run: .venv/bin/mkdocs build`);
  }
  // The stylesheet the second run serves instead of the first. Colour only,
  // and deliberately so: captures are full-page, so anything that changes the
  // document's height short-circuits the diff to 100% with a size-changed note
  // rather than measuring drift. A theme colour going wrong is the regression
  // this pipeline is actually good at catching, and it is the one that gets
  // shipped by accident.
  const REGRESSION = `
    :root, [data-md-color-scheme] {
      --md-accent-fg-color: #C2410C !important;
      --md-typeset-a-color: #C2410C !important;
      --md-primary-fg-color: #3A2A18 !important;
    }
    .md-header, .md-tabs { background-color: #3A2A18 !important; }
    .md-typeset a { color: #C2410C !important; }`;
  let regressed = false;

  const site: Server = createHttpServer(async (req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    let file = path.join(siteDir, rel);
    if (rel.endsWith("/")) file = path.join(file, "index.html");
    // Serving only from under siteDir: the same separator rule the executor
    // uses for spec directories, for the same reason.
    if (file !== siteDir && !file.startsWith(siteDir + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      const ext = path.extname(file);
      const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css"
        : ext === ".js" ? "text/javascript" : ext === ".svg" ? "image/svg+xml"
        : ext === ".png" ? "image/png" : ext === ".woff2" ? "font/woff2" : "application/octet-stream";
      if (ext === ".html" && regressed) {
        res.writeHead(200, { "content-type": type });
        res.end(body.toString("utf8").replace("</head>", `<style>${REGRESSION}</style></head>`));
        return;
      }
      res.writeHead(200, { "content-type": type });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => site.listen(sitePort, "127.0.0.1", r));
  const SITE = `http://127.0.0.1:${sitePort}`;

  // The spec that watches this project's own documentation site, committed at
  // examples/web-specs/fleet-docs/. It has to live under the specs directory
  // playwright.config.ts names as its testDir — a manifest anywhere else means
  // `playwright test` finds no tests and every page reports missing.
  const specs = path.join(ROOT, "examples/web-specs");

  const executor = spawn(process.execPath, [TSX, "src/executor.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLEET_URL: BASE,
      FLEET_WEB: "1",
      FLEET_WEB_SPECS_DIR: specs,
      FLEET_EXECUTOR_NAME: "mac-mini",
    },
    stdio: "ignore",
  });
  children.push(executor);

  const shotsJob = async (id: string) => {
    await api("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: 1, job_id: id, workload: "web-shots", executor: "host",
        suite: { kind: "playwright", flows: "fleet-docs" },
        targets: { url: SITE }, lease: { ttl_s: 900 },
      }),
    });
    const done = await until(`${id} to finish`, async () => {
      const j = await api(`/jobs/${id}`);
      return j.status === "done" || j.status === "failed" ? j : null;
    }, 600_000);
    if (done.status === "failed") {
      const rows = await api(`/api/results?job=${id}`);
      for (const r of [rows].flat().flatMap((x: any) => x.results ?? [x]))
        if (r?.error) console.error(`  ${id}: ${r.error}`);
    }
    return done;
  };

  const first = await shotsJob("visual-baseline");
  console.log(`visual-baseline: ${first.status}`);
  const matrix = await api("/api/visual/matrix?suite=fleet-docs");
  if (matrix.cells.length === 0) throw new Error("the first web-shots run captured nothing");
  for (const c of matrix.cells) {
    if (!c.sha256) continue;
    await api("/api/visual/baselines/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suite: "fleet-docs", page: c.page, profile: c.profile, sha256: c.sha256, job_id: "visual-baseline" }),
    });
  }
  console.log(`accepted ${matrix.cells.length} baselines`);

  regressed = true;
  const second = await shotsJob("visual-nightly");
  console.log(`visual-nightly: ${second.status}`);
  await shoot(page, "/dash/visual?suite=fleet-docs", "visual");
  await new Promise<void>((r) => site.close(() => r()));

  await browser.close();
} finally {
  for (const c of children) c.kill("SIGTERM");
  await sleep(1500);
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
}
