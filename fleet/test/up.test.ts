/**
 * `fleet up`, end to end, against a throwaway everything.
 *
 * This is the test the whole package exists to make possible, and it is
 * deliberately not a unit test: it spawns the real CLI, which supervises the
 * real collector and the real machine agent, enqueues a real job, and waits for
 * a real result row. Everything below the CLI is the code that was already
 * shipping; what is under test is that `fleet` wires it together.
 *
 * Three things it is careful about, each of which has already gone wrong here:
 *
 * - **Its own FLEET_HOME.** Otherwise it would write into the developer's, and
 *   an agent registering into somebody's real fleet from a test suite is the
 *   sort of thing that produces a benchmark row nobody can explain.
 * - **A port the kernel just handed out.** A hard-coded one collides with the
 *   collector this machine is probably already running. That is not
 *   hypothetical: an earlier run of this took port 8899 and found a completely
 *   unrelated service already there, which returned 401 to everything and made
 *   the agent look broken.
 * - **A real shutdown at the end.** A test that leaks a supervised collector
 *   leaves three processes and a held port behind for every later test in the
 *   file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CLI = path.join(ROOT, "fleet/src/cli.ts");

/**
 * The components run from their own directories, so their dependencies have to
 * be installed. In a fresh clone that has only run `npm install` in fleet/, they
 * are not -- and a test that failed for that reason would be reporting on the
 * checkout rather than on the code.
 */
const ready =
  existsSync(path.join(ROOT, "collector/node_modules/tsx")) &&
  existsSync(path.join(ROOT, "runner-machine/node_modules"));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "string" || addr === null) return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns something truthy, or give up with a useful message. */
async function until<T>(what: string, ms: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const got = await fn();
      if (got) return got;
    } catch (e) {
      last = e;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
}

test("fleet up runs a brain and an agent, and a job goes through both", { timeout: 180_000, skip: ready ? false : "collector/ and runner-machine/ dependencies are not installed" }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "fleet-up-test-"));
  const port = await freePort();
  let child: ChildProcess | null = null;

  try {
    child = spawn(
      process.execPath,
      [path.join(ROOT, "collector/node_modules/tsx/dist/cli.mjs"), CLI, "up", "--role", "brain,agent", "--port", String(port)],
      {
        env: { ...process.env, FLEET_HOME: home },
        cwd: path.join(ROOT, "fleet"),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));

    const base = `http://127.0.0.1:${port}`;

    const health = await until("the brain to answer", 60_000, async () => {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    });
    assert.equal(health.ok, true);
    // The stable identity, which is what makes a brain nameable across restarts
    // and is the thing a second brain would have to differ in.
    assert.match(String(health.collector), /^[0-9a-f]{16}$/);
    assert.ok(String(health.name).length > 0);

    // The agent should register itself, without anyone configuring a URL: an
    // agent with no collectors listed points at this machine's own brain.
    const device = await until("the agent to register", 60_000, async () => {
      const res = await fetch(`${base}/api/devices`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { devices: { device_id: string; descriptor: Record<string, unknown> }[] };
      return body.devices[0] ?? null;
    });
    assert.match(device.device_id, /^machine-/);
    assert.equal(device.descriptor.platform, process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");

    // The synthetic backend, which needs nothing installed and is the one every
    // runner in the fleet implements identically.
    const enqueue = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: 1,
        job_id: "fleet-up-test",
        workload: "benchmark",
        executor: "device",
        backend: "synthetic",
        params: { prompt_tokens: 64, gen_tokens: 16, warmup_iters: 0, measure_iters: 1 },
        targets: { device_id: device.device_id },
      }),
    });
    assert.equal(enqueue.status, 201, await enqueue.text());

    const finished = await until("the job to finish", 90_000, async () => {
      const res = await fetch(`${base}/jobs/fleet-up-test`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { status: string; last_error?: string };
      return body.status === "done" || body.status === "failed" ? body : null;
    });
    assert.equal(finished.status, "done", `job failed: ${finished.last_error ?? "(no reason given)"}\n${output}`);

    // And the row is real, with the digest that proves the arithmetic was the
    // fleet's rather than merely fast.
    const results = (await fetch(`${base}/api/results?job=fleet-up-test`).then((r) => r.json())) as {
      results: { final?: boolean; metrics?: Record<string, unknown> }[];
    };
    const final = results.results.find((r) => r.final);
    assert.ok(final, "there is a final result row");
    assert.ok(typeof final.metrics?.decode_tok_s === "number");
    assert.match(String(final.metrics?.synthetic_digest), /^[0-9a-f]{64}$/);

    // Each component wrote its own log, which is where `fleet service logs`
    // looks and the only place a crashed child's reason ever appears.
    for (const name of ["brain", "agent"]) {
      const log = path.join(home, "logs", `${name}.log`);
      assert.ok(existsSync(log), `${name}.log exists`);
      assert.ok(readFileSync(log, "utf8").length > 0, `${name}.log has something in it`);
    }
  } finally {
    if (child) {
      const exited = new Promise<void>((r) => child?.once("exit", () => r()));
      child.kill("SIGTERM");
      // If it does not go, the next test in this file inherits a held port,
      // which is a failure that reads as unrelated.
      await Promise.race([exited, sleep(15_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(home, { recursive: true, force: true });
  }

  // The port is free afterwards, which is the property `fleet service restart`
  // depends on and the one a leaked child silently breaks.
  const free = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
  assert.equal(free, true, "the collector released its port on SIGTERM");
});
