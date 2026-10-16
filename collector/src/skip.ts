/**
 * What a skip is, decided in one place.
 *
 * A runner that could not run a job says so with a result row whose `ok` is
 * true and whose `error` begins `skipped:` -- the app is not installed, the
 * device was locked, nothing attached matched, the host was under pressure, no
 * Roku password. `ok: true` because nothing went wrong with the code; the
 * prefix because nothing was tested either.
 *
 * For a long time that row closed the job as `done`, and the job list, the
 * status counts and the morning digest all counted it as a pass. Two nightlies
 * "passed" in two seconds every night for two weeks while testing nothing. Only
 * the v1 summary and `fleetr`'s exit 4 read the prefix. Now the queue reads it
 * too, when the job closes, and the job's status says `skipped`.
 *
 * Pure: no database, so `db.ts` can run it in the startup backfill without an
 * import cycle, and a test can feed it rows directly.
 */

export const SKIP_PREFIX = "skipped:";

/** True for an error string that says nothing ran. */
export function isSkipError(error: unknown): error is string {
  return typeof error === "string" && error.startsWith(SKIP_PREFIX);
}

export type ResultRow = { device_id: string; payload: Record<string, unknown> };

export type Closing =
  | { status: "failed"; reason: string | null }
  | { status: "done"; reason: null }
  | { status: "skipped"; reason: string };

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * How a job closes, from every result row it posted (in `iter, rowid` order)
 * and the final row that closes it.
 *
 * - The final row says `ok: false`: **failed**. Its error, or the first failing
 *   device's, is the reason.
 * - The final row's own error begins `skipped:`: **skipped**.
 * - Otherwise the per-device verdicts decide, read the way the v1 summary reads
 *   them: the newest row per device, with the host executor's `host:<name>`
 *   row standing in only when no device reported. Every one of those skipped
 *   and none failed: **skipped** -- a ui-test whose every phone lacked the app
 *   posts a plain `ok: true` host row over device rows that all say why.
 * - Anything else: **done**.
 *
 * The same rule as `summarize()` in `api/v1/routes.ts`, so a job's status and
 * its summary verdict cannot disagree about whether anything ran.
 */
export function closingStatus(rows: ResultRow[], final: Record<string, unknown>): Closing {
  const byDevice = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const prev = byDevice.get(r.device_id);
    if (!prev || !prev.final || r.payload.final) byDevice.set(r.device_id, r.payload);
  }
  let entries = [...byDevice];
  if (entries.some(([d]) => !d.startsWith("host:"))) entries = entries.filter(([d]) => !d.startsWith("host:"));

  if (final.ok === false) {
    const own = typeof final.error === "string" && final.error.trim() ? final.error : null;
    const failing = entries.find(([, p]) => p.ok === false && typeof p.error === "string" && p.error.trim());
    const reason = own ?? (failing ? `${failing[0]}: ${String(failing[1].error)}` : null);
    return { status: "failed", reason: reason ? clip(reason) : null };
  }
  if (isSkipError(final.error)) return { status: "skipped", reason: clip(final.error) };

  if (entries.length > 0 && entries.every(([, p]) => p.ok !== false && isSkipError(p.error))) {
    const reasons = [...new Set(entries.map(([, p]) => String(p.error)))];
    const reason = reasons.length === 1 ? reasons[0] : `${reasons[0]} (and ${reasons.length - 1} other reason${reasons.length === 2 ? "" : "s"})`;
    return { status: "skipped", reason: clip(reason) };
  }
  return { status: "done", reason: null };
}

/** The reason without its `skipped: ` prefix, for a sentence that already says "skipped". */
export function skipReasonText(reason: string | null | undefined): string {
  if (!reason) return "no reason given";
  return reason.startsWith(SKIP_PREFIX) ? reason.slice(SKIP_PREFIX.length).trim() || "no reason given" : reason;
}
