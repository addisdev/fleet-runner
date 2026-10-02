/**
 * Night QA findings: what the explore workload found, and what a person
 * thought of it.
 *
 * The workload drives an app overnight, flags anything that looks wrong, and
 * replays each candidate on a clean install before believing it. What survives
 * arrives here as an `ExploreFinding` (src/workloads/explore/types.ts is the
 * contract). This module is everything the collector does with one after that:
 *
 *   store        upsert on the fingerprint, so the fifth night that finds the
 *                same crash raises a count instead of a fifth report (T2)
 *   verdict      a person's real / duplicate / not a bug / agent's mistake (T4)
 *   precision    per app and check, how often a person called it real -- and
 *                which check classes are wasting the morning (O4)
 *   digest       the morning summary, sent once a day to the phone (T5)
 *   issues       the GitHub issue each solid finding WOULD file (T6), recorded
 *                as a dry run unless filing is explicitly armed
 *
 * ## Why the collector refuses findings the workload should never send
 *
 * A finding whose replay reproduced nothing is a guess, and a dashboard full of
 * guesses is one the owner stops opening. The workload is not supposed to post
 * them, but "not supposed to" is a property of today's workload, and the
 * collector is the one place every future version of it has to pass through.
 * So the rule is enforced here, with a 422 that says why.
 *
 * ## Why issues are built dark
 *
 * The owner's standing rule is that Fleet Runner stays disconnected from the
 * app repositories until they say otherwise. So every issue is composed,
 * capped and recorded exactly as it would be filed -- the audit trail exists
 * from the first night -- and nothing leaves the collector unless
 * FLEET_GITHUB_ISSUES=1 AND FLEET_GITHUB_TOKEN are both set. That is the same
 * posture as commit statuses (`reportStatus` in server.ts), and a separate
 * switch from it: arming one kind of noise in somebody's repo does not arm the
 * other. Even armed, this code only ever creates issues. It never edits,
 * comments on or closes one; that is a person's job.
 */
import { db } from "./db.js";
import { iso, parse } from "./api/shared.js";
import { sendWebhook } from "./alerts.js";
import {
  DASH_URL,
  FINDINGS_DIGEST_AT,
  FINDINGS_DIGEST_HOURS,
  FINDINGS_REPOS,
  GITHUB_API,
  GITHUB_ISSUES_ARMED,
  GITHUB_TOKEN,
} from "./config.js";
import { CHECK_NAMES, type CheckName, type ExploreFinding, type Verdict } from "./workloads/explore/types.js";

// ---------------------------------------------------------------------------
// The rules, as numbers
// ---------------------------------------------------------------------------

export const VERDICTS: readonly Verdict[] = ["real", "duplicate", "not_a_bug", "agent_mistake"];
const SEVERITIES = ["high", "medium", "low"] as const;
const REPLAY_KINDS = ["maestro", "tvloop", "none"] as const;
const ARTIFACT_KEYS = ["shot", "sheet", "trajectory", "log", "replay"] as const;
const SHA = /^[a-f0-9]{64}$/;

/**
 * How big each field may be. Generous for what a finding is -- a title is a
 * sentence, a detail is a paragraph and a log excerpt -- and small enough that
 * a model stuck in a loop cannot write a megabyte of steps into the table the
 * dashboard reads on every page load.
 */
export const LIMITS = {
  id: 200,
  fingerprint: 256,
  title: 300,
  detail: 8_000,
  screen: 300,
  steps: 100,
  step: 500,
  note: 2_000,
  attempts: 50,
  /** Whole request, in bytes. Fastify's own default is 1 MiB. */
  body: 128 * 1024,
} as const;

/**
 * O4: a check class whose findings a person calls real less than 30% of the
 * time is switched off, once at least `min` of them have been judged. The
 * floor on judged findings is what stops the first two verdicts on a new class
 * deciding its fate.
 */
export const PRECISION_FLOOR = 0.3;
export const PRECISION_MIN_JUDGED = 10;

/** T6: at most this many new issues per app per 24 hours, dry runs included. */
export const ISSUE_CAP_PER_DAY = 5;
export const ISSUE_LABEL = "night-qa";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Rejection = { status: 400 | 422; error: string };

/**
 * Check a posted body against the contract.
 *
 * 400 is "this is not an ExploreFinding": a missing field, a check name the
 * collector has never heard of, a field past its size limit. 422 is "this is a
 * well-formed finding the collector will not file", which today means one rule:
 * a replay that reproduced nothing, or no replay at all for anything but a
 * crash. A crash is the exception because the platform's crash log is its own
 * evidence; every other check is a judgement, and a judgement nobody could
 * repeat is not a finding.
 *
 * Unknown top-level keys are ignored rather than refused, so the workload can
 * grow a field before the collector learns to store it. Unknown artifact keys
 * ARE refused: those are links the dashboard draws, and a key it does not know
 * would be silently dropped from the page.
 */
