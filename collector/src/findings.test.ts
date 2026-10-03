/**
 * Night-QA findings, checked against a real database in a temp directory.
 *
 * The HTTP surface is exercised by scripts/smoke.ts against a throwaway
 * collector. What is checked here is the part a running collector cannot show
 * on demand: the 24-hour issue cap (a suite cannot wait a day, so timestamps
 * are written directly), filing when ARMED (against a fake GitHub on a
 * loopback port -- nothing here ever reaches the real one), and the digest
 * timer's once-a-day rule, which depends on the wall clock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, db, openDb } from "./db.js";
import {
  ISSUE_CAP_PER_DAY,
  buildDigest,
  digestDue,
  digestTick,
  fileIssue,
  localDay,
  precision,
  setVerdict,
  storeFinding,
  validateFinding,
  type IssueOptions,
} from "./findings.js";
import type { ExploreFinding } from "./workloads/explore/types.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const SHA = (c: string) => c.repeat(64);

export function sample(over: Partial<ExploreFinding> = {}): ExploreFinding {
  return {
    fingerprint: "fp-1",
    app: "plants",
    build: "1.0 (1)",
    platform: "android",
    device_id: "emulator-5554",
    job_id: "explore-1",
    mission_id: "add-a-plant",
    check: "frozen",
    severity: "medium",
    title: "Save button does nothing",
    detail: "The screen did not change for 20 s after tapping Save.",
    screen: "scr-1",
    screen_name: "Add plant",
    steps: ["Open the app", "Tap Add", "Tap Save"],
    replay: { kind: "maestro", sha256: SHA("a"), attempts: 2, reproduced: 2 },
    artifacts: { shot: SHA("b") },
    ...over,
  };
}

const DRY: IssueOptions = {
  repos: { plants: "example/plants" },
  armed: false,
  token: undefined,
  api: "http://127.0.0.1:9",
  dashUrl: "http://fleet.test:8788",
  capPerDay: ISSUE_CAP_PER_DAY,
};

async function inTempDb<T>(fn: () => Promise<T> | T): Promise<T> {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-findings-test-"));
  openDb(dir);
  try {
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A loopback HTTP server that records what it is sent and answers `status`. */
async function recorder(status: number, answer: unknown) {
  const got: { url: string; headers: IncomingMessage["headers"]; body: string; method: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ url: req.url ?? "", headers: req.headers, body, method: req.method ?? "" });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { got, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function runFindingsChecks(check: Check) {
  // --- validation, which needs no database ---
  {
    const ok = validateFinding(sample());
    check("findings: a well-formed finding validates", ok.ok, JSON.stringify(ok));
    const crashNoReplay = validateFinding(sample({ check: "crash", replay: null }));
    check("findings: a crash may come without a replay", crashNoReplay.ok);
    const noReplay = validateFinding(sample({ replay: null }));
    check("findings: anything else without a replay is 422",
      !noReplay.ok && noReplay.status === 422, JSON.stringify(noReplay));
    const zero = validateFinding(sample({ replay: { kind: "maestro", sha256: null, attempts: 3, reproduced: 0 } }));
    check("findings: a replay that reproduced 0 times is 422 with a reason",
      !zero.ok && zero.status === 422 && /0 of 3/.test(zero.error), JSON.stringify(zero));
    const zeroCrash = validateFinding(sample({ check: "crash", replay: { kind: "maestro", sha256: null, attempts: 2, reproduced: 0 } }));
    check("findings: ...including for a crash that sent one", !zeroCrash.ok && zeroCrash.status === 422);
    const unknown = validateFinding({ ...sample(), check: "vibes" });
    check("findings: an unknown check name is 400", !unknown.ok && unknown.status === 400 && /vibes/.test(unknown.error));
    check("findings: the newer check names are accepted",
      validateFinding(sample({ check: "dead_control" })).ok && validateFinding(sample({ check: "leash" })).ok);
    const noFp = validateFinding({ ...sample(), fingerprint: "" });
    check("findings: a missing fingerprint is 400", !noFp.ok && noFp.status === 400 && /fingerprint/.test(noFp.error));
    const big = validateFinding(sample({ detail: "x".repeat(9000) }));
    check("findings: an oversized detail is 400", !big.ok && big.status === 400 && /detail/.test(big.error));
    const manySteps = validateFinding(sample({ steps: Array.from({ length: 101 }, () => "tap") }));
    check("findings: more than 100 steps is 400", !manySteps.ok && manySteps.status === 400);
    const badArt = validateFinding({ ...sample(), artifacts: { photo: SHA("c") } });
    check("findings: an unknown artifact key is 400", !badArt.ok && badArt.status === 400);
    const badSha = validateFinding({ ...sample(), artifacts: { shot: "not-a-hash" } });
    check("findings: an artifact that is not a sha256 is 400", !badSha.ok && badSha.status === 400);
    const over = validateFinding(sample({ replay: { kind: "maestro", sha256: null, attempts: 1, reproduced: 2 } }));
    check("findings: reproduced > attempts is 400", !over.ok && over.status === 400);
  }

  // --- store, dedupe, issues ---
  await inTempDb(() => {
    const first = storeFinding(sample(), DRY);
    check("findings: the first sighting inserts", first.isNew && first.finding.seen_count === 1);
    check("findings: a fully reproduced finding gets a dry-run issue",
      first.issue?.state === "dry_run" && first.issue.dry_run === true && first.issue.repo === "example/plants",
      JSON.stringify(first.issue));
    check("findings: the issue carries the night-qa label and a dashboard link",
      !!first.issue && first.issue.labels.includes("night-qa") &&
      first.issue.body.includes(`http://fleet.test:8788/dash/findings/${first.finding.id}`) &&
      first.issue.body.includes("Tap Save") && first.issue.title.includes("Save button does nothing"));

    const again = storeFinding(
      sample({
        build: "1.0 (2)", job_id: "explore-2", title: "A different wording",
        replay: { kind: "maestro", sha256: SHA("d"), attempts: 3, reproduced: 3 },
        artifacts: { shot: SHA("e"), log: SHA("f"), replay: SHA("d") },
        severity: "high",
      }),
      DRY,
    );
    const f = again.finding;
    check("findings: the same fingerprint merges", !again.isNew && f.id === first.finding.id && f.seen_count === 2);
    check("findings: the new build is added to builds_seen", f.builds_seen.join(",") === "1.0 (1),1.0 (2)", f.builds_seen.join(","));
    check("findings: the original title is kept", f.title === "Save button does nothing");
    check("findings: the replay that reproduced more replaces the old one", f.replay?.reproduced === 3);
    check("findings: the first screenshot is kept, the missing log is filled in",
      f.artifacts.shot === SHA("b") && f.artifacts.log === SHA("f") && f.artifacts.replay === SHA("d"),
      JSON.stringify(f.artifacts));
    check("findings: severity only goes up", f.severity === "high");
    check("findings: a repeat does not compose a second issue", again.issue === null);
    storeFinding(sample({ build: "1.0 (2)", replay: { kind: "maestro", sha256: null, attempts: 2, reproduced: 1 } }), DRY);
    const third = db.prepare("SELECT builds_seen, replay FROM findings WHERE id = ?").get(f.id) as { builds_seen: string; replay: string };
    check("findings: a repeat build is not listed twice, and a weaker replay does not win",
      JSON.parse(third.builds_seen).length === 2 && JSON.parse(third.replay).reproduced === 3);

    const flaky = storeFinding(sample({ fingerprint: "fp-flaky", replay: { kind: "maestro", sha256: null, attempts: 2, reproduced: 1 } }), DRY);
    check("findings: a flaky finding is stored but gets no issue", flaky.isNew && flaky.issue === null && flaky.finding.replay_label === "flaky 1/2");
    const crash = storeFinding(sample({ fingerprint: "fp-crash", check: "crash", replay: null }), DRY);
    check("findings: a crash with no replay gets an issue", crash.issue?.state === "dry_run" && crash.finding.replay_label === "crash log");

    const noRepo = storeFinding(sample({ fingerprint: "fp-other", app: "unmapped" }), DRY);
    check("findings: an app with no mapped repo is recorded as no_repo, still a dry run",
      noRepo.issue?.state === "no_repo" && noRepo.issue.dry_run === true);

    // The cap: plants has 2 issues (fp-1, fp-crash). Three more fill it; the
    // sixth is capped. Then age them all past 24 h and the capped one goes on
    // its next sighting.
    const more = [3, 4, 5].map((n) => storeFinding(sample({ fingerprint: `fp-cap-${n}` }), DRY));
    check("findings: up to five issues a day per app", more.every((m) => m.issue?.state === "dry_run"));
    const sixth = storeFinding(sample({ fingerprint: "fp-cap-6" }), DRY);
    check("findings: the sixth in 24 h is capped", sixth.issue?.state === "capped" && sixth.issue.dry_run === true,
      JSON.stringify(sixth.issue));
    const otherApp = storeFinding(sample({ fingerprint: "fp-cap-other", app: "birds" }), { ...DRY, repos: { birds: "example/birds" } });
    check("findings: the cap is per app", otherApp.issue?.state === "dry_run");
    db.prepare("UPDATE findings SET issue_at = datetime('now', '-25 hours') WHERE issue_state = 'dry_run'").run();
    const retried = storeFinding(sample({ fingerprint: "fp-cap-6", build: "1.0 (3)" }), DRY);
    check("findings: a capped finding is composed again once the day has passed", retried.issue?.state === "dry_run");

    // Verdicts.
    const v = setVerdict(first.finding.id, "real", "confirmed on a Pixel", null);
    check("findings: a verdict is recorded with its note",
      v.ok && v.finding.verdict === "real" && v.finding.verdict_note === "confirmed on a Pixel" && v.finding.status === "triaged");
    const d1 = setVerdict(flaky.finding.id, "duplicate", null, first.finding.id);
    const d2 = setVerdict(crash.finding.id, "duplicate", null, flaky.finding.id);
    check("findings: a duplicate of a duplicate points at the original",
      d1.ok && d2.ok && d2.finding.duplicate_of === first.finding.id, JSON.stringify(d2));
    const self = setVerdict(first.finding.id, "duplicate", null, crash.finding.id);
    check("findings: a finding cannot become a duplicate of its own duplicate", !self.ok && self.status === 400);
    const noTarget = setVerdict(first.finding.id, "duplicate", null, null);
    check("findings: duplicate without duplicate_of is refused", !noTarget.ok);
    const reopened = setVerdict(crash.finding.id, null, null, null);
    check("findings: verdict null reopens", reopened.ok && reopened.finding.status === "open" && reopened.finding.duplicate_of === null);
    check("findings: an unknown verdict is refused", !setVerdict(1, "meh" as never, null, null).ok);
    check("findings: a verdict on a missing finding is 404", (() => { const r = setVerdict(99999, "real", null, null); return !r.ok && r.status === 404; })());
  });

  // --- precision ---
  await inTempDb(() => {
    // visual: 2 real, 8 not a bug, 1 duplicate -> 20% of 10 judged: switched off.
    // goal: 1 real, 2 agent mistakes -> 33%: above the floor anyway.
    // frozen: 0 real, 3 not a bug -> 0%, but only 3 judged: not enough to decide.
    let n = 0;
    const add = (check: ExploreFinding["check"], verdict: string | null, dupOf: number | null = null) => {
      const r = storeFinding(sample({ fingerprint: `p-${n++}`, check }), DRY);
      if (verdict) setVerdict(r.finding.id, verdict as never, null, dupOf);
      return r.finding.id;
    };
    const anchor = add("visual", "real");
    add("visual", "real");
    for (let i = 0; i < 8; i++) add("visual", "not_a_bug");
    add("visual", "duplicate", anchor);
    add("visual", null);
    add("goal", "real");
    add("goal", "agent_mistake");
    add("goal", "agent_mistake");
    for (let i = 0; i < 3; i++) add("frozen", "not_a_bug");

    const p = precision({ min: 10 });
    const cls = (c: string) => p.classes.find((x) => x.check === c)!;
    const visual = cls("visual");
    check("precision: duplicates are excluded from judged", visual.judged === 10 && visual.duplicate === 1 && visual.open === 1,
      JSON.stringify(visual));
    check("precision: real / (real + not_a_bug + agent_mistake)", Math.abs((visual.precision ?? -1) - 0.2) < 1e-9);
    check("precision: under 30% with 10 judged is switched off", visual.disabled);
    check("precision: 1 of 3 is above the floor", Math.abs((cls("goal").precision ?? 0) - 1 / 3) < 1e-9 && !cls("goal").disabled);
    check("precision: 0% of 3 judged is not enough to switch off", cls("frozen").precision === 0 && !cls("frozen").disabled);
    check("precision: min is a parameter", precision({ min: 3 }).classes.find((x) => x.check === "frozen")!.disabled);
    check("precision: the disabled list is what the workload reads",
      p.disabled.length === 1 && p.disabled[0].check === "visual" && p.disabled[0].app === "plants");
    check("precision: filtering by app", precision({ app: "nobody" }).classes.length === 0);
  });

  // --- digest ---
  await inTempDb(async () => {
    const empty = buildDigest(12, "http://fleet.test:8788");
    check("digest: nothing new says so", empty.total === 0 && /nothing new/.test(empty.text));

    const a = storeFinding(sample({ fingerprint: "d-1", severity: "high", check: "crash", replay: null, title: "Crash on save" }), DRY);
    storeFinding(sample({ fingerprint: "d-2", title: "Blank list" , check: "blank" }), DRY);
    const old = storeFinding(sample({ fingerprint: "d-3", app: "birds", title: "Old frozen spinner" }), DRY);
    const judged = storeFinding(sample({ fingerprint: "d-4", title: "Not actually a bug" }), DRY);
    const stale = storeFinding(sample({ fingerprint: "d-5", title: "From last week" }), DRY);
    setVerdict(judged.finding.id, "not_a_bug", null, null);
    // d-3 was first seen two days ago and seen again now; d-5 not since.
    db.prepare("UPDATE findings SET first_seen = datetime('now', '-2 days') WHERE id = ?").run(old.finding.id);
    db.prepare("UPDATE findings SET first_seen = datetime('now', '-7 days'), last_seen = datetime('now', '-7 days') WHERE id = ?")
      .run(stale.finding.id);

    const d = buildDigest(12, "http://fleet.test:8788");
    check("digest: counts new and seen-again, leaves out judged and stale", d.total === 3 && d.new === 2 && d.again === 1,
      JSON.stringify({ total: d.total, new: d.new, again: d.again }));
    check("digest: grouped by app", d.apps.map((x) => x.app).join(",") === "birds,plants");
    check("digest: the text names the apps, the titles and the link",
      /plants: 2 \(2 new, 0 again\)/.test(d.text) && /birds: 1 \(0 new, 1 again\)/.test(d.text) &&
      d.text.includes("[high] crash: Crash on save on Add plant (crash log)") &&
      d.text.includes("Triage: http://fleet.test:8788/dash/findings?status=open"), d.text);
    check("digest: high severity first", d.apps[1].top[0].id === a.finding.id);
    check("digest: judged-not-a-bug is left out", !d.text.includes("Not actually a bug"));

    // The timer.
    const at7 = new Date(2026, 9, 3, 7, 0);
    check("digest timer: not before HH:MM", !digestDue(new Date(2026, 9, 3, 6, 59), "07:00", null));
    check("digest timer: due at HH:MM", digestDue(at7, "07:00", null));
    check("digest timer: not twice in a day", !digestDue(new Date(2026, 9, 3, 9, 0), "07:00", localDay(at7)));
    check("digest timer: due again the next day", digestDue(new Date(2026, 9, 4, 7, 5), "07:00", localDay(at7)));

    const hook = await recorder(200, {});
    try {
      const log = () => {};
      const off = await digestTick(at7, { at: "07:00", hours: 12, webhook: undefined, dashUrl: "http://fleet.test:8788", log });
      check("digest timer: no webhook, no run", !off.ran && hook.got.length === 0);
      const opts = { at: "07:00", hours: 12, webhook: hook.url, dashUrl: "http://fleet.test:8788", log };
      const now = new Date();
      const early = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
      const r1 = await digestTick(new Date(now.getTime()), { ...opts, at: "00:00" });
      check("digest timer: sends once when due", r1.sent && hook.got.length === 1, JSON.stringify(r1));
      check("digest timer: the body is the digest text, ntfy-shaped",
        hook.got[0]?.body.includes("Crash on save") && hook.got[0]?.headers.title === "fleet: night QA" &&
        hook.got[0]?.headers.click === "http://fleet.test:8788/dash/findings?status=open");
      const r2 = await digestTick(new Date(now.getTime() + 60_000), { ...opts, at: "00:00" });
      check("digest timer: and not again the same day", !r2.ran && hook.got.length === 1);
      // Nothing new: a fresh day whose window holds nothing is recorded, not sent.
      db.prepare("UPDATE findings SET last_seen = datetime('now', '-3 days')").run();
      const tomorrow = new Date(early.getTime() + 36 * 3600_000);
      const r3 = await digestTick(tomorrow, { ...opts, at: "00:00", hours: 1 });
      const row = db.prepare("SELECT count, posted FROM findings_digests WHERE day = ?").get(localDay(tomorrow)) as
        { count: number; posted: number } | undefined;
      check("digest timer: nothing new is not sent", r3.ran && !r3.sent && hook.got.length === 1 && row?.count === 0 && row.posted === 0);
    } finally {
      await hook.close();
    }
  });

  // --- filing, armed, against a fake GitHub ---
  await inTempDb(async () => {
    const gh = await recorder(201, { html_url: "https://github.example/example/plants/issues/7", number: 7 });
    try {
      const armed: IssueOptions = { ...DRY, armed: true, token: "test-token", api: gh.url };
      const r = storeFinding(sample({ fingerprint: "gh-1" }), armed);
      check("issues: armed and authenticated, the plan is pending rather than a dry run",
        r.issue?.state === "pending" && r.issue.dry_run === false);
      const filed = await fileIssue(r.finding.id, r.issue!, armed);
      const req = gh.got[0];
      check("issues: it POSTs to /repos/{owner}/{repo}/issues and nothing else",
        gh.got.length === 1 && req.method === "POST" && req.url === "/repos/example/plants/issues", JSON.stringify(req?.url));
      const sent = JSON.parse(req?.body ?? "{}");
      check("issues: with the title, body and night-qa label",
        sent.title === r.issue!.title && sent.body === r.issue!.body && sent.labels?.[0] === "night-qa");
      check("issues: authenticated with the token", req?.headers.authorization === "Bearer test-token");
      check("issues: the url is stored", filed.state === "filed" && filed.url === "https://github.example/example/plants/issues/7" && filed.number === 7);
      const stored = db.prepare("SELECT issue_state FROM findings WHERE id = ?").get(r.finding.id) as { issue_state: string };
      check("issues: and the row says filed", stored.issue_state === "filed");

      const armedNoToken = storeFinding(sample({ fingerprint: "gh-2" }), { ...armed, token: undefined });
      check("issues: armed without a token stays a dry run", armedNoToken.issue?.state === "dry_run");
    } finally {
      await gh.close();
    }
    const down = await recorder(500, { message: "nope" });
    try {
      const armed: IssueOptions = { ...DRY, armed: true, token: "t", api: down.url };
      const r = storeFinding(sample({ fingerprint: "gh-3" }), armed);
      const failed = await fileIssue(r.finding.id, r.issue!, armed);
      check("issues: a GitHub error is recorded as failed, with the status", failed.state === "failed" && /500/.test(failed.detail));
      const again = storeFinding(sample({ fingerprint: "gh-3", build: "2" }), armed);
      check("issues: a failed filing is not retried (it may have been created)", again.issue === null && down.got.length === 1);
    } finally {
      await down.close();
    }
  });
}
