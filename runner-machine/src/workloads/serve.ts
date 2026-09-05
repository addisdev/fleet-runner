/**
 * The `serve` workload: hold an inference server up for the length of a lease,
 * announce where it is, and take it down again — always.
 *
 * Two things dominate the design.
 *
 * 1. **Teardown on every exit path.** `llama-server` holds the whole model
 *    resident; a leaked one costs gigabytes on a machine that will go on
 *    claiming other jobs, and nothing on the dashboard would ever say so. So
 *    the supervision loop is a `try/finally` around a teardown that runs once
 *    and runs for all five endings: the duration elapsing, `lease_renewed:
 *    false`, a dashboard cancel, the child dying on its own, and an uncaught
 *    throw anywhere in the loop.
 * 2. **Never `0.0.0.0`.** The collector's README says it outright: there is no
 *    authentication anywhere in this system, the network IS the access
 *    control, and the posture holds only while every participant is on a
 *    network the owner chose. A model server bound to every interface on a
 *    laptop is an open inference endpoint on whatever hotel wifi that laptop
 *    joins next. Loopback and the tailnet address are the two answers, which
 *    is the same choice `FLEET_BIND` gives the collector itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, intParam, stringParam } from "../protocol.js";
import { beacon } from "../telemetry.js";
import { which } from "../probe.js";
import { dataDir } from "../git.js";
import { fileMatchesHash } from "../collector.js";
import * as JobCancellation from "../cancellation.js";

/** The beacon cadence the task asks for, and the lease renewal with it. */
export const SERVE_BEACON_MS = 30_000;
/** A serve with no duration still ends: an unbounded one is a leak with a lease on it. */
export const DEFAULT_DURATION_S = 30 * 60;
/** How long a model has to load before "serving" stops being a plausible claim. */
export const DEFAULT_READY_TIMEOUT_S = 300;
/** Grace between SIGTERM and SIGKILL. llama-server frees its weights on SIGTERM. */
export const KILL_GRACE_MS = 5_000;

// --- binding ----------------------------------------------------------------

/** Tailscale hands out 100.64.0.0/10. That range is the tailnet and nothing else is. */
export function isTailnetV4(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr);
  if (!m) return false;
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** This machine's tailnet address, or null when it is not on one. */
export function tailnetAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isTailnetV4(a.address)) return a.address;
    }
  }
  return null;
}

/**
 * Where the server may listen.
 *
 * Deliberately a closed set rather than a validated free-form address. A job
 * spec arrives through an unauthenticated `POST /jobs`, so "any address that
 * parses" would let whoever enqueued the job choose to publish this machine's
 * model server on the LAN — and `0.0.0.0` is one keystroke away from every
 * plausible spelling of an address anyway.
 */
export function resolveBindHost(
  param: unknown,
  env: NodeJS.ProcessEnv = process.env,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const want = (typeof param === "string" && param.trim() !== "" ? param : env.FLEET_SERVE_BIND ?? "loopback").trim();
  if (want === "loopback" || want === "127.0.0.1" || want === "localhost") return "127.0.0.1";
  if (want === "tailnet") {
    const addr = tailnetAddress(interfaces);
    if (!addr) throw new Error("params.bind is 'tailnet' but this machine has no 100.64.0.0/10 address");
    return addr;
  }
  if (isTailnetV4(want)) {
    // An explicit tailnet address still has to be one of THIS machine's, or
    // llama-server would fail to bind and the failure would read as a crash.
    const addr = tailnetAddress(interfaces);
    if (addr !== want) throw new Error(`params.bind ${want} is not an address on this machine (tailnet address is ${addr ?? "absent"})`);
    return want;
  }
  throw new Error(
    `params.bind must be 'loopback' or 'tailnet' (got ${JSON.stringify(want)}). ` +
      "The collector has no authentication and the network is the access control, so a model server is never bound to a wildcard or to the LAN.",
  );
}

/** A port nothing is listening on, on the address the server will bind. */
export function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen({ host, port: 0, exclusive: true }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("could not find a free port"))));
    });
  });
}

// --- supervision ------------------------------------------------------------