export function validateFinding(body: unknown): { ok: true; finding: ExploreFinding } | ({ ok: false } & Rejection) {
  const bad = (error: string) => ({ ok: false as const, status: 400 as const, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body must be a JSON object");
  const b = body as Record<string, unknown>;

  const str = (key: string, max: number, required: boolean): string | null => {
    const v = b[key];
    if (typeof v !== "string") return null;
    if (required && v.trim() === "") return null;
    if (v.length > max) return null;
    return v;
  };
  const required: [string, number][] = [
    ["fingerprint", LIMITS.fingerprint], ["app", LIMITS.id], ["build", LIMITS.id], ["platform", LIMITS.id],
    ["device_id", LIMITS.id], ["job_id", LIMITS.id], ["mission_id", LIMITS.id], ["title", LIMITS.title],
  ];
  for (const [key, max] of required) {
    if (str(key, max, true) === null)
      return bad(typeof b[key] === "string" && (b[key] as string).length > max
        ? `${key} is longer than ${max} characters`
        : `${key} is required (a non-empty string)`);
  }
  for (const [key, max] of [["detail", LIMITS.detail], ["screen", LIMITS.screen], ["screen_name", LIMITS.screen]] as const) {
    if (typeof b[key] !== "string") return bad(`${key} must be a string`);
    if ((b[key] as string).length > max) return bad(`${key} is longer than ${max} characters`);
  }

  if (!CHECK_NAMES.includes(b.check as CheckName))
    return bad(`unknown check ${JSON.stringify(b.check)}; expected one of ${CHECK_NAMES.join(", ")}`);
  if (!SEVERITIES.includes(b.severity as (typeof SEVERITIES)[number]))
    return bad(`severity must be one of ${SEVERITIES.join(", ")}`);

  if (!Array.isArray(b.steps) || !b.steps.every((s) => typeof s === "string"))
    return bad("steps must be an array of strings");
  if (b.steps.length > LIMITS.steps) return bad(`steps has more than ${LIMITS.steps} entries`);
  if (b.steps.some((s) => (s as string).length > LIMITS.step)) return bad(`a step is longer than ${LIMITS.step} characters`);

  if (!b.artifacts || typeof b.artifacts !== "object" || Array.isArray(b.artifacts))
    return bad("artifacts must be an object (it may be empty)");
  for (const [k, v] of Object.entries(b.artifacts as Record<string, unknown>)) {
    if (!ARTIFACT_KEYS.includes(k as (typeof ARTIFACT_KEYS)[number]))
      return bad(`unknown artifact ${JSON.stringify(k)}; expected ${ARTIFACT_KEYS.join(", ")}`);
    if (v !== undefined && (typeof v !== "string" || !SHA.test(v))) return bad(`artifacts.${k} must be a sha256 hex digest`);
  }

  const r = b.replay;
  if (r !== null) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return bad("replay must be an object or null");
    const rp = r as Record<string, unknown>;
    if (!REPLAY_KINDS.includes(rp.kind as (typeof REPLAY_KINDS)[number]))
      return bad(`replay.kind must be one of ${REPLAY_KINDS.join(", ")}`);
    if (rp.sha256 !== null && (typeof rp.sha256 !== "string" || !SHA.test(rp.sha256)))
      return bad("replay.sha256 must be a sha256 hex digest or null");
    const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= LIMITS.attempts;
    if (!isCount(rp.attempts) || !isCount(rp.reproduced))
      return bad(`replay.attempts and replay.reproduced must be whole numbers from 0 to ${LIMITS.attempts}`);
    if ((rp.reproduced as number) > (rp.attempts as number)) return bad("replay.reproduced cannot exceed replay.attempts");
    if (rp.reproduced === 0)
      return {
        ok: false, status: 422,
        error: `replay reproduced it 0 of ${rp.attempts} times; a finding nobody could repeat is not filed`,
      };
  } else if (b.check !== "crash") {
    return {
      ok: false, status: 422,
      error: `replay is null, which only a crash may be (its crash log is the evidence); check ${b.check} needs a replay that reproduced it`,
    };
  }

  // Rebuilt from the checked fields rather than cast, so nothing unvalidated
  // rides along into the row.
  const a = b.artifacts as Record<string, string | undefined>;
  const finding: ExploreFinding = {
    fingerprint: b.fingerprint as string,
    app: b.app as string,
    build: b.build as string,
    platform: b.platform as string,
    device_id: b.device_id as string,
    job_id: b.job_id as string,
    mission_id: b.mission_id as string,
    check: b.check as CheckName,
    severity: b.severity as ExploreFinding["severity"],
    title: b.title as string,
    detail: b.detail as string,
    screen: b.screen as string,
    screen_name: b.screen_name as string,
    steps: b.steps as string[],
    replay: r === null ? null : {
      kind: (r as Record<string, unknown>).kind as "maestro" | "tvloop" | "none",
      sha256: ((r as Record<string, unknown>).sha256 as string | null) ?? null,
      attempts: (r as Record<string, unknown>).attempts as number,
      reproduced: (r as Record<string, unknown>).reproduced as number,
    },
    artifacts: Object.fromEntries(ARTIFACT_KEYS.filter((k) => a[k]).map((k) => [k, a[k]])),
  };
  return { ok: true, finding };
}

// ---------------------------------------------------------------------------
// Rows and their public shape
// ---------------------------------------------------------------------------

type Replay = ExploreFinding["replay"];
type Artifacts = ExploreFinding["artifacts"];

type Row = {
  id: number;
  fingerprint: string;
  app: string;
  build: string;
  platform: string;
  device_id: string;
  job_id: string;
  last_job_id: string | null;
  mission_id: string;
  check_name: CheckName;
  severity: ExploreFinding["severity"];
  title: string;
  detail: string;
  screen: string;
  screen_name: string;
  steps: string;
  replay: string | null;
  artifacts: string;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  builds_seen: string;
  verdict: Verdict | null;
  verdict_note: string | null;
  verdict_at: string | null;
  duplicate_of: number | null;
  issue: string | null;
  issue_state: IssueState | null;
  issue_at: string | null;
};

export type IssueState = "dry_run" | "pending" | "filed" | "failed" | "capped" | "no_repo";

/**
 * The issue a finding would file, or did.
 *
 * `dry_run` is the field to read: true means nothing was sent to GitHub. The
 * states are
 *   dry_run   composed and counted against the cap, not sent (the default)
 *   pending   armed, and the request is in flight
 *   filed     GitHub created it; `url` and `number` say where
 *   failed    armed, and GitHub said no (or never answered); `detail` says how
 *   capped    this app already had its five for the day; retried on the next sighting
 *   no_repo   FLEET_FINDINGS_REPOS does not name a repository for this app; also retried
 */
export type IssueRecord = {
  state: IssueState;
  dry_run: boolean;
  repo: string | null;
  title: string;
  body: string;
  labels: string[];
  url: string | null;
  number: number | null;
  detail: string;
  at: string;
};

export type FindingView = {
  id: number;
  fingerprint: string;
  app: string;
  build: string;
  platform: string;
  device_id: string;
  job_id: string;
  last_job_id: string | null;
  mission_id: string;
  check: CheckName;
  severity: ExploreFinding["severity"];
  title: string;
  detail: string;
  screen: string;
  screen_name: string;
  steps: string[];
  replay: Replay;
  /** "reproduced 2/2", "flaky 1/2", "crash log": what the list shows. */
  replay_label: string;
  artifacts: Artifacts;
  first_seen: string | null;
  last_seen: string | null;
  seen_count: number;
  builds_seen: string[];
  verdict: Verdict | null;
  verdict_note: string | null;
  verdict_at: string | null;
  duplicate_of: number | null;
  issue: IssueRecord | null;
  status: "open" | "triaged";
};

export function replayLabel(replay: Replay, check: CheckName): string {
  if (!replay) return check === "crash" ? "crash log" : "not replayed";
  if (replay.reproduced >= replay.attempts) return `reproduced ${replay.reproduced}/${replay.attempts}`;
  return `flaky ${replay.reproduced}/${replay.attempts}`;
}

function view(r: Row): FindingView {
  const replay = parse<Replay>(r.replay, null);
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    app: r.app,
    build: r.build,
    platform: r.platform,
    device_id: r.device_id,
    job_id: r.job_id,
    last_job_id: r.last_job_id,
    mission_id: r.mission_id,
    check: r.check_name,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    screen: r.screen,
    screen_name: r.screen_name,
    steps: parse<string[]>(r.steps, []),
    replay,
    replay_label: replayLabel(replay, r.check_name),
    artifacts: parse<Artifacts>(r.artifacts, {}),
    first_seen: iso(r.first_seen),
    last_seen: iso(r.last_seen),
    seen_count: r.seen_count,
    builds_seen: parse<string[]>(r.builds_seen, []),
    verdict: r.verdict,
    verdict_note: r.verdict_note,
    verdict_at: iso(r.verdict_at),
    duplicate_of: r.duplicate_of,
    issue: parse<IssueRecord | null>(r.issue, null),
    status: r.verdict === null ? "open" : "triaged",
  };
}

