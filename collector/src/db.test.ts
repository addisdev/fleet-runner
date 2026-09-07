/**
 * The database layer, checked against real SQLite files in a temp directory.
 *
 * Every case here is something the move from `better-sqlite3` to `node:sqlite`
 * could have broken silently. That is the shape of the risk: the two drivers
 * agree on `prepare`, `run`, `get` and `all`, so a suite that exercises the
 * happy path passes on either one and says nothing about the four places they
 * differ — transactions, the lifecycle, error codes, and what a migration does
 * to a database that already has rows in it.
 *
 * The last of those is the one that actually bit. The jobs-table rebuild is a
 * no-op on a fresh database, because the CREATE TABLE beside it already names
 * every status; only somebody's existing collector runs it. So a rebuild that
 * had stopped running was invisible to the entire suite, and would have
 * surfaced as a constraint error the first time a dependency chain set a job
 * 'waiting' on a database made before that status existed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, db, dbFile, isUniqueViolation, openDb, withTransaction } from "./db.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

/**
 * A directory that cleans itself up, so a failing check cannot leak a temp db.
 *
 * It closes whatever was open first and again afterwards, because these checks
 * run inside the smoke suite's process, where some other module may have
 * touched the database already -- and `openDb` deliberately refuses to move a
 * database out from under a caller rather than silently reopening.
 */
