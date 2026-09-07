/**
 * The database: one SQLite file, opened on demand, migrated on open.
 *
 * ## Why `node:sqlite` and not `better-sqlite3`
 *
 * `better-sqlite3` was the only native addon in the whole tree, and a native
 * addon is the difference between "one bundle that runs on any Node" and "a
 * build per OS, per architecture, per Node ABI, with a prebuild service in the
 * middle". It is also the reason the collector had never run on Windows --
 * nothing in it was macOS-specific, nobody wanted to find out what the addon
 * did over there.
 *
 * The surface actually used here was `prepare`, `exec`, one `pragma` and seven
 * `transaction` wrappers, and Node's built-in module has the first two under
 * the same names. The other two are shimmed below. That is the whole migration.
 *
 * ## Why the handle is not a module constant any more
 *
 * It used to be `export const db = new Database(...)`, which opened a file as a
 * side effect of `import`. That made the collector impossible to embed: a
 * desktop app that is a brain has to decide where its data lives before the
 * database exists, and a test that starts and stops three collectors in one
 * process cannot re-import a module to get a second one.
 *
 * So `db` is now an adapter that resolves the open handle **at call time**.
 * Every existing call site (`db.prepare(...)`, `db.exec(...)`) is unchanged and
 * still works; what changed is that `openDb()` decides which file, and
 * `closeDb()` can put it back. A call that arrives with nothing open still
 * works and opens the configured default, which is what `npm start` does.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * What may be bound to a `?` placeholder.
 *
 * Re-exported here so the modules that assemble a WHERE clause do not each
 * import the SQLite driver: which driver this is stays a fact about this file.
 * It is also stricter than the `unknown[]` those modules used to declare, which
 * is the point -- binding an `undefined` throws at runtime in every driver, and
 * that is now a compile error instead.
 */
export type SqlParam = SQLInputValue;

let handle: DatabaseSync | null = null;
let handleFile: string | null = null;

/** The open database, opening the configured default if nothing is open yet. */
export function dbHandle(): DatabaseSync {
  return handle ?? openDb();
}

/** Which file is open, or null. The System page reports it. */
export function dbFile(): string | null {
  return handleFile;
}

/**
 * Open (or reuse) the database under `dataDir` and bring its schema up to date.
 *
 * Calling it again with the same directory is a no-op, so a component that is
 * not sure whether it started first can just call it. Calling it with a
 * different directory while one is open is a programming error rather than a
 * silent reopen: two collectors in one process would each think they owned the
 * module-level handle, and the second one would quietly move the first one's
 * database out from under it.
 */
export function openDb(dataDir: string = DATA_DIR): DatabaseSync {
  const file = path.join(dataDir, "fleet.db");
  if (handle) {
    if (handleFile === file) return handle;
    throw new Error(`a database is already open at ${handleFile}; close it before opening ${file}`);
  }
  mkdirSync(dataDir, { recursive: true });
  const h = new DatabaseSync(file);
  // WAL survives the process, so this is idempotent rather than per-open state.
  // It is what lets the dashboard read while a runner is posting results.
  h.exec("PRAGMA journal_mode = WAL");
  handle = h;
  handleFile = file;
  try {
    migrate(h);
  } catch (e) {
    // A half-migrated handle must not be left installed as the module's
    // database: every later call would find a schema that does not match the
    // code, which is far harder to diagnose than the migration error itself.
    handle = null;
    handleFile = null;
    h.close();
    throw e;
  }
  return h;
}

/** Close the database, if one is open. Safe to call twice. */
export function closeDb(): void {
  if (!handle) return;
  handle.close();
  handle = null;
  handleFile = null;
  depth = 0;
}

/**
 * Transaction depth, so a transaction inside a transaction nests with a
 * SAVEPOINT rather than committing the outer one early.
 *
 * Nothing nests today. It is written this way because the failure if something
 * ever does would be silent: SQLite treats a second BEGIN as an error and a
 * COMMIT from the inner call as committing the OUTER transaction, so a
 * rollback that was supposed to undo everything would undo only the part after
 * the inner call had already committed. That is a data-corruption bug found
 * months later, and it costs five lines to make impossible.
 */
let depth = 0;