const getRow = (id: number) => db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;

export function getFinding(id: number): FindingView | null {
  const r = getRow(id);
  return r ? view(r) : null;
}

/** SQLite's own timestamp shape, so JS-made times compare as text with datetime('now'). */
const sqliteTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

// ---------------------------------------------------------------------------
// Store (T2)
// ---------------------------------------------------------------------------

/** Whether `next` is better evidence than `prev`: more reproductions, then a better ratio. */
function betterReplay(prev: Replay, next: Replay): boolean {
  if (!next) return false;
  if (!prev) return true;
  if (next.reproduced !== prev.reproduced) return next.reproduced > prev.reproduced;
  return next.reproduced / Math.max(1, next.attempts) > prev.reproduced / Math.max(1, prev.attempts);
}

const SEVERITY_RANK: Record<ExploreFinding["severity"], number> = { high: 3, medium: 2, low: 1 };

export type IssueOptions = {
  repos: Record<string, string>;
  armed: boolean;
  token: string | undefined;
  api: string;
  dashUrl: string;
  capPerDay: number;
};

/** The live settings. Tests pass their own instead of changing the environment. */
export function issueOptions(): IssueOptions {
  return {
    repos: FINDINGS_REPOS,
    armed: GITHUB_ISSUES_ARMED,
    token: GITHUB_TOKEN,
    api: GITHUB_API,
    dashUrl: DASH_URL,
    capPerDay: ISSUE_CAP_PER_DAY,
  };
}

