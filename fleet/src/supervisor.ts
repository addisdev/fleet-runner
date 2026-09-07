/**
 * Keeps the components running, and stops pretending when one of them cannot.
 *
 * ## Why not just launchd and systemd
 *
 * Because they do the easy nine tenths and the tenth is the one that matters.
 * `KeepAlive` restarts a crashed process, which is right, and it restarts a
 * process that crashes on startup every ten seconds forever, which is not --
 * a collector with a bad `FLEET_BIND`, or an agent pointed at a brain that is
 * not there, comes back up, fails, and comes back up, indefinitely, writing a
 * stack trace into an unrotated log file. From outside, that is indistinguishable
 * from a fleet that is working. The deploy documentation's own warning list
 * says "logs are not rotated" and "check its size occasionally", which is a
 * task nobody has ever done.
 *
 * So this supervises. It restarts with a backoff, it rotates, and after enough
 * failures in a short enough window it **stops trying and says so** -- because
 * a component that is down and reported is a problem somebody fixes in five
 * minutes, and one that is crash-looping quietly is a problem somebody finds in
 * a fortnight.
 *
 * The service manager still supervises this process, which is the right
 * division: launchd is very good at "start it at login and restart it if it
 * dies", and this is very good at knowing what its three children are for.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";

/** Roughly a fortnight of an idle collector's request logging. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_ROTATIONS = 3;

/**
 * How fast a restart may be retried, and where it gives up.
 *
 * The window matters as much as the count: a component that has run for an hour
 * and then dies is not crash-looping, it hit something, and it should be
 * restarted with a clean slate. Only failures close together count towards
 * giving up.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const GIVE_UP_AFTER = 5;
const HEALTHY_AFTER_MS = 60_000;

/**
 * The timings, injectable.
 *
 * Not for tuning -- the defaults are the answer -- but because a supervisor
 * whose backoff is a hard-coded array is a supervisor nobody can test. The
 * production values add up to about a minute of retries before giving up,
 * which is the right amount of patience for a real component and far too much
 * for a test suite that has to prove the giving-up happens at all.
 */
export type Timings = {
  backoffMs: number[];
  giveUpAfter: number;
  healthyAfterMs: number;
};

export const DEFAULT_TIMINGS: Timings = {
  backoffMs: BACKOFF_MS,
  giveUpAfter: GIVE_UP_AFTER,
  healthyAfterMs: HEALTHY_AFTER_MS,
};

export type ChildSpec = {
  /** `brain`, `agent`, `executor` -- used for the log file and the messages. */
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
};

export type ChildState = {
  spec: ChildSpec;
  process: ChildProcess | null;
  restarts: number;
  /** Set when it has given up; the reason a `fleet status` can print. */
  gaveUpAt: Date | null;
  lastExit: { code: number | null; signal: string | null; at: Date } | null;
  startedAt: Date | null;
};

export type Supervisor = {
  children: Map<string, ChildState>;
  /** Resolves when every child has been asked to stop and has gone. */
  stop: () => Promise<void>;
  /** Resolves when every child has given up. Never, if they stay healthy. */
  wait: () => Promise<void>;
};

/**
 * Roll a log file over when it gets big, keeping a few generations.
 *
 * Done at open rather than on a timer, because the alternative -- watching a
 * file while writing to it -- is a race with the writer for no benefit. A
 * component that never restarts never rotates, which is exactly the case where
 * the file is one process's output and can be read as one.
 */
function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_LOG_BYTES) return;
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // A log that cannot be rotated is not a reason to refuse to start the thing
    // whose log it is.
  }
}

function openLog(dir: string, name: string): WriteStream {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  rotate(file);
  return createWriteStream(file, { flags: "a" });
}

/**
 * Start every child and keep them running.
 *
 * `onEvent` is how the caller reports; nothing here writes to stdout directly,
 * so `fleet up` can print a line per event and a desktop app can raise a
 * notification from the same signal.
 */
export function supervise(
  specs: ChildSpec[],
  logDir: string,
  onEvent: (event: { child: string; kind: "start" | "exit" | "gave-up"; detail: string }) => void,
  timings: Timings = DEFAULT_TIMINGS,
): Supervisor {
  const children = new Map<string, ChildState>();
  let stopping = false;
  const gaveUp = new Set<string>();
  let resolveWait: (() => void) | null = null;
  const waiter = new Promise<void>((r) => {
    resolveWait = r;
  });

  for (const spec of specs) {
    children.set(spec.name, { spec, process: null, restarts: 0, gaveUpAt: null, lastExit: null, startedAt: null });
    start(spec.name);
  }

  function start(name: string): void {
    const state = children.get(name);
    if (!state || stopping) return;

    const log = openLog(logDir, name);
    const child = spawn(state.spec.command, state.spec.args, {
      env: state.spec.env,
      cwd: state.spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.process = child;
    state.startedAt = new Date();
    onEvent({ child: name, kind: "start", detail: `pid ${child.pid ?? "?"}` });

    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    child.on("error", (e) => {
      onEvent({ child: name, kind: "exit", detail: `could not be started: ${e.message}` });
    });

    child.on("exit", (code, signal) => {
      log.end();
      state.process = null;
      state.lastExit = { code, signal, at: new Date() };
      if (stopping) return;

      const ranFor = Date.now() - (state.startedAt?.getTime() ?? Date.now());
      // A component that stayed up for a while and then died is not looping.
      // Resetting here is what stops a machine that has been running for a
      // month from giving up on its fifth ever restart.
      if (ranFor > timings.healthyAfterMs) state.restarts = 0;

      state.restarts += 1;
      onEvent({
        child: name,
        kind: "exit",
        detail: `${signal ? `signal ${signal}` : `code ${code}`} after ${Math.round(ranFor / 1000)}s`,
      });

      if (state.restarts > timings.giveUpAfter) {
        state.gaveUpAt = new Date();
        gaveUp.add(name);
        onEvent({
          child: name,
          kind: "gave-up",
          detail:
            `${timings.giveUpAfter} failures in quick succession; not restarting. ` +
            `The reason is in ${path.join(logDir, `${name}.log`)}.`,
        });
        if (gaveUp.size === children.size) resolveWait?.();
        return;
      }

      const delay = timings.backoffMs[Math.min(state.restarts - 1, timings.backoffMs.length - 1)];
      setTimeout(() => start(name), delay).unref();
    });
  }

  return {
    children,
    async stop() {
      stopping = true;
      const alive = [...children.values()].filter((c) => c.process !== null);
      await Promise.all(
        alive.map(
          (c) =>
            new Promise<void>((resolve) => {
              const child = c.process;
              if (!child) return resolve();
              // SIGTERM, then a hard stop. Every component handles SIGTERM by
              // standing down at its next loop boundary, which for a running
              // job means finishing it -- so the grace period is generous, and
              // the kill after it is the honest admission that something is
              // stuck rather than busy.
              const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
              kill.unref();
              child.once("exit", () => {
                clearTimeout(kill);
                resolve();
              });
              child.kill("SIGTERM");
            }),
        ),
      );
    },
    wait: () => waiter,
  };
}