function inTempDir<T>(fn: (dir: string) => T): T {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-db-test-"));
  try {
    return fn(dir);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A `jobs` table as it looked before dependency chains existed: five statuses,
 * no 'waiting', no `depends_on`. This is the shape the rebuild exists for, and
 * writing it out here is the only way to test the rebuild at all — every
 * database the code creates itself is already past it.
 */
const PRE_DEPENDS_ON_JOBS = `
CREATE TABLE jobs (
  job_id      TEXT PRIMARY KEY,
  executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
  workload    TEXT NOT NULL,
  spec        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','claimed','done','failed','cancelled')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_by  TEXT,
  claimed_at  TEXT,
  finished_at TEXT,
  lease_ttl_s    INTEGER NOT NULL DEFAULT 600,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_deadline TEXT,
  last_error     TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  parent_job_id  TEXT,
  template_id    TEXT
);`;

export function runDbChecks(check: Check) {
  // --- the lifecycle -------------------------------------------------------
  //
  // This is what the module-level `new Database(...)` could not do, and the
  // reason it had to stop being one: a desktop app decides where its data lives
  // after the code is loaded, and a test wants three collectors in one process.
  inTempDir((dir) => {
    const first = openDb(dir);
    check("openDb returns a usable handle", typeof first.prepare === "function");
    check("openDb is idempotent for the same directory", openDb(dir) === first);

    let refused = false;
    try {
      openDb(path.join(dir, "elsewhere"));
    } catch {
      refused = true;
    }
    check(
      "opening a second directory while one is open is refused",
      refused,
      "a silent reopen would move one collector's database out from under it",
    );

    db.prepare("INSERT INTO devices (device_id, descriptor, pools, last_seen) VALUES (?,?,?,datetime('now'))").run(
      "lifecycle-1",
      "{}",
      "[]",
    );
    closeDb();
    closeDb(); // safe to call twice: the second one has nothing to do
    check("closeDb leaves nothing open", dbFile() === null);

    // Reopening the same directory finds the row: the data outlived the handle,
    // which is the whole point of stopping and starting a collector in-process.
    openDb(dir);
    const back = db.prepare("SELECT device_id FROM devices WHERE device_id = ?").get("lifecycle-1") as
      | { device_id: string }
      | undefined;
    check("a reopened database still has its rows", back?.device_id === "lifecycle-1");
    closeDb();
  });

  // --- transactions --------------------------------------------------------
  //
  // `better-sqlite3` shipped these; on `node:sqlite` they are eleven lines in
  // db.ts, and eleven lines nobody tested is eleven lines that commits when it
  // should roll back.
  inTempDir((dir) => {
    openDb(dir);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n;
    const add = (id: string) =>
      db
        .prepare("INSERT INTO devices (device_id, descriptor, pools, last_seen) VALUES (?,?,?,datetime('now'))")
        .run(id, "{}", "[]");

    const commits = db.transaction((id: string) => add(id));
    commits("tx-committed");
    check("a transaction that returns commits its writes", count() === 1);

    const throws = db.transaction((id: string) => {
      add(id);
      throw new Error("deliberate");
    });
    let threw = false;
    try {
      throws("tx-rolled-back");
    } catch {
      threw = true;
    }
    check("a throwing transaction rethrows", threw);
    check("a throwing transaction rolls its writes back", count() === 1, "the failed insert must not survive");

    check(
      "a transaction returns its callback's value",
      db.transaction(() => 42)() === 42,
    );

    // --- and the nested case ---
    //
    // Nothing in the collector nests today. It is checked because the failure
    // if something ever does would be silent and would corrupt data: SQLite
    // treats an inner COMMIT as committing the OUTER transaction, so an outer
    // rollback would undo only the part written after the inner call.
    const inner = db.transaction((id: string) => add(id));
    const outerThatFails = db.transaction((id: string) => {
      inner(id);
      throw new Error("outer fails after inner committed");
    });
    let outerThrew = false;
    try {
      outerThatFails("tx-nested");
    } catch {
      outerThrew = true;
    }
    check("a nested transaction rethrows through the outer one", outerThrew);
    check(
      "an outer rollback undoes what a nested transaction wrote",
      count() === 1,
      "a plain BEGIN/COMMIT pair here would have kept the inner row",
    );

    const outerThatSucceeds = db.transaction((id: string) => {
      inner(id);
      return "ok";
    });
    check("a nested transaction commits with its outer one", outerThatSucceeds("tx-nested-ok") === "ok" && count() === 2);

    // Depth is released even when a transaction throws, or every later
    // transaction would run as a savepoint against a BEGIN nobody opened.
    commits("tx-after-a-failure");
    check("a failed transaction leaves the depth counter clean", count() === 3);
    closeDb();
  });

  // --- error codes ---------------------------------------------------------
  //
  // `POST /jobs` answers 409 on a duplicate job_id by recognising the driver's
  // constraint error. `better-sqlite3` put a string in `code`; Node puts
  // ERR_SQLITE_ERROR there and the SQLite extended code in `errcode`, so the
  // old comparison stopped matching and a duplicate enqueue became a 500. The
  // smoke suite caught that one; this keeps it caught.
  inTempDir((dir) => {
    openDb(dir);
    const insert = () =>
      db
        .prepare("INSERT INTO jobs (job_id, executor, workload, spec) VALUES (?,?,?,?)")
        .run("dupe", "device", "benchmark", "{}");
    insert();
    let caught: unknown = null;
    try {
      insert();
    } catch (e) {
      caught = e;
    }
    check("a duplicate primary key throws", caught !== null);
    check("and isUniqueViolation recognises it", isUniqueViolation(caught));
    check("an unrelated error is not a unique violation", !isUniqueViolation(new Error("nope")));
    check("neither is a null", !isUniqueViolation(null));
    closeDb();
  });

  // --- the migration, on a database that predates it -----------------------
  //
  // The case the whole suite was blind to. Build the old shape by hand, put a
  // row in it, then open it with the real code and check both halves: the
  // constraint was widened, and the row came through.
  inTempDir((dir) => {
    const file = path.join(dir, "fleet.db");
    const seed = new DatabaseSync(file);
    seed.exec(PRE_DEPENDS_ON_JOBS);
    seed
      .prepare("INSERT INTO jobs (job_id, executor, workload, spec, status) VALUES (?,?,?,?,?)")
      .run("old-job", "device", "benchmark", '{"schema":1}', "done");
    seed.close();

    openDb(dir);
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as { sql: string })
      .sql;
    check("the rebuild widens the status constraint to accept 'waiting'", ddl.includes("'waiting'"));
    check("and keeps 'cancelled'", ddl.includes("'cancelled'"));
    check(
      "the rebuild carries existing rows across",
      (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n === 1,
      "a rebuild that dropped history would be worse than no rebuild",
    );
    check(
      "depends_on is added after the rebuild, not lost to it",
      (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).some((c) => c.name === "depends_on"),
    );

    // The behaviour all of the above exists for.
    let waitingAccepted = true;
    try {
      db.prepare("INSERT INTO jobs (job_id, executor, workload, spec, status) VALUES (?,?,?,?,?)").run(
        "waits",
        "device",
        "benchmark",
        "{}",
        "waiting",
      );
    } catch {
      waitingAccepted = false;
    }
    check("a migrated database accepts a 'waiting' job", waitingAccepted);

    // Opening it a second time must be a no-op rather than a second rebuild.
    closeDb();
    openDb(dir);
    check(
      "re-opening a migrated database changes nothing",
      (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n === 2,
    );
    closeDb();
  });

  // --- withTransaction against a handle the module does not own ------------
  inTempDir((dir) => {
    const file = path.join(dir, "standalone.db");
    const h = new DatabaseSync(file);
    h.exec("CREATE TABLE t (a TEXT PRIMARY KEY)");
    const add = withTransaction(h, (a: string) => h.prepare("INSERT INTO t VALUES (?)").run(a));
    add("one");
    check(
      "withTransaction works against a caller's own handle",
      (h.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n === 1,
    );
    h.close();
  });
}
