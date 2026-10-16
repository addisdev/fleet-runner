/**
 * The decisions `scripts/explore-night.ts` makes before it spends a night,
 * kept pure so they can be tested without a brain, a simulator or a model.
 *
 * Two questions, both asked before the model is warmed or a device booted:
 *
 *   1. **Is there anything to test?** A night that explores tonight's build
 *      needs tonight's build. When `fleet-explore-builds` did not run (10-14:
 *      it waited two hours behind a CI job and was skipped), the dependent
 *      nights used to warm a 35B model, boot a simulator and then fail. Now
 *      they post a skip and exit 0: a missing upstream build is not their
 *      failure, and ultra's night queue has no skip exit code to say so.
 *   2. **How much time is left?** ultra's night queue stops at 07:30 and kills
 *      a job at its manifest's `max_minutes`. A night given less than its specs
 *      ask for runs every spec shorter, highest-priority cards first (the
 *      workload already orders them), and says so in its result, instead of
 *      being killed halfway with nothing posted.
 */
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const NIGHT = {
  /** The night queue's hard stop. */
  until: "07:30",
  /** Held back at the end: the last replay, uploads, shutting devices down. */
  safetyMin: 10,
  /** Per spec: enqueue, claim, install, the first model call. */
  perSpecMin: 3,
  /** Less exploring than this is not worth booting a simulator for. */
  minUsefulMin: 15,
  /** How long a warm-up refused for memory is retried before the night skips. */
  warmWaitMin: 10,
} as const;

const MIN = 60_000;

/** The next local HH:MM strictly after `now`. */
export function nextClock(now: Date, hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`--until wants HH:MM, got "${hhmm}"`);
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * When tonight began, for "is this build from tonight": noon on the night's
 * date, the same rule as the night queue's `night_of` (02:00 on Tuesday is
 * Monday night). A build uploaded during the day counts as tonight's.
 */
export function nightStart(now: Date): Date {
  const at = new Date(now);
  if (at.getHours() < 12) at.setDate(at.getDate() - 1);
  at.setHours(12, 0, 0, 0);
  return at;
}

/**
 * `max_minutes` from the night queue's manifest for this job, if it can be
 * read. The queue hands a job `NIGHT_JOB` (its name) but not its budget, and
 * kills it when the budget runs out, so the manifest is the only place the
 * job can learn it. Read-only; nothing here writes to the queue.
 */
