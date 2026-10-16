/**
 * The two decisions a scope alone cannot make, in one place.
 *
 * The scope check in `auth.ts` answers "may this token enqueue, cancel or
 * retry at all". Two finer questions depend on what is being asked for:
 *
 * - **Whose job is it?** A `run` token may cancel or retry only jobs it
 *   started; `admin` may act on any.
 * - **What would it run?** A dangerous workload (`shell`: a script runner on
 *   somebody's machine) needs `admin`, however the spec is phrased.
 *
 * Both are asked by `/api/v1` and by the older routes (`POST /jobs`,
 * `POST /api/jobs`, `POST /api/jobs/:id/cancel|retry`). They used to be asked
 * by `/api/v1` only, which made the old routes a way round them. Each caller
 * turns a refusal into its own error shape -- the control API's
 * `{error:{code,...}}`, the older routes' `{error: "sentence"}` -- but the
 * decision is this function's.
 *
 * With `FLEET_AUTH` off nothing here refuses anything, which is the posture a
 * collector without tokens has always had. A request forwarded from inside the
 * process (`internal`) was already decided by the request that forwarded it.
 */
import type { AuthContext } from "../auth.js";
import { db } from "../db.js";
import { catalogEntry } from "../workloads/catalog.js";

export type Refusal = { message: string; hint: string };

/** Why this caller may not cancel or retry these jobs, or null when it may. */
export function notOwned(ctx: AuthContext, ids: string[]): Refusal | null {
  if (ctx.mode !== "tokens" || ctx.internal || ctx.scopes.has("admin") || ids.length === 0) return null;
  const rows = db.prepare(`SELECT job_id, requested_by FROM jobs WHERE job_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as {
    job_id: string; requested_by: string | null;
  }[];
  const foreign = rows.find((r) => r.requested_by !== ctx.actor);
  if (!foreign) return null;
  return {
    message: `you can stop only jobs you started; ${foreign.job_id} was started by ${foreign.requested_by ?? "someone unrecorded"}`,
    hint: "an admin token can act on any job",
  };
}

/** Why this caller may not queue this workload, or null when it may. */
export function needsAdmin(ctx: AuthContext, workload: unknown): Refusal | null {
  if (ctx.mode !== "tokens" || ctx.internal || ctx.scopes.has("admin")) return null;
  const entry = typeof workload === "string" ? catalogEntry(workload) : null;
  if (!entry?.dangerous) return null;
  return {
    message: `the ${entry.name} workload needs the admin scope`,
    hint: "ask an operator to run it, or use a token with admin",
  };
}
