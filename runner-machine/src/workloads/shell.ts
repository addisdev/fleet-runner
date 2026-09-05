/**
 * The `shell` workload: run a script that is an artifact — and only one the
 * machine's owner listed by hash.
 *
 * `POST /jobs` on the collector is unauthenticated by design, and so is
 * `POST /artifacts`. That means anyone who can reach the collector can upload
 * a script AND enqueue a job naming it, so this workload's allowlist is not
 * defence in depth: it is the entire trust boundary, and every other property
 * here follows from that.
 *
 * The order matters more than anything else in the file. The sha is checked
 * against the allowlist BEFORE the artifact is fetched. Checking after the
 * download would mean an attacker-supplied file had already been written to
 * this machine's disk under a name of their choosing, and "we deleted it
 * again" is not a defence anybody would accept.
 *
 * The other three, in the order they bite:
 *   - a refusal is a result row, never a throw. A job that vanished with a
 *     stack trace tells the operator nothing about WHY it was refused, and the
 *     refusal reason is the only feedback loop the allowlist has.
 *   - a fresh temp dir and a minimal environment. The agent's own process env
 *     holds FLEET_DASH_TOKEN and a GitHub token; handing those to a script
 *     would make the allowlist the only thing between a job and this machine's
 *     credentials, and there is no reason to make the allowlist carry that too.
 *   - `exit_code` as its own metric. A script that deliberately exits 3 and one
 *     that could not start are both "not zero" and they are not the same event;
 *     an alert rule needs to be able to tell them apart without parsing prose.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, intParam, stringParam } from "../protocol.js";
import { isAllowlisted, loadAllowlist, SHA256_RE } from "../allowlist.js";
import { redact, secretsFromEnv } from "../redact.js";
import * as JobCancellation from "../cancellation.js";

/** A script that has not finished in an hour is a script that is not going to. */
export const DEFAULT_TIMEOUT_S = 3600;
/** What is kept of the output. Enough to diagnose; not enough to exhaust memory. */
export const MAX_CAPTURE_BYTES = 4 << 20;

/**
 * The environment a script gets.
 *
 * An allowlist entry says "this exact script may run here"; it does not say
 * "this script may read every credential this agent holds". PATH, HOME and
 * TMPDIR are what a script needs to be a script at all, and HOME points at the
 * job's own temp dir so a script writing a dotfile does not write it into the
 * operator's.
 */
export function minimalEnv(
  workDir: string,
  job: JobSpec,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: workDir,
    TMPDIR: workDir,
    PWD: workDir,
    LANG: env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    FLEET_JOB_ID: job.job_id,
  };
  // Job-supplied variables, which are the only way a script is parameterised —
  // and they are strings from a job spec, so a name that could shadow PATH or
  // reintroduce a credential name is dropped rather than sanitised.
  const extra = job.params?.env;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (k in base) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") base[k] = String(v);
    }
  }
  return base;
}