/** Wrap `fn` so it runs inside a transaction against `handle`. */
export function withTransaction<A extends unknown[], R>(
  handleFor: DatabaseSync | (() => DatabaseSync),
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    const h = typeof handleFor === "function" ? handleFor() : handleFor;
    const nested = depth > 0;
    const savepoint = `fleet_sp_${depth}`;
    h.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    depth += 1;
    try {
      const out = fn(...args);
      h.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return out;
    } catch (e) {
      // A failed ROLLBACK must not mask the error that caused it.
      try {
        h.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch {
        /* the transaction is already gone; the original error is the news */
      }
      throw e;
    } finally {
      depth -= 1;
    }
  };
}

/**
 * Whether an error is "those bytes are already there" -- a primary-key or
 * unique-index violation.
 *
 * This lives here because it is the one thing about the driver that leaked
 * into a route handler: `POST /jobs` answers 409 on a duplicate `job_id`, and
 * it used to do that by comparing `e.code` against the string
 * `SQLITE_CONSTRAINT_PRIMARYKEY`, which is `better-sqlite3` vocabulary. Node's
 * module puts `ERR_SQLITE_ERROR` in `code` and the SQLite extended result code
 * in `errcode`, so the old comparison silently stopped matching and a duplicate
 * enqueue became a 500. The smoke suite caught it; a test that only checked the
 * happy path would not have.
 *
 * Both extended codes count: a `job_id` collides on the primary key, and an
 * artifact or a schedule can collide on a unique index instead.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  return code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * The database, as every call site already uses it.
 *
 * `better-sqlite3`'s object with the four methods this codebase asked of it,
 * resolving the real handle when called rather than when imported.
 */
export const db = {
  prepare(sql: string): StatementSync {
    return dbHandle().prepare(sql);
  },
  exec(sql: string): void {
    dbHandle().exec(sql);
  },
  /** `better-sqlite3` had a method; Node has the statement, which is the same thing. */
  pragma(pragma: string): void {
    dbHandle().exec(`PRAGMA ${pragma}`);
  },
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return withTransaction(dbHandle, fn);
  },
};

/**
 * Bring a freshly opened database up to the current schema.
 *
 * Runs on every open, and every step is written to be a no-op when it has
 * already been applied -- there is no migration table and no version number,
 * because the collector is one SQLite file that a person owns and the
 * alternative is a version number somebody has to remember to bump.
 */
function migrate(db: DatabaseSync): void {
db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  descriptor  TEXT NOT NULL,          -- JSON: model, soc, ram_mb, os, app_ver
  pools       TEXT NOT NULL,          -- JSON array: what the runner reports
  last_seen   TEXT NOT NULL,
  last_beacon TEXT,                   -- JSON: most recent beacon sample
  -- Operator-set fields. The runner rewrites the pools column on every
  -- register, so an edit sharing it would be clobbered within the minute:
  -- the device says what it thinks it is, the operator overrides, and neither
  -- erases the other. Effective pools = override ?? reported.
  pools_override TEXT,
  -- What the agent says it can run; see the migration below for why NULL is
  -- permissive rather than empty.
  capabilities   TEXT,
  -- /24 prefix the agent last registered from; see the migration below.
  last_net       TEXT,
  -- The device's name. Not a nickname beside its id: the id is what the runner
  -- reports and what job specs pin, and this is what a person calls the thing.
  name           TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id      TEXT PRIMARY KEY,
  executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
  workload    TEXT NOT NULL,
  spec        TEXT NOT NULL,          -- full JSON job spec
  -- 'cancelled' is not 'failed': a failed job means something went wrong, a
  -- cancelled one means a person stopped it. Collapsing them would lie in the
  -- dashboard's failure counts and in every alert built on them.
  -- 'waiting' is a job whose dependencies have not finished. It is distinct
  -- from 'queued' because a queued job is one the claim loop should be looking
  -- at, and a waiting one is not eligible for anything yet.
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('waiting','queued','claimed','done','failed','cancelled')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_by  TEXT,
  claimed_at  TEXT,
  finished_at TEXT,
  -- Lease: a claim is only good until lease_deadline. Beacons renew it, the
  -- sweep requeues it when it lapses, so a runner that dies mid-job (OOM kill,
  -- flat battery, yanked cable) does not strand the job in 'claimed' forever.
  lease_ttl_s    INTEGER NOT NULL DEFAULT 600,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lease_deadline TEXT,
  last_error     TEXT,
  -- Claim order is priority DESC, created_at ASC: a job promoted from the
  -- dashboard jumps the queue without its created_at being falsified.
  priority       INTEGER NOT NULL DEFAULT 0,
  -- Recorded at fan-out time. The parent id has no row of its own, so without
  -- this the relationship can only be inferred from the id string.
  parent_job_id  TEXT,
  template_id    TEXT,
  -- JSON array of job_ids this one waits for. Resolved to 'queued' when the
  -- last of them closes; failed when any of them fails or is cancelled.
  depends_on     TEXT
);