export type StoreOutcome = { finding: FindingView; isNew: boolean; issue: IssueRecord | null };

/**
 * Insert a new finding, or fold a repeat sighting into the one already stored.
 *
 * On a repeat the ORIGINAL title, detail, steps and first artifacts stay: they
 * are what a person may already have read and judged, and rewording a finding
 * under its verdict would make the verdict mean something else. What moves is
 * the evidence -- seen_count, last_seen, which builds it has been seen on, the
 * replay when the new one reproduced more, artifacts the first sighting lacked,
 * and severity, which only ever goes up.
 *
 * The verdict is never touched. A finding marked "not a bug" that turns up
 * again is still not a bug, which is the whole reason duplicates merge.
 */
export const storeFinding = db.transaction((f: ExploreFinding, opts: IssueOptions): StoreOutcome => {
  const existing = db.prepare("SELECT * FROM findings WHERE fingerprint = ?").get(f.fingerprint) as Row | undefined;
  let id: number;
  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO findings (fingerprint, app, build, platform, device_id, job_id, last_job_id, mission_id,
                               check_name, severity, title, detail, screen, screen_name, steps, replay,
                               artifacts, builds_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.fingerprint, f.app, f.build, f.platform, f.device_id, f.job_id, f.job_id, f.mission_id,
        f.check, f.severity, f.title, f.detail, f.screen, f.screen_name, JSON.stringify(f.steps),
        f.replay ? JSON.stringify(f.replay) : null, JSON.stringify(f.artifacts), JSON.stringify([f.build]),
      );
    id = Number(info.lastInsertRowid);
  } else {
    id = existing.id;
    const builds = parse<string[]>(existing.builds_seen, []);
    if (!builds.includes(f.build)) builds.push(f.build);
    const prevReplay = parse<Replay>(existing.replay, null);
    const takeReplay = betterReplay(prevReplay, f.replay);
    // First artifacts win; the new sighting only fills the gaps. The replay
    // file is the exception: it has to be the file the kept replay counts
    // describe, or "reproduced 2/2" would link to the run that went 1/2.
    const artifacts: Artifacts = { ...f.artifacts, ...parse<Artifacts>(existing.artifacts, {}) };
    if (takeReplay && f.artifacts.replay) artifacts.replay = f.artifacts.replay;
    const severity = SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity] ? f.severity : existing.severity;
    db.prepare(
      `UPDATE findings SET seen_count = seen_count + 1, last_seen = datetime('now'), last_job_id = ?,
                           builds_seen = ?, replay = ?, artifacts = ?, severity = ?
       WHERE id = ?`,
    ).run(
      f.job_id, JSON.stringify(builds),
      takeReplay ? JSON.stringify(f.replay) : existing.replay,
      JSON.stringify(artifacts), severity, id,
    );
  }

  const row = getRow(id)!;
  const issue = maybePlanIssue(row, opts);
  return { finding: view(getRow(id)!), isNew: !existing, issue };
});

// ---------------------------------------------------------------------------
// Issues (T6)
// ---------------------------------------------------------------------------

/**
 * Whether a finding is solid enough to become an issue: every replay
 * reproduced it, or it is a crash. A flaky finding stays on the dashboard,
 * where a person can look at it, and out of the repository, where it would
 * read as a claim.
 */
export function issueWorthy(f: { check: CheckName; replay: Replay }): boolean {
  if (f.check === "crash") return true;
  return !!f.replay && f.replay.attempts >= 1 && f.replay.reproduced === f.replay.attempts;
}

/** States that are settled. The other two (capped, no_repo) are tried again on the next sighting. */
const SETTLED: IssueState[] = ["dry_run", "pending", "filed", "failed"];

function maybePlanIssue(row: Row, opts: IssueOptions): IssueRecord | null {
  if (row.issue_state && SETTLED.includes(row.issue_state)) return null;
  // A person already said it is not worth anyone's time.
  if (row.verdict && row.verdict !== "real") return null;
  const v = view(row);
  if (!issueWorthy(v)) return null;

  const record = planIssue(v, opts);
  db.prepare("UPDATE findings SET issue = ?, issue_state = ?, issue_at = ? WHERE id = ?").run(
    JSON.stringify(record), record.state, sqliteTime(new Date(record.at)), row.id,
  );
  return record;
}