export type ServeStop = "duration" | "lease" | "cancelled" | "child-exit" | "error";
export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
export type ServeOutcome = {
  stop: ServeStop;
  error?: string;
  exit?: ChildExit;
  /** Proof the teardown ran. Asserted by the tests for every stop reason. */
  toreDown: boolean;
  elapsedMs: number;
};

/**
 * Runs the server for its duration, ticking a beacon, and tears it down.
 *
 * Everything is injected so the five endings can be tested without a model
 * server: `exited` is the child's close event, `tick` is the beacon (it names
 * the reason to stop, or null to keep going), and `teardown` is the kill. The
 * `finally` is the point of the whole function — a throw from `tick` must
 * still stop a process holding eight gigabytes of weights.
 */
export async function superviseServe(deps: {
  exited: Promise<ChildExit>;
  teardown: () => Promise<void> | void;
  tick: () => Promise<"lease" | "cancelled" | null>;
  tickMs: number;
  durationMs: number;
  now?: () => number;
}): Promise<ServeOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + deps.durationMs;
  let toreDown = false;
  const teardownOnce = async () => {
    if (toreDown) return;
    toreDown = true;
    await deps.teardown();
  };

  let stop: ServeStop = "duration";
  let error: string | undefined;
  let exit: ChildExit | undefined;

  try {
    const exitedTagged = deps.exited.then((e) => ({ kind: "exit" as const, exit: e }));
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        stop = "duration";
        break;
      }
      const raced = await Promise.race([
        exitedTagged,
        delay(Math.min(deps.tickMs, remaining)).then(() => ({ kind: "tick" as const })),
      ]);
      if (raced.kind === "exit") {
        // The server fell over on its own. That is a failure of the job, not a
        // clean end, and the exit code is what says why.
        stop = "child-exit";
        exit = raced.exit;
        break;
      }
      const reason = await deps.tick();
      if (reason !== null) {
        stop = reason;
        break;
      }
    }
  } catch (e) {
    stop = "error";
    error = (e as Error).message ?? String(e);
  } finally {
    await teardownOnce();
  }

  return { stop, error, exit, toreDown, elapsedMs: now() - started };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    // Unref'd: a pending tick timer must never be the reason this process
    // outlives the job it was serving.
    t.unref?.();
  });
}

// --- the workload -----------------------------------------------------------

