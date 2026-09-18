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
}
