/**
 * Every failure says why.
 *
 * `nightly-fleet-ui-smoke` failed on the Galaxy S8+ every night from 10-10 with
 * `test: {passed: 0, failed: 1}`, no `error`, and a host row that said only
 * `ok: false`. The reason was sitting in the JUnit report it had uploaded --
 * `Assertion is false: "Fleet Runner" is visible` -- and nothing put it where a
 * person or an agent reads. A failure with no reason costs whoever reads it a
 * trip to a log on another machine, which is a trip nobody takes at 07:00.
 *
 * Two pieces. `execFailureReason` turns a failed subprocess into one line (the
 * program, its exit code, the last line it printed to stderr). The tracker
 * wraps the executor's `postResult` so that no host row can say `ok: false`
 * with nothing beside it: a device row gets its test counts, and the final
 * host row gets the failing devices' reasons, which is what the job list and
 * the `job-failed` alert show.
 *
 * Pure apart from the closure's memory, so it is testable without a collector.
 */

const ONE_LINE = 300;
const FINAL_MAX = 500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The last non-empty line of some output, trimmed. */
export function lastLine(text: unknown): string {
  if (typeof text !== "string" && !Buffer.isBuffer(text)) return "";
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * One line for a subprocess that failed, from what `execFile` rejects with.
 *
 * Built from the exit code and the output, never from `err.message`: Node puts
 * the whole command line in the message, and a Maestro run carries the test
 * account's password as `-e PASSWORD=...` on that line. `secrets` are scrubbed
 * from what is used anyway, because a tool can echo its arguments.
 */
export function execFailureReason(err: unknown, secrets: string[] = []): string {
  const e = (err ?? {}) as {
    cmd?: unknown; code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown;
  };
  const program = typeof e.cmd === "string" ? (e.cmd.trim().split(/\s+/)[0] ?? "").split("/").pop() || "the command" : "the command";
  let how: string;
  if (e.killed === true || typeof e.signal === "string") how = `was killed${typeof e.signal === "string" ? ` (${e.signal})` : ""}`;
  else if (typeof e.code === "number") how = `exited ${e.code}`;
  else if (typeof e.code === "string") how = `could not run (${e.code})`;
  else how = "failed";
  let said = lastLine(e.stderr) || lastLine(e.stdout);
  // Not the message's first line, which is "Command failed: <the command line>".
  if (!said && typeof e.message === "string" && !e.message.startsWith("Command failed")) said = firstLine(e.message);
  for (const s of secrets) if (s) said = said.split(s).join("[redacted]");
  return clip(said ? `${program} ${how}: ${said}` : `${program} ${how} and printed nothing`, ONE_LINE);
}

type Row = Record<string, unknown> & { job_id?: unknown; device_id?: unknown; ok?: unknown; error?: unknown; final?: unknown };

const hasReason = (e: unknown) => typeof e === "string" && e.trim() !== "";

/** What a device row that failed with no error can still honestly say. */
function deviceReason(row: Row): string {
  const t = (row.test ?? null) as { passed?: unknown; failed?: unknown } | null;
  const failed = typeof t?.failed === "number" ? t.failed : null;
  const passed = typeof t?.passed === "number" ? t.passed : null;
  if (failed !== null && failed > 0) {
    const total = failed + (passed ?? 0);
    return `${failed} of ${total} test${total === 1 ? "" : "s"} failed; the runner reported no failing step`;
  }
  return "failed; the workload reported no reason";
}

/**
 * Wrap a `postResult` so that no row it posts says `ok: false` with an empty
 * `error`.
 *
 * Device rows are remembered per job until the job's final row goes out. A
 * final row that failed with no error of its own gets one built from them:
 * `988a1b35...: smoke: Assertion is false: ...`, or `2 of 3 devices failed --
 * a: ...; b: ...`. A row that already says why is never rewritten.
 */
export function withFailureReasons<R>(post: (row: Record<string, unknown>) => Promise<R>) {
  const seen = new Map<string, Map<string, { ok: boolean; error: string | null }>>();
  return async (row: Record<string, unknown>): Promise<R> => {
    const r = row as Row;
    const jobId = typeof r.job_id === "string" ? r.job_id : null;
    const deviceId = typeof r.device_id === "string" ? r.device_id : "";
    let out: Record<string, unknown> = row;

    if (r.final !== true) {
      if (r.ok === false && !hasReason(r.error)) out = { ...row, error: deviceReason(r) };
      if (jobId && !deviceId.startsWith("host:")) {
        const devices = seen.get(jobId) ?? new Map();
        devices.set(deviceId, { ok: out.ok !== false, error: hasReason(out.error) ? String(out.error) : null });
        seen.set(jobId, devices);
      }
      return post(out);
    }

    const devices = jobId ? seen.get(jobId) : undefined;
    if (jobId) seen.delete(jobId);
    if (r.ok === false && !hasReason(r.error)) {
      const failing = [...(devices ?? new Map()).entries()].filter(([, d]) => !d.ok);
      const total = devices?.size ?? 0;
      let error: string;
      if (failing.length === 0) error = "failed; the workload reported no reason";
      else {
        const parts = failing.map(([id, d]) => `${id}: ${firstLine(d.error ?? "no reason given")}`);
        error = failing.length === 1 && total <= 1
          ? parts[0]
          : `${failing.length} of ${total} devices failed -- ${parts.join("; ")}`;
      }
      out = { ...row, error: clip(error, FINAL_MAX) };
    }
    return post(out);
  };
}