export function nightManifestMinutes(
  env: NodeJS.ProcessEnv = process.env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | undefined {
  const name = env.NIGHT_JOB;
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return undefined;
  const root = env.NIGHT_ROOT ?? path.join(env.HOME ?? os.homedir(), "night");
  for (const kind of ["recurring", "queue"]) {
    try {
      const m = JSON.parse(read(path.join(root, kind, `${name}.json`))) as { max_minutes?: unknown };
      if (typeof m.max_minutes === "number" && m.max_minutes > 0) return m.max_minutes;
      return 60; // the queue's own default when a manifest leaves it out
    } catch { /* not this one */ }
  }
  return undefined;
}

export type NightEnd = { end: Date; by: string };

/** Whichever comes first: `--until`, or the job's own `max_minutes` from when it started. */
export function nightEnd(o: { now: Date; startedAt: Date; until?: string; maxMinutes?: number }): NightEnd {
  const until = o.until ?? NIGHT.until;
  const stop = nextClock(o.now, until);
  if (o.maxMinutes !== undefined) {
    const killed = new Date(o.startedAt.getTime() + o.maxMinutes * MIN);
    if (killed < stop) return { end: killed, by: `the job's ${o.maxMinutes}-minute max_minutes` };
  }
  return { end: stop, by: `the ${until} stop` };
}

export type Plan = {
  /** Minutes per spec, in the order given; 0 means the spec does not fit tonight. */
  minutes: number[];
  /** Anything given less than it asked for. */
  short: boolean;
};

/**
 * Share the minutes left among the specs still to run.
 *
 * Every spec keeps what it asks for when that fits. Otherwise each gets a
 * share in proportion to what it asked, and if a share would be under the
 * useful minimum, the last spec is dropped and the rest share again: a TV night
 * would rather run its bench and the explorer properly than all three at five
 * minutes each. Called again before each spec, with the time actually left.
 */
export function planSpecs(asked: number[], leftMin: number, o: { safetyMin?: number; perSpecMin?: number; minUsefulMin?: number } = {}): Plan {
  const safety = o.safetyMin ?? NIGHT.safetyMin;
  const perSpec = o.perSpecMin ?? NIGHT.perSpecMin;
  const minUseful = o.minUsefulMin ?? NIGHT.minUsefulMin;
  for (let k = asked.length; k >= 1; k--) {
    const avail = leftMin - safety - k * perSpec;
    const want = asked.slice(0, k);
    const sum = want.reduce((a, b) => a + b, 0);
    const minutes = want.map((m) => (sum <= avail ? m : Math.floor((avail * m) / sum)));
    // A spec that asks for less than the minimum only needs what it asks for.
    if (minutes.every((m, i) => m >= Math.min(minUseful, want[i]))) {
      const all = [...minutes, ...asked.slice(k).map(() => 0)];
      return { minutes: all, short: all.some((m, i) => m < asked[i]) };
    }
  }
  return { minutes: asked.map(() => 0), short: asked.length > 0 };
}

/** What a short night's result says, on its device row and its final row. */
export function shortNightNote(ran: number, planned: number, minutes: number, asked: number): string {
  return `short night: ran ${ran} of ${planned} card${planned === 1 ? "" : "s"}: ${Math.round(minutes)} minutes left of the ${asked} asked`;
}

/** The newest build the brain holds for an app, as `GET /api/artifacts?app=` lists it. */
export type BrainBuild = { sha256: string; build: string | null; published_at: string | null; created_at?: string | null };

/**
 * Why tonight's build is missing, or null when it is there.
 *
 * "Tonight's" means published since `since` (noon of the night's date).
 * `nightly-builds.sh` republishes an unchanged build each night for exactly
 * this check, so an old `published_at` means the build job did not run or did
 * not upload this app. `fetchedTonight` -- whether the app's checkout under
 * ~/explore/builds was fetched tonight -- tells those two apart when known.
 */
export function buildMissing(app: string, newest: BrainBuild | undefined, since: Date, fetchedTonight?: boolean | null): string | null {
  if (!newest) return `skipped: no ${app} build on the brain (fleet-explore-builds has never uploaded one)`;
  const at = newest.published_at ?? newest.created_at ?? null;
  const t = at ? Date.parse(at) : NaN;
  if (Number.isFinite(t) && t >= since.getTime()) return null;
  const why = fetchedTonight === false ? "fleet-explore-builds did not run, or could not fetch develop"
    : fetchedTonight === true ? "fleet-explore-builds fetched develop but uploaded no build; see its log"
      : "fleet-explore-builds did not run or did not upload it";
  const which = `${newest.build ?? newest.sha256.slice(0, 12)}${at ? ` from ${at.slice(0, 16).replace("T", " ")} UTC` : ""}`;
  return `skipped: no ${app} build for tonight (${why}; the newest is ${which})`;
}

/** Whether a checkout was fetched since `since`: its FETCH_HEAD's mtime. Null when there is no checkout. */
export function fetchedSince(repo: string | undefined, since: Date): boolean | null {
  if (!repo) return null;
  const dir = repo.replace(/^~(?=\/|$)/, os.homedir());
  try {
    return statSync(path.join(dir, ".git", "FETCH_HEAD")).mtimeMs >= since.getTime();
  } catch {
    return null;
  }
}

/**
 * A warm-up the shelf refused for memory, not one that broke. ultra's
 * `shelf.sh warm` says "not loading <model>: memory pressure" or "…: 64% free,
 * needs 65%". On 10-14 exactly that, one point short, was `fleet-explore-apple`'s
 * `exit 1 in 0.0 min`. A refusal is retried, then is a skip: a host without
 * room is the brain's `skipped:` case, as it is for the executor's own
 * pressure check. Anything else is a failure.
 */
export function warmRefusedForMemory(output: string): boolean {
  return /memory pressure|\d+% free, needs \d+%/i.test(output);
}

/** The last non-empty line of some output, for a one-line reason. */
export function lastLine(output: string): string {
  return output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}