CREATE TABLE IF NOT EXISTS results (
  job_id     TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  iter       INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL,           -- full JSON result row
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, device_id, iter)
);

CREATE TABLE IF NOT EXISTS beacon_samples (
  device_id  TEXT NOT NULL,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  job_id     TEXT,
  sample     TEXT NOT NULL            -- JSON beacon payload
);
CREATE INDEX IF NOT EXISTS idx_beacon_device_ts ON beacon_samples (device_id, ts);

-- Watts, sampled from a pool's smart plug. Kept out of beacon_samples because a
-- beacon is a device describing itself and this is the wall describing the
-- device: nothing on the shelf reports its own draw, and several devices can
-- sit behind one plug.
CREATE TABLE IF NOT EXISTS power_samples (
  pool  TEXT NOT NULL,
  ts    TEXT NOT NULL DEFAULT (datetime('now')),
  watts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_power_pool_ts ON power_samples (pool, ts);

CREATE TABLE IF NOT EXISTS artifacts (
  sha256     TEXT PRIMARY KEY,
  name       TEXT,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Visual-regression baselines: for (suite, page, profile), which artifact is
-- the accepted truth. The artifact store is content-addressed and immutable;
-- this table is the mutable pointer into it. Accepting a new baseline
-- overwrites the row — history lives in the results that captured each shot,
-- not here. Rows referenced here must survive any future artifact GC.
CREATE TABLE IF NOT EXISTS baselines (
  suite       TEXT NOT NULL,          -- web-specs/<suite>, as the job's suite.flows names it
  page        TEXT NOT NULL,          -- shots.json page name
  profile     TEXT NOT NULL,          -- playwright.config.ts project name
  sha256      TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_from_job TEXT,             -- the web-shots job the accepted shot came from
  PRIMARY KEY (suite, page, profile)
);

CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT PRIMARY KEY,
  cron       TEXT NOT NULL,           -- 5-field cron expression
  template   TEXT NOT NULL,           -- JSON job spec without job_id
  enabled    INTEGER NOT NULL DEFAULT 0,
  last_run   TEXT,                    -- ISO minute of the last firing (dedup)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A device works one job at a time. Device-executor claims take the lock
-- implicitly; the host executor acquires explicitly for exclusive jobs.
CREATE TABLE IF NOT EXISTS device_locks (
  device_id   TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pipeline event rails: publish/subscribe without an external broker. Old
-- devices publish trigger events; capable devices subscribe, process, and
-- publish results to a sibling topic.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  payload    TEXT NOT NULL,           -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events (topic, id);

-- Every job that asked for a GitHub commit status gets a row here when it
-- closes. posted=0 rows are dry runs: reporting is off (the default) or the
-- POST failed — the audit trail exists either way, so turning CI on later
-- changes behavior, not bookkeeping.
-- Alerts are state, not events: one row per (rule, subject) while the condition
-- holds, resolved when it stops. A device that is offline for six hours is one
-- row with a rising seen_count, not 360 notifications.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rule         TEXT NOT NULL,
  subject      TEXT NOT NULL,          -- device_id, job_id, schedule id, or 'collector'
  severity     TEXT NOT NULL,
  message      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','acked','snoozed','resolved')),
  first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  snooze_until TEXT,
  seen_count   INTEGER NOT NULL DEFAULT 1,
  notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts (state, rule, subject);

-- Host executors announce themselves by polling for work, so their liveness is
-- already observable — it just was not recorded. Without this, a dashboard can
-- show a queue full of host jobs and no way to tell that the executor driving
-- them died three hours ago.
CREATE TABLE IF NOT EXISTS executors (
  name       TEXT PRIMARY KEY,
  last_seen  TEXT NOT NULL,
  last_job   TEXT,
  polls      INTEGER NOT NULL DEFAULT 0
);

-- Saved job specs for the dashboard composer: the "run the nightly benchmark
-- again, now" button without retyping a spec. A template is a job spec with no
-- job_id, exactly like a schedule's template.
CREATE TABLE IF NOT EXISTS job_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  spec       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS status_reports (
  job_id     TEXT NOT NULL,
  target     TEXT NOT NULL,            -- owner/repo@sha
  state      TEXT NOT NULL,            -- success | failure
  posted     INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, target)
);
`);

// CREATE TABLE IF NOT EXISTS is a no-op on a database that predates a column,
// so added columns need an explicit ALTER for existing collector installs.
const jobColumns = new Set(
  (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["lease_ttl_s", "lease_ttl_s INTEGER NOT NULL DEFAULT 600"],
  ["max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 3"],
  ["attempts", "attempts INTEGER NOT NULL DEFAULT 0"],
  ["lease_deadline", "lease_deadline TEXT"],
  ["last_error", "last_error TEXT"],
  ["priority", "priority INTEGER NOT NULL DEFAULT 0"],
  ["parent_job_id", "parent_job_id TEXT"],
  ["template_id", "template_id TEXT"],
] as const) {
  if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
}

// An artifact used to be an anonymous blob: a hash, a filename and a size. That
// is why a nightly had to pin a literal sha256 by hand, and why one of them
// spent six days testing an APK older than the code it was meant to guard.
// Recording which app and build an artifact IS lets a schedule ask for the
// latest one instead of a hash somebody has to remember to update.
const artifactColumns = new Set(
  (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["app", "app TEXT"],
  ["build", "build TEXT"],
  ["platform", "platform TEXT"],
  // NOT created_at. The store is content-addressed, so re-uploading bytes that
  // already exist is an ignored insert and created_at keeps its original value
  // -- which means a revert that republishes an earlier build looks OLDER than
  // the build it just replaced, and `latest` resolves to the wrong one.
  // published_at is when this content was last claimed by an app.
  ["published_at", "published_at TEXT"],
  // And publish_seq is what `latest` actually orders by. A timestamp cannot do
  // it: datetime('now') is second-granular, so two publishes in the same second
  // tie, and the only tiebreak left is rowid -- which for a content-addressed
  // row is the order the BYTES were first seen, not the order they were
  // published. That is precisely backwards for a revert. A counter has neither
  // problem.
  ["publish_seq", "publish_seq INTEGER"],
  // A pin says "never collect this, whatever the reference scan concludes".
  // The scan reads job specs, results, schedules and templates — it cannot see
  // an accepted visual baseline, whose whole job is to still be there in six
  // months to diff against. Once build and model-convert start producing
  // artifacts nightly, GC stops being hypothetical and that blind spot becomes
  // a deleted baseline and a visual suite with nothing to compare to.
  ["pinned", "pinned INTEGER NOT NULL DEFAULT 0"],
  ["pin_reason", "pin_reason TEXT"],
] as const) {
  if (!artifactColumns.has(column)) db.exec(`ALTER TABLE artifacts ADD COLUMN ${ddl}`);
}
// Existing rows predate the column; their upload time is the best available
// answer and is correct for everything that was never republished.
db.exec("UPDATE artifacts SET published_at = created_at WHERE published_at IS NULL");
// Existing rows were never republished, so first-seen order IS publish order
// for them; seed the counter from rowid so it stays monotonic from here.
db.exec("UPDATE artifacts SET publish_seq = rowid WHERE publish_seq IS NULL");
// The lookup a nightly does every time it fires.
db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_app ON artifacts (app, publish_seq DESC)");

// `nickname` was the wrong word: it implied a second label beside the id rather
// than the device's name. Renamed in place so existing names carry over — this
// must happen before the add-column loop below, or that loop would add an empty
// `name` beside the populated `nickname` and orphan every name already set.
{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name),
  );
  if (cols.has("nickname") && !cols.has("name")) {
    db.exec("ALTER TABLE devices RENAME COLUMN nickname TO name");
  }
}

const deviceColumns = new Set(
  (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name),
);
for (const [column, ddl] of [
  ["pools_override", "pools_override TEXT"],
  ["name", "name TEXT"],
  ["notes", "notes TEXT"],
  // What this agent says it can run. A pool is a label a person applied; a
  // capability is a statement about the agent's own code and toolchain, which
  // is why the queue routes on it and an operator cannot override it.
  // NULL means an agent registered before capabilities existed: it is offered
  // everything, exactly as it was before, rather than silently offered nothing.
  ["capabilities", "capabilities TEXT"],
  // The network the agent last registered from, as a /24 prefix. Once agents
  // roam, "six devices offline" and "six devices on another network" look
  // identical in the registry and mean opposite things — the dashboard
  // screenshots taken from the wrong LAN read as an abandoned fleet for
  // exactly this reason. A prefix, not the full address: enough to tell one
  // place from another, not a log of where a laptop has been.
  ["last_net", "last_net TEXT"],
  // How long this agent should survive its own silence, in seconds. NULL is
  // the shelf: a phone that is off is still a phone, and it should stay in the
  // registry reading offline until somebody picks it up again.
  //
  // A value here says the opposite -- that this agent is EPHEMERAL and its
  // absence is the end of it, not a fault. A browser tab that was closed, a CI
  // runner whose job finished, a container that exited: each registered, did
  // one thing, and is not coming back. Without this they accumulate forever as
  // offline devices, and a shelf where most entries are ghosts is a shelf
  // nobody reads.
  //
  // Deliberately a TTL against last_seen rather than an expiry timestamp:
  // last_seen is already refreshed by every poll and every beacon, so the
  // window slides for free and an agent that is still working never expires
  // out from under its own job.
  ["ttl_s", "ttl_s INTEGER"],
] as const) {
  if (!deviceColumns.has(column)) db.exec(`ALTER TABLE devices ADD COLUMN ${ddl}`);
}

// A CHECK constraint cannot be widened with ALTER, so a database created before
// 'cancelled' existed would reject every cancellation with a constraint error.
// SQLite's supported fix is to rebuild the table. Every column above exists by
// now, so the copy can name them explicitly rather than trusting SELECT *.
const jobsDdl = (
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as
    | { sql: string }
    | undefined
)?.sql;
if (jobsDdl && (!jobsDdl.includes("'cancelled'") || !jobsDdl.includes("'waiting'"))) {
  // Only the columns that existed before this rebuild are copied; depends_on is
  // added by the ALTER loop below and is NULL on every pre-existing row, which
  // is correct -- a job enqueued before dependencies existed had none.
  const COLUMNS = [
    "job_id", "executor", "workload", "spec", "status", "created_at", "claimed_by", "claimed_at",
    "finished_at", "lease_ttl_s", "max_attempts", "attempts", "lease_deadline", "last_error",
    "priority", "parent_job_id", "template_id",
  ].join(", ");
  db.exec("PRAGMA foreign_keys = off");
  withTransaction(db, () => {
    db.exec(`
      CREATE TABLE jobs_migrating (
        job_id      TEXT PRIMARY KEY,
        executor    TEXT NOT NULL CHECK (executor IN ('device','host')),
        workload    TEXT NOT NULL,
        spec        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('waiting','queued','claimed','done','failed','cancelled')),
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
      );
      INSERT INTO jobs_migrating (${COLUMNS}) SELECT ${COLUMNS} FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_migrating RENAME TO jobs;
    `);
    // Invoked, not merely built: withTransaction returns a wrapped function the
    // way better-sqlite3's transaction() did, and a rebuild that is only
    // defined is a rebuild that never runs. That failure is invisible on a
    // fresh database -- the CREATE TABLE above already has every status -- and
    // shows up only on somebody's existing collector, as a constraint error the
    // first time a job is set 'waiting'.
  })();
  db.exec("PRAGMA foreign_keys = on");
}

// depends_on is additive, so it is an ALTER rather than part of the rebuild --
// and it must come after it, because the rebuild copies a fixed column list.
{
  const jobColumns = new Set(
    (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!jobColumns.has("depends_on")) db.exec("ALTER TABLE jobs ADD COLUMN depends_on TEXT");
}

// After the ALTERs and the rebuild: on a pre-lease database the column does not
// exist yet when the CREATE TABLE block above runs, and DROP TABLE takes every
// index on the old table with it.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs (status, lease_deadline);
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, executor, priority DESC, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs (parent_job_id);
`);

// Jobs claimed before leases existed have no deadline and would never be swept.
// Treat them as claimed right now: they get one lease window to report in.
db.prepare(
  `UPDATE jobs SET lease_deadline = datetime('now', '+' || lease_ttl_s || ' seconds'),
                   attempts = MAX(attempts, 1)
   WHERE status = 'claimed' AND lease_deadline IS NULL`,
).run();

}