/**
 * The longest run of backticks in `s`, plus one, as a fence. Model-written
 * text goes into the issue inside a fence so that nothing in it -- an
 * @mention, a #123, a stray heading -- is read as Markdown by GitHub. A fence
 * longer than any backtick run inside cannot be closed early by the content.
 */
function fence(s: string): string {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

const ARTIFACT_LABEL: Record<(typeof ARTIFACT_KEYS)[number], string> = {
  shot: "screenshot",
  sheet: "contact sheet",
  trajectory: "trajectory",
  log: "log excerpt",
  replay: "replay file",
};

/** The issue's title and Markdown body. Pure: the same finding always composes the same issue. */
export function composeIssue(f: FindingView, dashUrl: string): { title: string; body: string } {
  const title = `[night-qa] ${f.check}: ${f.title}`.slice(0, 250);
  const steps = f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const stepsFence = fence(steps);
  const detailFence = fence(f.detail);
  const replay = f.replay
    ? `${replayLabel(f.replay, f.check)} on a clean install (${f.replay.kind})`
    : "not replayed; the crash log is the evidence";
  const links = ARTIFACT_KEYS.filter((k) => f.artifacts[k]).map(
    (k) => `[${ARTIFACT_LABEL[k]}](${dashUrl}/artifacts/${f.artifacts[k]})`,
  );
  const lines = [
    `Night QA found this while exploring **${f.app}** and replayed it before filing.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Check | \`${f.check}\` (severity ${f.severity}) |`,
    `| Build | \`${f.build}\` |`,
    `| Platform / device | ${f.platform} / \`${f.device_id}\` |`,
    `| Screen | ${f.screen_name || "unnamed"}${f.screen ? ` (\`${f.screen}\`)` : ""} |`,
    `| Replay | ${replay} |`,
    `| Mission / job | \`${f.mission_id}\` / \`${f.job_id}\` |`,
    "",
  ];
  if (f.detail.trim()) lines.push("### What went wrong", "", detailFence, f.detail, detailFence, "");
  if (steps) lines.push("### Steps", "", stepsFence, steps, stepsFence, "");
  if (links.length) lines.push(`Artifacts: ${links.join(" · ")}`, "");
  lines.push(
    `[Open it in the Fleet Runner dashboard](${dashUrl}/dash/findings/${f.id})`,
    "",
    `<sub>Filed by Fleet Runner night QA. Fingerprint \`${f.fingerprint}\`. Fleet Runner only ever opens issues; it never edits, comments on or closes them.</sub>`,
  );
  return { title, body: lines.join("\n") };
}

/** Decide what happens to one issue-worthy finding: which state, which repo, and whether the cap allows it. */
export function planIssue(f: FindingView, opts: IssueOptions, now = new Date()): IssueRecord {
  const { title, body } = composeIssue(f, opts.dashUrl);
  const repo = opts.repos[f.app] ?? null;
  const base = { title, body, labels: [ISSUE_LABEL], url: null, number: null, at: now.toISOString(), repo };
  if (!repo)
    return { ...base, state: "no_repo", dry_run: true, detail: `FLEET_FINDINGS_REPOS names no repository for ${f.app}` };

  // Dry runs count against the cap too. The cap exists so that turning filing
  // on cannot open fifty issues in one morning, and a dry run that ignored it
  // would be a rehearsal of a different show.
  const filedToday = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM findings
         WHERE app = ? AND id != ? AND issue_state IN ('dry_run','pending','filed','failed')
           AND issue_at >= ?`,
      )
      .get(f.app, f.id, sqliteTime(new Date(now.getTime() - 24 * 3600_000))) as { n: number }
  ).n;
  if (filedToday >= opts.capPerDay)
    return {
      ...base, state: "capped", dry_run: true,
      detail: `${f.app} already has ${filedToday} issues in the last 24 h (cap ${opts.capPerDay}); tried again next time it is seen`,
    };

  if (opts.armed && opts.token)
    return { ...base, state: "pending", dry_run: false, detail: "filing" };
  return {
    ...base, state: "dry_run", dry_run: true,
    detail: "dry run: FLEET_GITHUB_ISSUES/FLEET_GITHUB_TOKEN not set, so nothing was sent",
  };
}

/**
 * Send a `pending` issue to GitHub and record what came back.
 *
 * POST /repos/{owner}/{repo}/issues and nothing else: there is deliberately no
 * code path here that could edit, comment on or close an issue. A failure is
 * recorded as `failed` and NOT retried -- a timeout can hide an issue that was
 * in fact created, and a retry would file it twice.
 */
export async function fileIssue(
  id: number,
  record: IssueRecord,
  opts: IssueOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<IssueRecord> {
  if (record.state !== "pending" || !record.repo || !opts.token) return record;
  let next: IssueRecord;
  try {
    const res = await fetchImpl(`${opts.api}/repos/${record.repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: record.title, body: record.body, labels: record.labels }),
      signal: AbortSignal.timeout(15_000),
    });
    const out = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number };
    next = res.ok
      ? { ...record, state: "filed", url: out.html_url ?? null, number: out.number ?? null, detail: `github responded ${res.status}` }
      : { ...record, state: "failed", detail: `github responded ${res.status}` };
  } catch (e) {
    next = { ...record, state: "failed", detail: `request failed: ${(e as Error).message}` };
  }
  db.prepare("UPDATE findings SET issue = ?, issue_state = ? WHERE id = ?").run(JSON.stringify(next), next.state, id);
  return next;
}