export async function runShell(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (m: string) => console.log(`[${deviceId}] shell ${job.job_id}: ${m}`);
  const post = async (ok: boolean, error?: string, metrics?: Metrics, artifacts?: string[]) => {
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok, device: descriptor,
      ...(error ? { error } : {}),
      ...(metrics ? { metrics } : {}),
      ...(artifacts?.length ? { artifacts } : {}),
    });
  };
  /** Every refusal is a row, never a throw. */
  const refuse = async (reason: string) => {
    log(`refused: ${reason}`);
    await post(false, reason);
  };

  const requested = stringParam(job.params, "sha256") ?? job.model?.sha256;
  if (!requested) return refuse("shell needs params.sha256: the sha256 of an allowlisted script artifact");

  // --- the gate. Nothing is fetched above this line. ------------------------
  const list = await loadAllowlist(env);
  if (!list.exists) {
    return refuse(`shell is refused: this machine has no allowlist at ${list.file}`);
  }
  if (list.allowed.length === 0) {
    return refuse(`shell is refused: the allowlist at ${list.file} lists no script hashes`);
  }
  if (!isAllowlisted(requested, list.allowed)) {
    const shape = SHA256_RE.test(requested.trim().toLowerCase()) ? "" : " (which is not a sha256)";
    return refuse(
      `shell is refused: ${requested.slice(0, 80)}${shape} is not in ${list.file}` +
        (list.rejected.length ? `. Note that ${list.rejected.length} line(s) in that file are not sha256s and were ignored` : ""),
    );
  }
  const sha = requested.trim().toLowerCase();
  log(`${sha.slice(0, 12)} is allowlisted; fetching`);

  // --- from here it is a script the owner vouched for ----------------------
  const workDir = await mkdtemp(path.join(os.tmpdir(), `fleet-shell-${safe(job.job_id)}-`));
  const secrets = secretsFromEnv(env);
  try {
    const script = path.join(workDir, "script");
    try {
      await client.fetchArtifact(sha, script);
    } catch (e) {
      return post(false, `fetching the script failed: ${(e as Error).message}`);
    }
    await chmod(script, 0o700);

    const interpreter = stringParam(job.params, "interpreter") ?? "/bin/sh";
    const args = Array.isArray(job.params?.args)
      ? (job.params.args as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    const timeoutMs = intParam(job.params, "timeout_s", DEFAULT_TIMEOUT_S) * 1000;

    const started = Date.now();
    const outcome = await spawnCapturing(interpreter, [script, ...args], workDir, minimalEnv(workDir, job, env), timeoutMs, job.job_id);
    const elapsedS = Math.round((Date.now() - started) / 100) / 10;

    // Redacted before it is written anywhere, not before it is uploaded: the
    // file on disk is in a temp dir this job owns, but the habit of scrubbing
    // at the boundary is what stops the next change from leaking.
    const captured = redact(outcome.output, secrets);
    const logFile = path.join(workDir, "output.txt");
    await writeFile(logFile, captured, "utf8");
    let logRef: string | null = null;
    try {
      const up = await client.uploadArtifact(logFile, `${safe(job.job_id)}-shell.txt`);
      logRef = up.sha256;
    } catch (e) {
      log(`output upload failed: ${(e as Error).message}`);
    }

    if (outcome.spawnError) {
      // Could not start. Deliberately NO exit_code: there was no exit.
      return post(
        false,
        `could not run ${interpreter}: ${outcome.spawnError}`,
        compact<Metrics>({ elapsed_s: elapsedS }),
        logRef ? [logRef] : undefined,
      );
    }
    const metrics = compact<Metrics>({ exit_code: outcome.code ?? undefined, elapsed_s: elapsedS });
    if (outcome.timedOut) {
      return post(false, `script timed out after ${Math.round(timeoutMs / 1000)}s`, metrics, logRef ? [logRef] : undefined);
    }
    if (outcome.cancelled) {
      return post(false, "cancelled", metrics, logRef ? [logRef] : undefined);
    }
    if (outcome.code !== 0) {
      return post(
        false,
        `script exited ${outcome.code ?? `on signal ${outcome.signal ?? "?"}`}: ${lastLine(captured) || "no output"}`,
        metrics,
        logRef ? [logRef] : undefined,
      );
    }
    log(`exited 0 in ${elapsedS}s`);
    await post(true, undefined, metrics, logRef ? [logRef] : undefined);
  } finally {
    // The temp dir is the sandbox; leaving it behind would accumulate one per
    // job on a machine that runs this nightly.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

type Capture = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
};

/**
 * Runs the script, merging stdout and stderr.
 *
 * Merged because a script's diagnostics go to stderr and its progress to
 * stdout, and reading them apart loses which came first — the same call the
 * build workload makes, for the same reason.
 */
async function spawnCapturing(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  jobId: string,
): Promise<Capture> {
  return new Promise<Capture>((resolve) => {
    let output = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;

    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const absorb = (b: Buffer) => {
      if (bytes >= MAX_CAPTURE_BYTES) {
        if (!truncated) {
          truncated = true;
          output += "\n[output truncated]\n";
        }
        return;
      }
      bytes += b.length;
      output += b.toString("utf8");
    };
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // A cancelled shell job stops the script rather than waiting it out: unlike
    // a benchmark there is no iteration boundary to stop at.
    const canceller = setInterval(() => {
      if (JobCancellation.isCancelled(jobId) && !cancelled) {
        cancelled = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }
    }, 1_000);
    canceller.unref?.();

    const done = (c: Capture) => {
      clearTimeout(killer);
      clearInterval(canceller);
      resolve(c);
    };
    child.on("error", (e) => {
      spawnError = e.message;
      done({ code: null, signal: null, output, timedOut, cancelled, spawnError });
    });
    child.on("close", (code, signal) => {
      done({ code, signal, output, timedOut, cancelled, spawnError });
    });
  });
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
const lastLine = (s: string): string =>
  s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";
