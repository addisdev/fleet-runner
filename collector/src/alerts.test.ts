/**
 * Which devices raise an offline alert, checked against a real database.
 *
 * Both cases here are things that actually went wrong on the shelf, and neither
 * was visible to a suite that only exercises a fresh collector. On 2026-09-17
 * the live brain held **79 open `device-offline` alerts against 6 real
 * devices**, some with `seen_count` past 33,000. Every one of the other 73 was
 * a row nobody could have acted on:
 *
 * - **Unnamed rows.** Simulators an executor reported once, fixture devices a
 *   smoke run registered, a phone that joined from the desk for one benchmark.
 *   A name is the operator saying "this one is mine"; nothing else in the
 *   schema distinguishes a device that belongs on the shelf from one that
 *   wandered past.
 * - **Expired ephemeral agents.** An agent that registers with `ttl_s` has said
 *   it is temporary. The queue stops offering it work and the shelf stops
 *   listing it (`api/shared.ts` isExpired), but the alert engine read neither,
 *   so a closed browser tab raised an offline alert that nothing could resolve
 *   -- the row it complains about is one the dashboard will not even show.
 *
 * An alert channel nobody reads is the failure the alerting exists to avoid, so
 * a rule that fires 13 times per real fault is a broken rule, not a loud one.
 *
 * `last_seen` is written directly here because the age is the whole point: the
 * offline threshold is fifteen minutes and a suite cannot wait for it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, openDb } from "./db.js";
import { evaluate } from "./alerts.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

/** A temp database that cleans itself up even when a check throws. */
function inTempDir<T>(fn: (dir: string) => T): T {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-alerts-test-"));
  try {
    return fn(dir);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_SIZES = { dbBytes: 0, logBytes: 0 };

export function runAlertChecks(check: Check) {
  inTempDir((dir) => {
    const db = openDb(dir);

    // Silent for an hour, four ways. The only difference between them is the
    // one the rule is supposed to read.
    const add = (id: string, name: string | null, ttlS: number | null) =>
      db
        .prepare(
          `INSERT INTO devices (device_id, descriptor, pools, name, ttl_s, last_seen)
           VALUES (?, '{"model":"AlertTest"}', '[]', ?, ?, datetime('now','-3600 seconds'))`,
        )
        .run(id, name, ttlS);

    add("named-shelf-phone", "Galaxy S8+ (shelf)", null);
    add("unnamed-passer-by", null, null);
    add("named-but-expired", "a browser tab somebody named", 300);
    add("unnamed-and-expired", null, 300);

    const offline = evaluate(new Date(), NO_SIZES).filter((f) => f.rule === "device-offline");
    const subjects = offline.map((f) => f.subject).sort();

    check(
      "a named device that went quiet raises an offline alert",
      subjects.includes("named-shelf-phone"),
      JSON.stringify(subjects),
    );
    check(
      "an unnamed device does not",
      !subjects.includes("unnamed-passer-by"),
      JSON.stringify(subjects),
    );
    // Expiry beats the name: the agent said when to stop believing in it, and
    // an operator's label does not override the agent's own declaration.
    check(
      "an expired ephemeral agent does not, even when it has a name",
      !subjects.includes("named-but-expired"),
      JSON.stringify(subjects),
    );
    check(
      "nor when it has neither",
      !subjects.includes("unnamed-and-expired"),
      JSON.stringify(subjects),
    );
    check(
      "so one real fault is one alert, not four",
      offline.length === 1,
      `${offline.length} alerts: ${JSON.stringify(subjects)}`,
    );

    // The alert still has to be useful to whoever reads it: the name is what a
    // person recognises, the id is what they act on, so it carries both.
    const msg = offline[0]?.message ?? "";
    check(
      "the alert names the device and its id",
      msg.includes("Galaxy S8+ (shelf)") && msg.includes("named-shelf-phone"),
      msg,
    );
  });

  // A device inside its TTL is present, not expired -- the rule must not
  // silence an agent that is merely young. Guards against "skip anything with a
  // ttl_s", which would have passed every check above.
  inTempDir((dir) => {
    const db = openDb(dir);
    db.prepare(
      `INSERT INTO devices (device_id, descriptor, pools, name, ttl_s, last_seen)
       VALUES ('within-its-ttl', '{"model":"AlertTest"}', '[]', 'a tab that is still open',
               7200, datetime('now','-3600 seconds'))`,
    ).run();

    const offline = evaluate(new Date(), NO_SIZES).filter((f) => f.rule === "device-offline");
    check(
      "an ephemeral agent still inside its TTL alerts like any other device",
      offline.length === 1 && offline[0].subject === "within-its-ttl",
      JSON.stringify(offline.map((f) => f.subject)),
    );
  });

  // A laptop somebody carries is not a shelf phone. `personal` exempts it from
  // low-battery -- which alerted its owner about their own laptop twice in one
  // week -- and from nothing else: thermal still counts.
  inTempDir((dir) => {
    const db = openDb(dir);
    const add = (id: string, pools: string, battery: number, thermal = "nominal") =>
      db.prepare(
        `INSERT INTO devices (device_id, descriptor, pools, name, last_seen, last_beacon)
         VALUES (?, '{"model":"AlertTest"}', ?, ?, datetime('now'), ?)`,
      ).run(id, pools, id, JSON.stringify({ battery_pct: battery, charging: false, thermal }));
    add("shelf-phone", '["ml-capable"]', 9);
    add("daily-laptop", '["personal"]', 9);
    add("hot-daily-laptop", '["personal"]', 9, "critical");

    const found = evaluate(new Date(), NO_SIZES);
    const battery = found.filter((f) => f.rule === "low-battery").map((f) => f.subject);
    const thermal = found.filter((f) => f.rule === "thermal-critical").map((f) => f.subject);
    check("a shelf phone at 9% and not charging still raises low-battery", battery.includes("shelf-phone"),
      JSON.stringify(battery));
    check("a laptop in the personal pool does not", !battery.includes("daily-laptop"), JSON.stringify(battery));
    check("but a personal laptop that is thermally critical still alerts", thermal.includes("hot-daily-laptop"),
      JSON.stringify(thermal));
  });

  // A schedule that keeps skipping. The tvloop nightly skipped every night for
  // two weeks on a missing Roku password and nothing said so; its job ids are
  // the scheduler's `<schedule>-<YYYYMMDDHHMM>`, which is how a run is found
  // even on a brain whose old jobs carry no requested_by.
  inTempDir((dir) => {
    const db = openDb(dir);
    const schedule = (id: string) =>
      db.prepare("INSERT INTO schedules (id, cron, template, enabled, last_run) VALUES (?, '30 6 * * *', '{}', 1, NULL)").run(id);
    const job = (id: string, status: string, lastError: string | null = null) =>
      db.prepare(
        `INSERT INTO jobs (job_id, executor, workload, spec, status, last_error, finished_at)
         VALUES (?, 'host', 'tvloop', '{}', ?, ?, ${status === "queued" || status === "claimed" ? "NULL" : "datetime('now')"})`,
      ).run(id, status, lastError);
    const NO_PW = "skipped: no Roku developer password on this host";

    schedule("nightly-tvloop-hardware");
    job("nightly-tvloop-hardware-202610120630", "done");
    job("nightly-tvloop-hardware-202610130630", "skipped", NO_PW);
    job("nightly-tvloop-hardware-202610140630", "skipped", NO_PW);
    job("nightly-tvloop-hardware-202610150630", "skipped", NO_PW);
    // A schedule whose id is a prefix of this one must not borrow its runs.
    schedule("nightly-tvloop");
    job("nightly-tvloop-202610150630", "done");
    // Two skips are not a streak yet.
    schedule("nightly-two");
    job("nightly-two-202610140630", "skipped", "skipped: locked");
    job("nightly-two-202610150630", "skipped", "skipped: locked");
    // A fan-out where every child skipped, for different reasons, three nights.
    schedule("nightly-fan");
    for (const day of ["13", "14", "15"]) {
      job(`nightly-fan-202610${day}0230--phone-a`, "skipped", "skipped: com.example not installed");
      job(`nightly-fan-202610${day}0230--phone-b`, "skipped", day === "15" ? "skipped: device locked by another job" : "skipped: com.example not installed");
    }
    // Three skips and then a run in flight: the in-flight one has not said
    // anything yet, so the streak stands.
    schedule("nightly-inflight");
    for (const day of ["12", "13", "14"]) job(`nightly-inflight-202610${day}0230`, "skipped", "skipped: no device matches this job on ultra");
    job("nightly-inflight-202610150230", "claimed");

    const skipping = () => evaluate(new Date(), NO_SIZES).filter((f) => f.rule === "schedule-skipping");
    const found = skipping();
    const bySubject = new Map(found.map((f) => [f.subject, f]));
    check("stale skip: three skips in a row raise one alert", bySubject.has("nightly-tvloop-hardware"), JSON.stringify(found));
    check("stale skip: naming the schedule and the reason it keeps giving",
      bySubject.get("nightly-tvloop-hardware")?.message ===
        "nightly-tvloop-hardware has skipped 3 runs in a row: no Roku developer password on this host",
      bySubject.get("nightly-tvloop-hardware")?.message);
    check("stale skip: a schedule's runs are its own, not a longer id's", !bySubject.has("nightly-tvloop"));
    check("stale skip: two skips are not a streak", !bySubject.has("nightly-two"));
    check("stale skip: a fan-out whose every child skipped counts as a skipped run", bySubject.has("nightly-fan"));
    check("stale skip: a run still in flight neither breaks nor extends the streak", bySubject.has("nightly-inflight"));
    check("stale skip: one alert per schedule", found.length === 3, JSON.stringify(found.map((f) => f.subject)));

    // A run that is not a skip resolves it.
    job("nightly-tvloop-hardware-202610160630", "failed", "smoke: Assertion is false");
    check("stale skip: the first run that is not a skip clears it",
      !skipping().some((f) => f.subject === "nightly-tvloop-hardware"));
    // Disabled schedules are not watched.
    db.prepare("UPDATE schedules SET enabled = 0 WHERE id = 'nightly-fan'").run();
    check("stale skip: a disabled schedule is not watched", !skipping().some((f) => f.subject === "nightly-fan"));
  });
}