export async function runServe(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (m: string) => console.log(`[${deviceId}] serve ${job.job_id}: ${m}`);
  const fail = async (error: string, metrics?: Metrics) => {
    log(`failed: ${error}`);
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor, error,
      ...(metrics ? { metrics } : {}),
    });
  };

  const server = await which(env.FLEET_LLAMA_SERVER ?? "llama-server", env);
  if (!server) return fail("serve needs llama-server on PATH (or FLEET_LLAMA_SERVER)");

  const sha = job.model?.sha256 ?? stringParam(job.params, "model_sha256");
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) {
    return fail("serve needs a model artifact: job.model.sha256 or params.model_sha256");
  }

  let host: string;
  try {
    host = resolveBindHost(job.params?.bind, env);
  } catch (e) {
    return fail((e as Error).message);
  }

  const modelFile = path.join(dataDir(env), "models", `${sha.toLowerCase()}.gguf`);
  try {
    if (!(await fileMatchesHash(modelFile, sha.toLowerCase()))) {
      log(`fetching model ${sha.slice(0, 12)}`);
      await client.fetchArtifact(sha.toLowerCase(), modelFile);
    }
  } catch (e) {
    return fail(`fetching the model failed: ${(e as Error).message}`);
  }

  const durationS = intParam(job.params, "duration_s", DEFAULT_DURATION_S);
  const readyTimeoutS = intParam(job.params, "ready_timeout_s", DEFAULT_READY_TIMEOUT_S);
  let port: number;
  try {
    port = intParam(job.params, "port", 0) || (await freePort(host));
  } catch (e) {
    return fail(`no free port on ${host}: ${(e as Error).message}`);
  }
  const endpoint = `http://${host}:${port}`;

  const extra = Array.isArray(job.params?.args)
    ? (job.params.args as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const child = spawn(server, ["-m", modelFile, "--host", host, "--port", String(port), ...extra], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TERM: "dumb" },
  });
  let stderrTail = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString("utf8")).slice(-4000);
  });

  const exited = new Promise<ChildExit>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  let childGone = false;
  void exited.then(() => (childGone = true));

  const teardown = async () => {
    if (childGone) return;
    log("stopping llama-server");
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await Promise.race([exited, delay(KILL_GRACE_MS)]);
    if (!childGone) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([exited, delay(KILL_GRACE_MS)]);
    }
  };

  // From here every path goes through the finally, including a throw.
  try {
    const ready = await waitForReady(endpoint, readyTimeoutS * 1000, exited);
    if (!ready.ok) {
      await teardown();
      return fail(
        `llama-server did not answer on ${endpoint} within ${readyTimeoutS}s: ${ready.detail || lastLine(stderrTail) || "no output"}`,
      );
    }
    log(`serving ${sha.slice(0, 12)} on ${endpoint} for ${durationS}s (pid ${child.pid})`);

    // The announcement, immediately — a serve nobody can find is a serve that
    // did not happen, and a dependent job may be waiting on this row.
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 1, ok: true, endpoint,
    });

    const outcome = await superviseServe({
      exited,
      teardown,
      tickMs: SERVE_BEACON_MS,
      durationMs: durationS * 1000,
      tick: async () => {
        if (JobCancellation.isCancelled(job.job_id)) return "cancelled";
        try {
          const renewed = await client.postBeacon({
            schema: SCHEMA, kind: "beacon", job_id: job.job_id, device_id: deviceId,
            beacon: await beacon(), endpoint,
          });
          if (!renewed) {
            JobCancellation.cancel(job.job_id);
            return "lease";
          }
        } catch {
          // An unreachable collector is not a cancellation, exactly as in the
          // build workload: the lease may lapse, but a flaky network must not
          // be what takes a served model down.
        }
        return null;
      },
    });

    const elapsedS = Math.round(outcome.elapsedMs / 100) / 10;
    if (outcome.stop === "duration") {
      log(`duration elapsed after ${elapsedS}s`);
      await client.postResult({
        schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
        iter: 0, final: true, ok: true, device: descriptor, endpoint,
        metrics: compact<Metrics>({ elapsed_s: elapsedS }),
      });
      return;
    }
    if (outcome.stop === "child-exit") {
      return fail(
        `llama-server exited on its own after ${elapsedS}s (${outcome.exit?.code !== null && outcome.exit?.code !== undefined ? `exit ${outcome.exit.code}` : `signal ${outcome.exit?.signal ?? "?"}`}): ${lastLine(stderrTail) || "no output"}`,
        compact<Metrics>({ elapsed_s: elapsedS, exit_code: outcome.exit?.code ?? undefined }),
      );
    }
    return fail(
      outcome.stop === "error"
        ? `serve supervision failed: ${outcome.error}`
        : outcome.stop === "lease"
          ? "lease not renewed"
          : "cancelled",
      compact<Metrics>({ elapsed_s: elapsedS }),
    );
  } finally {
    // Belt and braces over superviseServe's own finally: a throw between the
    // spawn and the supervision — a failed announcement post, say — must not
    // leave a model server running.
    await teardown();
  }
}

/** Polls the server's own health endpoint, giving up if the child dies first. */
async function waitForReady(
  endpoint: string,
  timeoutMs: number,
  exited: Promise<ChildExit>,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  void exited.then(() => (dead = true));
  let detail = "";
  while (Date.now() < deadline) {
    if (dead) return { ok: false, detail: "the process exited before it answered" };
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
      // llama-server answers 503 while the model loads and 200 once it can
      // serve, so only 200 is ready; anything else is another second of wait.
      if (res.ok) return { ok: true, detail: "" };
      detail = `HTTP ${res.status}`;
    } catch (e) {
      detail = (e as Error).message;
    }
    await delay(1000);
  }
  return { ok: false, detail };
}

const lastLine = (s: string): string =>
  s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";

/**
 * Is a pid still there? Used by the end-to-end check that a cancelled serve
 * actually took its child with it, rather than assuming the kill landed.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
