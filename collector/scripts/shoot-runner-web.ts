// A screenshot of the browser runner, taken against a throwaway collector with
// a real job running, for docs/img.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "/Users/addisdev/Desktop/Fleet Runner/fleet-runner/.claude/worktrees/waves-4-8/collector";
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const OUT = path.join(ROOT, "docs/img");

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

const dir = await mkdtemp(path.join(tmpdir(), "fleet-shot-"));
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
await mkdir(OUT, { recursive: true });

try {
  server = spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env, FLEET_PORT: String(port),
      FLEET_DATA_DIR: path.join(dir, "data"), FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, "c.log"), FLEET_SWEEP_MS: "60000", FLEET_SCHEDULER_TICK_MS: "60000",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await sleep(300);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 780 }, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/runner?autostart=1`, { waitUntil: "domcontentloaded" });

  // Wait for it to register, then give it a job so the log has something in it.
  let dev: any = null;
  for (let i = 0; i < 60 && !dev; i++) {
    const b = await (await fetch(`${BASE}/api/devices`)).json() as any;
    dev = b.devices.find((d: any) => d.platform === "web") ?? null;
    if (!dev) await sleep(500);
  }
  await fetch(`${BASE}/jobs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema: 1, job_id: `shot-${Date.now().toString(36)}`, workload: "benchmark",
      executor: "device", backend: "jssha",
      params: { prompt_tokens: 6, gen_tokens: 3, warmup_iters: 0, measure_iters: 3 },
      targets: { device_id: dev.device_id },
    }),
  });
  await sleep(9000);

  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: path.join(OUT, "runner-web.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(OUT, "runner-web-dark.png") });
  console.log("wrote", path.join(OUT, "runner-web.png"));
  await browser.close();
} finally {
  server?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
