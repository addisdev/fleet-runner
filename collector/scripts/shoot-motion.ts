// The dashboard doing its job, as an animated GIF for the README.
//
//   npm run shoot:motion
//
// A queue is a thing that happens over time, and no still shows that. This
// records the Overview while three real agents — the machine agent and two
// browser runners — claim a fan-out benchmark and report back: queued rises,
// running rises, "running now" fills with rows, then done climbs and the rows
// clear.
//
// Everything is real. The agents are the shipping agents, the numbers are
// measured on this machine, and the recording is a screenshot every 250 ms
// rather than a video, so the frames are exactly what a viewer would have seen.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const MACHINE = path.resolve(ROOT, "../runner-machine");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const OUT = path.resolve(ROOT, "../docs/img");

const FPS = 4;
const SECONDS = 18;
const WIDTH = 1280;

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

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "fleet-motion-"));
const frames = path.join(dir, "frames");
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
// Only the children this script started; never a match on a port or a name.
const children: ChildProcess[] = [];
let browser: Browser | undefined;

const api = async (p: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${p}`, init);
  if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};

async function until<T>(what: string, check: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await check().catch(() => null);
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}

await mkdir(frames, { recursive: true });
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

  children.push(spawn(process.execPath, [TSX, "src/agent.ts"], {
    cwd: MACHINE, env: { ...process.env, FLEET_URL: BASE }, stdio: "ignore",
  }));

  browser = await chromium.launch();

  // Two browser runners, in separate contexts so each gets its own device id
  // and the fan-out has somewhere to fan out to.
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const tab = await ctx.newPage();
    await tab.goto(`${BASE}/runner?autostart=1`, { waitUntil: "domcontentloaded" });
  }

  await until("three agents", async () => {
    const b = await api("/api/devices");
    return b.devices.length >= 3 ? b : null;
  });

  const stage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await stage.emulateMedia({ colorScheme: "dark" });
  await stage.goto(`${BASE}/dash`, { waitUntil: "networkidle" });
  await sleep(1500);

  // A fan-out per browser runner, and a synthetic on the machine. Two specs,
  // because a job names one backend and a browser's is not the phone's — see
  // the browser runner's note on why it declares jssha rather than synthetic.
  const enqueue = (body: unknown) =>
    api("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const record = (async () => {
    const total = FPS * SECONDS;
    for (let i = 0; i < total; i++) {
      const started = Date.now();
      await stage.screenshot({ path: path.join(frames, `f${String(i).padStart(4, "0")}.png`) });
      const spent = Date.now() - started;
      await sleep(Math.max(0, 1000 / FPS - spent));
    }
  })();

  await sleep(1200);
  await enqueue({
    schema: 1, job_id: "bench-web", workload: "benchmark", executor: "device", backend: "jssha",
    params: { prompt_tokens: 48, gen_tokens: 16, warmup_iters: 0, measure_iters: 2 },
    targets: { match: "platform == 'web'" }, fanout: true,
  });
  await sleep(400);
  await enqueue({
    schema: 1, job_id: "bench-machine", workload: "benchmark", executor: "device", backend: "synthetic",
    params: { prompt_tokens: 128, gen_tokens: 32, warmup_iters: 0, measure_iters: 2 },
    targets: { pool: "machines" },
  });
  await record;

  const files = (await readdir(frames)).filter((f) => f.endsWith(".png"));
  if (files.length < FPS * SECONDS) throw new Error(`only ${files.length} frames`);

  // Two passes so the palette is built from the whole recording: one built per
  // frame makes the dark background shimmer between frames.
  const palette = path.join(dir, "palette.png");
  const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS),
    "-i", path.join(frames, "f%04d.png"), "-vf", `${vf},palettegen=max_colors=64`, palette]);
  const gif = path.join(OUT, "fanout.gif");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS),
    "-i", path.join(frames, "f%04d.png"), "-i", palette,
    "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, gif]);
  console.log(`wrote fanout.gif from ${files.length} frames`);
} finally {
  await browser?.close();
  for (const c of children) c.kill("SIGTERM");
  await sleep(1500);
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
}
