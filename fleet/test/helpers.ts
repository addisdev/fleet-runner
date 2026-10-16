/**
 * A real collector for the tests, and a device that does what it is told.
 *
 * The MCP server and the CLI are thin layers over /api/v1, so the honest test
 * of them is against the API itself: a stub would only prove they agree with
 * the stub. Each test file starts one collector on a temp data directory and
 * a free port, and stops it after.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FLEET = path.resolve(HERE, "..");
export const COLLECTOR = path.resolve(FLEET, "../collector");
export const TSX = path.join(COLLECTOR, "node_modules/tsx/dist/cli.mjs");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (!a || typeof a === "string") return reject(new Error("no port"));
      srv.close(() => resolve(a.port));
    });
  });
}

export type Collector = { base: string; dir: string; log: () => string; stop: () => Promise<void> };

export async function startCollector(env: Record<string, string> = {}): Promise<Collector> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-cli-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const child: ChildProcess = spawn(process.execPath, [TSX, "src/server.ts"], {
    cwd: COLLECTOR,
    env: {
      ...process.env,
      FLEET_PORT: String(port),
      FLEET_BIND: "127.0.0.1",
      FLEET_DATA_DIR: path.join(dir, "data"),
      FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
      FLEET_LOG_FILE: path.join(dir, "collector.log"),
      FLEET_SWEEP_MS: "60000",
      FLEET_SCHEDULER_TICK_MS: "60000",
      FLEET_DISCOVERY: "0",
      FLEET_URL: "",
      FLEET_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`collector exited ${child.exitCode}\n${log}`);
    try {
      if ((await fetch(`${base}/api/v1/health`)).ok) break;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`collector did not start\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    dir,
    log: () => log,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once("exit", () => r()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      // Windows can hold fleet.db for a moment after the process exits, and the
      // unlink fails with EBUSY (seen in CI); retry, and never fail a test over
      // a temp directory.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { /* left for the OS to clear */ }
    },
  };
}

type Payload = Record<string, unknown>;

/**
 * A device that registers, claims whatever it is offered, and reports what
 * `answer` says. Stops when `stop()` is called.
 */
export async function fakeDevice(
  base: string,
  id: string,
  opts: { token?: string; capabilities?: string[]; pools?: string[]; answer?: (job: Payload) => Payload } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const reg = await fetch(`${base}/devices/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      device_id: id,
      descriptor: { model: "Test Phone", os: "Android 15", platform: "android", kind: "phone" },
      pools: opts.pools ?? ["test"],
      capabilities: opts.capabilities ?? ["benchmark"],
    }),
  });
  if (!reg.ok) throw new Error(`register ${reg.status}`);
  const abort = new AbortController();
  const claimed: string[] = [];
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let res: Response;
      try {
        res = await fetch(`${base}/devices/${id}/next-job`, { headers, signal: abort.signal });
      } catch {
        return;
      }
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      const job = (await res.json()) as Payload;
      claimed.push(String(job.job_id));
      const answer = opts.answer?.(job) ?? { ok: true, metrics: { decode_tps: 10 } };
      await fetch(`${base}/results`, {
        method: "POST",
        headers,
        body: JSON.stringify({ schema: 1, kind: "result", job_id: job.job_id, device_id: id, iter: 0, final: true, ...answer }),
      });
    }
  })();
  return {
    claimed,
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}

/** A 1x1 PNG. */
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

export async function upload(base: string, bytes: Buffer | string, name: string, token?: string): Promise<string> {
  const res = await fetch(`${base}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": name, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: new Uint8Array(Buffer.from(bytes)),
  });
  return ((await res.json()) as { sha256: string }).sha256;
}

export const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
