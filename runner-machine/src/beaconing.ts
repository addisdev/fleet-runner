/**
 * Keeping a lease alive across something slow.
 *
 * `model-convert`, `dataset-prep` and `serve` are all in the collector's
 * LONG_LEASE_WORKLOADS, but a long lease is not a self-renewing one: the lease
 * is renewed by beacons, and the sweep requeues a claim whose beacons stopped.
 * A quantisation that takes forty minutes without a beacon gets swept and run
 * again on another machine, which is the expensive kind of wrong.
 *
 * The `build` workload solved this by tailing its log file, because a compiler
 * emits a log worth showing. These two do not: one is a child process that
 * prints little, the other is ten thousand tiny image resizes. So the shape
 * here is a ticker rather than a tail.
 *
 * Both helpers treat the collector's answers exactly as build does. Only an
 * explicit `lease_renewed: false` stops the work — an unreachable collector
 * throws and is swallowed, because a flaky network must never be what kills a
 * multi-gigabyte conversion.
 */
import { spawn } from "node:child_process";
import type { CollectorClient } from "./collector.js";
import { SCHEMA } from "./protocol.js";
import { beacon } from "./telemetry.js";
import * as JobCancellation from "./cancellation.js";

export const BEACON_MS = 30_000;
/** Kept of a child's output. Enough to name a failure; not enough to grow unbounded. */
export const MAX_OUTPUT_BYTES = 1 << 20;

/**
 * A rate-limited beacon that can be called from inside any loop.
 *
 * `maybe()` is cheap when it is not yet time, so it can go at the top of a
 * per-image loop without anyone having to reason about how often that runs.
 */
export class Beaconer {
  private last = Date.now();

  constructor(
    private readonly client: CollectorClient,
    private readonly deviceId: string,
    private readonly jobId: string,
    private readonly intervalMs: number = BEACON_MS,
  ) {}

  /** False means stop: the claim is gone, or the job was cancelled. */
  async maybe(now: number = Date.now()): Promise<boolean> {
    if (JobCancellation.isCancelled(this.jobId)) return false;
    if (now - this.last < this.intervalMs) return true;
    this.last = now;
    try {
      const renewed = await this.client.postBeacon({
        schema: SCHEMA, kind: "beacon", job_id: this.jobId, device_id: this.deviceId, beacon: await beacon(),
      });
      if (!renewed) {
        JobCancellation.cancel(this.jobId);
        return false;
      }
    } catch {
      // Not a cancellation.
    }
    return true;
  }
}

export type ChildOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout and stderr, merged, bounded, in the order they arrived. */
  output: string;
  cancelled: boolean;
  timedOut: boolean;
  spawnError: string | null;
};

/**
 * Runs one long child process, beaconing while it works.
 *
 * Merged stdio for the same reason the build workload merges it: a converter's
 * progress goes to stdout and its traceback to stderr, and reading them apart
 * loses which came first, which is the only thing that makes a traceback
 * attributable to a step.
 */
export function runWithBeacons(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  jobId: string;
  deviceId: string;
  client: CollectorClient;
  onTick?: (output: string) => void;
}): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    let output = "";
    let bytes = 0;
    let cancelled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let finished = false;

    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? { ...process.env, TERM: "dumb", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const absorb = (b: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      bytes += b.length;
      output += b.toString("utf8");
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    const killer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    const ticker = setInterval(() => {
      void (async () => {
        opts.onTick?.(output);
        if (JobCancellation.isCancelled(opts.jobId) && !cancelled) {
          cancelled = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
          return;
        }
        try {
          const renewed = await opts.client.postBeacon({
            schema: SCHEMA, kind: "beacon", job_id: opts.jobId, device_id: opts.deviceId, beacon: await beacon(),
          });
          if (!renewed && !cancelled) {
            cancelled = true;
            JobCancellation.cancel(opts.jobId);
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
          }
        } catch {
          // An unreachable collector is not a cancellation.
        }
      })();
    }, BEACON_MS);
    ticker.unref?.();

    const done = (code: number | null, signal: NodeJS.Signals | null) => {
      finished = true;
      clearTimeout(killer);
      clearInterval(ticker);
      resolve({ code, signal, output, cancelled, timedOut, spawnError });
    };
    child.on("error", (e) => {
      spawnError = e.message;
      done(null, null);
    });
    child.on("close", (code, signal) => done(code, signal));
  });
}

/** The line of a child's output that says what went wrong, for an error row. */
export function lastMeaningful(output: string, max = 300): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // A python traceback's last line is the exception, which is the answer; a
  // shell tool's last line is usually its error too.
  const line = lines.at(-1) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
