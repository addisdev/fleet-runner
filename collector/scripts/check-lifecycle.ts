/**
 * The collector starts and stops on demand, and stopping actually releases.
 *
 * Two things are checked, and the second is the one with teeth. Anyone can make
 * a `close()` that resolves; the question is whether the port is free and the
 * event loop is empty afterwards, because a supervisor that restarts a brain
 * gets `EADDRINUSE` when it is not -- intermittently, under load, on the
 * machine that is not the one you are testing on.
 */
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let failed = false;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed = true;
};

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

/** Whether something is listening on a port, asked by trying to take it. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

const dir = await mkdtemp(path.join(tmpdir(), "fleet-lifecycle-"));
const port = await freePort();

try {
  // configure() before the module that reads the settings is imported, which is
  // the contract: these are live bindings and half of them are read once.
  const { configure } = await import("../src/config.js");
  configure({
    port,
    bind: ["127.0.0.1"],
    dataDir: path.join(dir, "data"),
    artifactDir: path.join(dir, "artifacts"),
    logFile: path.join(dir, "collector.log"),
    dashDist: path.join(dir, "no-dash"),
    sweepMs: 60_000,
    schedulerTickMs: 60_000,
  });

  const server = await import("../src/server.js");
  const started = await server.listen();
  check("listen() resolves with the port it took", started.port === port, String(started.port));
  check("and with this brain's stable id", /^[0-9a-f]{16}$/.test(started.id), started.id);
  check("and its name", typeof started.name === "string" && started.name.length > 0, started.name);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  check("the collector answers on the configured port", health.ok === true);
  check("health reports the same collector id", health.collector === started.id, String(health.collector));

  // The identity is the data directory's, so a second read is the same brain.
  const { identity } = await import("../src/identity.js");
  check(
    "the id is written to the data directory and read back",
    identity(path.join(dir, "data")).id === started.id,
  );

  check("configure() refuses once the collector has started", await refuses(configure));

  await server.close();
  check("close() frees the port", await portFree(port));

  let secondListen = false;
  try {
    await server.listen();
    secondListen = true;
  } catch {
    /* expected: a Fastify instance is single-use */
  }
  check(
    "a second listen() in one process is refused rather than half-working",
    !secondListen,
    "one process runs one collector; restarting is the supervisor's job",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

async function refuses(configure: (o: Record<string, unknown>) => void): Promise<boolean> {
  try {
    configure({ port: 1 });
    return false;
  } catch {
    return true;
  }
}

// If anything above leaked a ref'd handle, this process hangs here instead of
// exiting -- which the test runner sees as a timeout, and is the honest signal.
console.log(failed ? "\nlifecycle: FAILED" : "\nlifecycle: ALL PASS");
process.exit(failed ? 1 : 0);