/** Every finding that has an issue record, newest first: the audit list. */
export function listIssues(limit = 100) {
  const rows = db
    .prepare(
      `SELECT id, app, check_name, title, issue FROM findings
       WHERE issue IS NOT NULL ORDER BY issue_at DESC, id DESC LIMIT ?`,
    )
    .all(Math.min(500, Math.max(1, limit))) as { id: number; app: string; check_name: string; title: string; issue: string }[];
  return rows.map((r) => ({ id: r.id, app: r.app, check: r.check_name, title: r.title, issue: parse<IssueRecord | null>(r.issue, null) }));
}

// ---------------------------------------------------------------------------
// Verdicts (T4)
// ---------------------------------------------------------------------------

/**
 * Record a person's verdict, or clear it with `verdict: null` (a mis-click
 * should not need SQL to undo).
 *
 * A duplicate points at the finding it duplicates, followed to the root: if B
 * is a duplicate of A and C is marked a duplicate of B, C points at A, so the
 * "this is the same as" graph never grows chains a person has to walk. Marking
 * something a duplicate of itself, or of one of its own duplicates, is refused.
 */
export function setVerdict(
  id: number,
  verdict: Verdict | null,
  note: string | null,
  duplicateOf: number | null,
): { ok: true; finding: FindingView } | ({ ok: false } & { status: 400 | 404; error: string }) {
  const row = getRow(id);
  if (!row) return { ok: false, status: 404, error: `no finding ${id}` };
  if (verdict !== null && !VERDICTS.includes(verdict))
    return { ok: false, status: 400, error: `verdict must be one of ${VERDICTS.join(", ")}, or null to reopen` };
  if (note !== null && note.length > LIMITS.note)
    return { ok: false, status: 400, error: `note is longer than ${LIMITS.note} characters` };

  let target: number | null = null;
  if (verdict === "duplicate") {
    if (duplicateOf === null) return { ok: false, status: 400, error: "a duplicate needs duplicate_of: the id it duplicates" };
    let t = getRow(duplicateOf);
    if (!t) return { ok: false, status: 400, error: `duplicate_of ${duplicateOf} is not a finding` };
    for (let hops = 0; t.verdict === "duplicate" && t.duplicate_of !== null && hops < 20; hops++) {
      const up = getRow(t.duplicate_of);
      if (!up) break;
      t = up;
    }
    if (t.id === id) return { ok: false, status: 400, error: "a finding cannot be a duplicate of itself" };
    target = t.id;
  }

  db.prepare(
    `UPDATE findings SET verdict = ?, verdict_note = ?, verdict_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
                         duplicate_of = ?
     WHERE id = ?`,
  ).run(verdict, verdict === null ? null : note, verdict, target, id);
  return { ok: true, finding: view(getRow(id)!) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ListQuery = { app?: string; check?: string; status?: string; since?: string; limit?: number };

/** The filtered list, newest sighting first, with facets over every row so a filter never empties its own menu. */
export function listFindings(q: ListQuery): { ok: true; body: unknown } | { ok: false; error: string } {
  const where: string[] = [];
  const params: string[] = [];
  if (q.app) { where.push("app = ?"); params.push(q.app); }
  if (q.check) { where.push("check_name = ?"); params.push(q.check); }
  const status = q.status ?? "all";
  if (!["open", "triaged", "all"].includes(status)) return { ok: false, error: "status must be open, triaged or all" };
  if (q.since) {
    const t = Date.parse(q.since);
    if (!Number.isFinite(t)) return { ok: false, error: "since must be an ISO-8601 date or time" };
    where.push("last_seen >= ?");
    params.push(sqliteTime(new Date(t)));
  }
  // Counted before the status filter, so the page can say "3 open, 12 triaged"
  // for whatever app and check are selected.
  const scoped = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const counts = db
    .prepare(
      `SELECT SUM(verdict IS NULL) AS open, SUM(verdict IS NOT NULL) AS triaged, COUNT(*) AS total
       FROM findings ${scoped}`,
    )
    .get(...params) as { open: number | null; triaged: number | null; total: number };
  if (status === "open") where.push("verdict IS NULL");
  if (status === "triaged") where.push("verdict IS NOT NULL");
  const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
  const rows = db
    .prepare(
      `SELECT * FROM findings ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY last_seen DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as Row[];
  return {
    ok: true,
    body: {
      findings: rows.map(view),
      counts: { open: counts.open ?? 0, triaged: counts.triaged ?? 0, total: counts.total },
      apps: (db.prepare("SELECT DISTINCT app FROM findings ORDER BY app").all() as { app: string }[]).map((r) => r.app),
      checks: (db.prepare("SELECT DISTINCT check_name FROM findings ORDER BY check_name").all() as { check_name: string }[])
        .map((r) => r.check_name),
      limit,
    },
  };
}

/** One finding, with the findings a person has marked as duplicates of it. */
export function findingDetail(id: number) {
  const f = getFinding(id);
  if (!f) return null;
  const duplicates = db
    .prepare("SELECT id, title, seen_count FROM findings WHERE duplicate_of = ? ORDER BY id")
    .all(id) as { id: number; title: string; seen_count: number }[];
  const original = f.duplicate_of ? getFinding(f.duplicate_of) : null;
  return {
    ...f,
    duplicates,
    duplicate_of_title: original?.title ?? null,
  };
}

// ---------------------------------------------------------------------------
// Precision (O4)
// ---------------------------------------------------------------------------

export type PrecisionClass = {
  app: string;
  check: CheckName;
  open: number;
  real: number;
  duplicate: number;
  not_a_bug: number;
  agent_mistake: number;
  /** real + not_a_bug + agent_mistake. Duplicates say nothing about whether the check was right. */
  judged: number;
  /** real / judged, or null before anything has been judged. */
  precision: number | null;
  /** precision < 0.30 with at least `min` judged: the workload should stop running this check for this app. */
  disabled: boolean;
};

/**
 * How often each check is right, per app.
 *
 * A duplicate is excluded from both sides: it was a real problem or a false
 * one when first judged, and counting it again would let one noisy finding
 * that recurs nightly decide its class's fate on its own.
 */
export function precision(opts: { app?: string; min?: number } = {}) {
  const min = Math.max(1, Math.floor(opts.min ?? PRECISION_MIN_JUDGED));
  const rows = db
    .prepare(
      `SELECT app, check_name, verdict, COUNT(*) AS n FROM findings
       ${opts.app ? "WHERE app = ?" : ""}
       GROUP BY app, check_name, verdict ORDER BY app, check_name`,
    )
    .all(...(opts.app ? [opts.app] : [])) as { app: string; check_name: CheckName; verdict: Verdict | null; n: number }[];

  const byKey = new Map<string, PrecisionClass>();
  for (const r of rows) {
    const key = `${r.app}\u0000${r.check_name}`;
    let c = byKey.get(key);
    if (!c) {
      c = { app: r.app, check: r.check_name, open: 0, real: 0, duplicate: 0, not_a_bug: 0, agent_mistake: 0, judged: 0, precision: null, disabled: false };
      byKey.set(key, c);
    }
    c[r.verdict ?? "open"] += r.n;
  }
  const classes = [...byKey.values()].map((c) => {
    const judged = c.real + c.not_a_bug + c.agent_mistake;
    const p = judged > 0 ? c.real / judged : null;
    return { ...c, judged, precision: p, disabled: p !== null && p < PRECISION_FLOOR && judged >= min };
  });
  return {
    floor: PRECISION_FLOOR,
    min,
    classes,
    // What the workload actually reads at the start of a night.
    disabled: classes.filter((c) => c.disabled).map((c) => ({ app: c.app, check: c.check, precision: c.precision, judged: c.judged })),
  };
}

// ---------------------------------------------------------------------------
// The morning digest (T5)
// ---------------------------------------------------------------------------

export type Digest = {
  hours: number;
  since: string;
  total: number;
  new: number;
  again: number;
  apps: {
    app: string;
    count: number;
    new: number;
    again: number;
    top: { id: number; severity: string; check: string; title: string; screen_name: string; replay: string; new: boolean; seen_count: number }[];
  }[];
  link: string;
  text: string;
};

const TOP_PER_APP = 5;
/** ntfy turns a body past 4 KB into an attachment; a digest should read as a notification. */
const DIGEST_MAX_CHARS = 3_500;

/**
 * Findings first seen, or seen again, in the last `hours`, grouped by app.
 *
 * Findings a person already called not a bug, an agent's mistake or a
 * duplicate are left out: the digest is a list of things to look at, and those
 * have been looked at. Real ones stay in, because "the crash you confirmed
 * yesterday happened again on tonight's build" is news.
 */
export function buildDigest(hours: number, dashUrl: string = DASH_URL, now = new Date()): Digest {
  const since = new Date(now.getTime() - hours * 3600_000);
  const rows = db
    .prepare(
      `SELECT * FROM findings
       WHERE last_seen >= ? AND (verdict IS NULL OR verdict = 'real')
       ORDER BY app,
                CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                seen_count DESC, id`,
    )
    .all(sqliteTime(since)) as Row[];

  const sinceKey = sqliteTime(since);
  const apps: Digest["apps"] = [];
  for (const r of rows) {
    let a = apps.find((x) => x.app === r.app);
    if (!a) {
      a = { app: r.app, count: 0, new: 0, again: 0, top: [] };
      apps.push(a);
    }
    const isNew = r.first_seen >= sinceKey;
    a.count += 1;
    if (isNew) a.new += 1;
    else a.again += 1;
    if (a.top.length < TOP_PER_APP)
      a.top.push({
        id: r.id, severity: r.severity, check: r.check_name, title: r.title, screen_name: r.screen_name,
        replay: replayLabel(parse<Replay>(r.replay, null), r.check_name), new: isNew, seen_count: r.seen_count,
      });
  }
  const total = rows.length;
  const fresh = apps.reduce((n, a) => n + a.new, 0);
  const link = `${dashUrl}/dash/findings?status=open`;

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [];
  if (total === 0) {
    lines.push(`Night QA, last ${hours}h: nothing new.`);
  } else {
    lines.push(
      `Night QA, last ${hours}h: ${plural(total, "finding")} (${fresh} new, ${total - fresh} seen again) in ${plural(apps.length, "app")}.`,
    );
    for (const a of apps) {
      lines.push("", `${a.app}: ${a.count} (${a.new} new, ${a.again} again)`);
      for (const t of a.top) {
        const where = t.screen_name ? ` on ${t.screen_name}` : "";
        const seen = t.new ? "" : `, seen ${t.seen_count}x`;
        lines.push(`- [${t.severity}] ${t.check}: ${t.title}${where} (${t.replay}${seen})`);
      }
      if (a.count > a.top.length) lines.push(`- and ${a.count - a.top.length} more`);
    }
    lines.push("", `Triage: ${link}`);
  }
  let text = lines.join("\n");
  if (text.length > DIGEST_MAX_CHARS) text = `${text.slice(0, DIGEST_MAX_CHARS - 40).trimEnd()}\n...\nTriage: ${link}`;
  return { hours, since: since.toISOString(), total, new: fresh, again: total - fresh, apps, link, text };
}

/** Local calendar day, YYYY-MM-DD: "once a day" is the owner's day, not UTC's. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Whether the digest should go now: it is at or past HH:MM local, and today's
 * has not run. "At or past" rather than "at" so a collector that was down at
 * 07:00 sends when it comes back rather than skipping the day.
 */
export function digestDue(now: Date, at: string, lastDay: string | null): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(at);
  if (!m) return false;
  if (now.getHours() * 60 + now.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return false;
  return lastDay !== localDay(now);
}

export type DigestTickOptions = {
  at: string | null;
  hours: number;
  webhook: string | undefined;
  dashUrl: string;
  log: (o: object, m: string) => void;
};

/**
 * Called every minute by the collector. Sends at most one digest per local day,
 * and none at all when nothing is new -- a notification that says "nothing"
 * every morning trains its reader to swipe it away unread.
 *
 * The day is claimed in the database BEFORE the send, the same way alerts mark
 * themselves notified before awaiting the webhook: a webhook that hangs past
 * the next tick must not produce a second digest.
 */
export async function digestTick(
  now: Date,
  opts: DigestTickOptions,
): Promise<{ ran: boolean; sent: boolean; count: number }> {
  if (!opts.at || !opts.webhook) return { ran: false, sent: false, count: 0 };
  const last = db.prepare("SELECT day FROM findings_digests ORDER BY day DESC LIMIT 1").get() as { day: string } | undefined;
  if (!digestDue(now, opts.at, last?.day ?? null)) return { ran: false, sent: false, count: 0 };

  const digest = buildDigest(opts.hours, opts.dashUrl, now);
  const claimed = db
    .prepare("INSERT OR IGNORE INTO findings_digests (day, count, posted, detail) VALUES (?, ?, 0, ?)")
    .run(localDay(now), digest.total, digest.total === 0 ? "nothing new; not sent" : "sending").changes;
  if (!claimed) return { ran: false, sent: false, count: 0 };
  if (digest.total === 0) return { ran: true, sent: false, count: 0 };

  const sent = await sendWebhook(
    { title: "fleet: night QA", body: digest.text, tags: "mag", click: digest.link },
    opts.log,
    opts.webhook,
  );
  db.prepare("UPDATE findings_digests SET posted = ?, detail = ? WHERE day = ?").run(
    sent ? 1 : 0, sent ? "sent" : "webhook failed; see the collector log", localDay(now),
  );
  return { ran: true, sent, count: digest.total };
}

/** The live settings for the timer in server.ts. */
export function digestTickOptions(log: DigestTickOptions["log"]): DigestTickOptions {
  return {
    at: FINDINGS_DIGEST_AT,
    hours: FINDINGS_DIGEST_HOURS,
    webhook: process.env.FLEET_ALERT_WEBHOOK,
    dashUrl: DASH_URL,
    log,
  };
}
