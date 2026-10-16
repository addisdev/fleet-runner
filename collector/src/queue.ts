/**
 * Putting work on the queue: the one implementation of "is this job valid, and
 * where does it go".
 *
 * It used to be the body of the `POST /jobs` route in server.ts, which every
 * other way in reached by `app.inject`-ing a request at it -- the dashboard's
 * `POST /api/jobs`, a retry, the scheduler. That kept validation in one place,
 * which was the point, but it also meant a caller could only ever get the
 * route's answer: a status code and a sentence. The control API needs more than
 * that -- a stable error code an agent can branch on, a dry run that says what
 * *would* happen, and the identity of whoever asked -- so the logic is a
 * function now and the route is a wrapper over it, like every other caller.
 */
import { db, isUniqueViolation } from "./db.js";
import { evalMatch, isValidMatch } from "./match.js";
import { announce } from "./announce.js";
import { AGE, capabilityMatches, deviceCapabilities, effectivePools, isExpired, parse } from "./api/shared.js";
import {
  dependencyState, substituteDepRefs, validateDepRefs, validateDependencies,
} from "./api/mutations.js";

// Lease defaults. A claim expires unless the runner keeps renewing it via
// beacons; the sweep then requeues the job (up to max_attempts) so a dead
// runner cannot strand work in 'claimed'.
export const DEFAULT_LEASE_TTL_S = 600;
// drain and soak legitimately run for hours between beacons.
export const LONG_LEASE_TTL_S = 4 * 60 * 60;
// thermal is minutes rather than hours, but a 15-minute sustained run is still
// well past the 600 s default, and a swept lease mid-run would requeue a job
// whose whole value is an unbroken curve.
// build compiles for tens of minutes; app-soak runs for hours; the eval
// workloads chew through a corpus on a phone.
export const LONG_LEASE_WORKLOADS = new Set([
  "drain", "soak", "thermal", "build", "app-soak", "speech-eval", "embed-eval",
  // A conversion quantises a multi-GB checkpoint; a dataset is downloaded and
  // resized; a served model is up for as long as someone is using it.
  "model-convert", "dataset-prep", "serve", "push-latency",
]);
export const MAX_LEASE_TTL_S = 24 * 60 * 60;
export const DEFAULT_MAX_ATTEMPTS = 3;

export type JobSpec = {
  schema: number;
  job_id: string;
  workload: string;
  executor: "device" | "host";
  // true fans out to every matching device; { distinct: "os" } fans out to one
  // device per distinct value of that descriptor field.
  fanout?: boolean | { distinct?: string };
  // Named here rather than left to the index signature because capability
  // routing reads it: an agent may declare a workload outright or only one
  // backend of it ("batch:litert").
  backend?: string;
  // `sha256: "latest"` is resolved at enqueue time to the newest build uploaded
  // under this app name -- see resolveLatestBuild.
  app?: { name?: string; build?: string; sha256?: string; platform?: string };
  targets?: {
    pool?: string;
    match?: string;
    exclusive?: boolean;
    device_id?: string;
    // Which host executor should claim this. Not a capability label -- it is a
    // statement about which machine can physically reach the toolchain or the
    // device, which is not a property of any device, so a match expression
    // cannot express it. iOS work needs the Mac with Xcode; Android shelf work
    // needs the machine the shelf is cabled to.
    executor?: string;
    // web-test only: what to point the browser at.
    url?: string;
    // Honoured by the host executor when it picks devices to run on, not only
    // when deciding who claims the job. `device_kind` says "real hardware" or
    // "simulator" -- which no descriptor field expresses honestly, because it
    // is a property of how a device is attached rather than of the device.
    device_kind?: "device" | "simulator";
  };
  constraints?: Record<string, unknown>;
  lease?: { ttl_s?: number; max_attempts?: number };
  // Queue position and provenance. Both are collector bookkeeping rather than
  // instructions to the runner, which ignores them.
  priority?: number;
  template_id?: string;
  // Job ids this one waits for. The job is inserted 'waiting' and promoted to
  // 'queued' when the last of them is 'done' — a build → install → ui-test
  // chain is three POSTs and nothing watching the queue.
  depends_on?: string[];
  // The runner will stand down and checkpoint if higher-priority work arrives
  // for the same claimant. Honoured by the collector's beacon reply; a runner
  // that ignores it simply keeps running, which is the old behaviour.
  preemptible?: boolean;
  [k: string]: unknown;
};

// web-test and web-shots are host-executed like ui-test, but their target is a
// URL rather than a device: no phone is involved and none is locked. web-test
// runs Playwright suites; web-shots captures the screenshot matrix the
// visual-regression pipeline diffs.
// web-audit crawls and audits a site (SEO, structure, mobile-friendliness),
// web-unfurl checks the raw-HTML link previews bots see, archive pulls an
// external API's data (Search Console, App Store / Play reviews) into the
// artifact store, and digest turns the week's archived reviews into a
// summary by farming batch jobs to the shelf's on-device models.
export const WORKLOADS = new Set([
  "benchmark", "batch", "pipeline", "install", "ui-test", "drain", "soak",
  "web-test", "web-shots", "web-audit", "web-unfurl", "archive", "digest",
  // thermal is a device workload the runners declare, and cold-start is a host
  // one. Both are listed here anyway because the collector ships their result
  // views and the dashboard ships their icons and skeletons — a workload the
  // collector renders is a workload the collector knows about.
  "thermal", "cold-start", "self-check",
  // Wave 2. build and the eval workloads are claimed by agents that declare
  // them; the rest are host work. All are listed because the collector renders
  // their results, and a workload the dashboard draws is one it knows about.
  "build", "speech-eval", "embed-eval", "vantage", "locale-shots", "app-soak", "a11y-audit",
  // Wave 3: pipelines that feed the evals, and the workloads that need hardware.
  "model-convert", "dataset-prep", "serve", "shell", "push-latency", "camera-eval", "desktop-ui-test",
  // Wave 6: the fleet finally measures whether an answer is any good, not only
  // how fast it arrived.
  "llm-eval",
  // Wave 7: the app under test, from angles a pass/fail suite does not cover.
  "size-report", "upgrade-test",
  // The brain reaching the device, for every screen with no keyboard worth
  // using. See src/workloads/enrol/.
  "enrol",
  // Another tool's hardware suite, run on a device the fleet lends it. See
  // src/workloads/tvloop/.
  "tvloop",
  // Overnight exploratory QA: a vision model drives tonight's build and files
  // reproduced findings. See src/workloads/explore/.
  "explore",
]);

/** Devices a `targets` clause selects. Shared by fan-out and by the composer's
 *  "N devices match" preview, so the preview cannot disagree with what fan-out
 *  will actually do. */
export function matchingDevices(pool?: string, match?: string, workload?: string, backend?: string | null) {
  return (
    db.prepare(
      `SELECT device_id, pools, pools_override, descriptor, capabilities, ttl_s,
              ${AGE("last_seen")} AS age_s
       FROM devices`,
    ).all() as {
      device_id: string;
      pools: string;
      pools_override: string | null;
      descriptor: string;
      capabilities: string | null;
      ttl_s: number | null;
      age_s: number | null;
    }[]
  ).filter((d) => {
    const pools = effectivePools(d);
    const capabilities = deviceCapabilities(d);
    // An expired ephemeral agent is gone, not idle. Fanning out to it would
    // mint a child job pinned to a browser tab that was closed an hour ago,
    // which then sits queued forever with nothing to explain why.
    if (isExpired(d, d.age_s)) return false;
    if (pool && !pools.includes(pool)) return false;
    // Checked before the expression, so a match expression can narrow the set
    // but never widen an agent past what its own code can run.
    if (workload && !capabilityMatches(capabilities, workload, backend)) return false;
    if (match) {
      try {
        return evalMatch(match, {
          ...JSON.parse(d.descriptor), device_id: d.device_id, pools, capabilities: capabilities ?? [],
        });
      } catch {
        return false;
      }
    }
    return true;
  });
}

/**
 * Is there any agent on the fleet that could run this workload? The built-in
 * set is always serviceable — those workloads live in the executor, which does
 * not register as a device. Anything else has to be claimed by an agent that
 * says it can run it, which is what stops a typo'd workload sitting queued
 * forever with no explanation.
 */
export function workloadServiceableBy(workload: string, backend?: string | null): boolean {
  if (WORKLOADS.has(workload)) return true;
  return (
    db.prepare(
      `SELECT capabilities, ttl_s, ${AGE("last_seen")} AS age_s FROM devices`,
    ).all() as { capabilities: string | null; ttl_s: number | null; age_s: number | null }[]
  ).filter((d) => !isExpired(d, d.age_s)).some((d) => {
    const declared = deviceCapabilities(d);
    // A legacy agent's null means "no opinion", which cannot be read as a claim
    // to run a workload that did not exist when it registered.
    return declared !== null && capabilityMatches(declared, workload, backend);
  });
}

/**
 * Resolve `app.sha256: "latest"` to the newest build uploaded for `app.name`.
 *
 * This is what stops a nightly from testing yesterday's code. A schedule that
 * pins a literal hash tests that hash forever, which is how one of these spent
 * six days guarding an APK older than the code it was meant to guard; a
 * schedule that asks for "latest" tests whatever CI pushed most recently.
 *
 * Builds on the `pr` channel are never `latest`: a pull request's upload is
 * tested by the job that names its hash, and the nightly keeps testing what
 * was merged.
 *
 * Throws when there is nothing to test, rather than enqueueing a job pinned to
 * a build that does not exist.
 */
export function resolveLatestBuild(spec: JobSpec): JobSpec {
  if (spec.app?.sha256 !== "latest") return spec;
  const appName = spec.app?.name;
  if (!appName) throw new Error("app.sha256 is 'latest' but app.name is missing");
  const row = db
    .prepare(
      `SELECT sha256, build FROM artifacts WHERE app = ? AND channel IS NOT 'pr'
       ORDER BY COALESCE(publish_seq, rowid) DESC LIMIT 1`,
    )
    .get(appName) as { sha256: string; build: string | null } | undefined;
  if (!row) {
    const prOnly = db.prepare("SELECT 1 FROM artifacts WHERE app = ? AND channel = 'pr' LIMIT 1").get(appName);
    throw new Error(`no build has been uploaded for ${appName}${prOnly ? " except from pull requests, which latest never resolves to" : ""}`);
  }
  // Record the build string the artifact carries, so a result says which build
  // actually ran. Falling back to the template's build would write the literal
  // word "latest" into the result, which is untraceable to any commit; the
  // short hash is at least a real answer.
  const templateBuild = spec.app.build === "latest" ? undefined : spec.app.build;
  return {
    ...spec,
    app: { ...spec.app, sha256: row.sha256, build: row.build ?? templateBuild ?? row.sha256.slice(0, 12) },
  };
}

/**
 * Stable reasons a request can be refused, for callers that branch rather than
 * read. The message beside each one is for a person; the code is the contract.
 */
export type ErrorCode =
  | "bad_request"
  | "invalid_spec"
  | "not_found"
  | "duplicate_job"
  | "no_capable_agent"
  | "no_matching_devices"
  | "secret_in_spec"
  | "no_build"
  | "invalid_match"
  | "invalid_dependency"
  | "unresolved_reference"
  | "conflict"
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "rate_limited"
  | "internal";

/** Who asked for a job, and through which front door. */
export type Provenance = { requested_by: string | null; source: string | null };

export type EnqueueRefusal = {
  ok: false;
  http: number;
  code: ErrorCode;
  message: string;
  hint?: string;
};

export type CandidateDevice = { device_id: string; model: string | null; os: string | null };

export type EnqueueAccepted = {
  ok: true;
  http: 200 | 201;
  /** queued, waiting (on depends_on), or failed (a dependency already failed). */
  status: string;
  job_id: string;
  /** Present when the spec fanned out: one child per device. */
  fanout?: string[];
  /** Only on a dry run. */
  preview?: {
    spec: JobSpec;
    candidates: CandidateDevice[];
    warnings: string[];
  };
};

export type EnqueueOutcome = EnqueueAccepted | EnqueueRefusal;

const refuse = (http: number, code: ErrorCode, message: string, hint?: string): EnqueueRefusal =>
  ({ ok: false, http, code, message, ...(hint ? { hint } : {}) });

const candidate = (d: { device_id: string; descriptor: string }): CandidateDevice => {
  const descriptor = parse<Record<string, unknown>>(d.descriptor, {});
  return {
    device_id: d.device_id,
    model: typeof descriptor.model === "string" ? descriptor.model : null,
    os: typeof descriptor.os === "string" ? descriptor.os : null,
  };
};

/** Seconds of silence after which a host executor is no longer polling. */
const EXECUTOR_LIVE_S = 120;

/**
 * Validate a job spec and, unless this is a dry run, put it on the queue.
 *
 * A dry run goes through every check an enqueue does -- capability, secrets,
 * `latest`, leases, dependencies, the match expression, fan-out -- and then
 * says what it would have done instead of doing it: the normalised spec, the
 * devices it would land on, and anything that would make it sit in the queue.
 * That is the question an agent should ask before it spends a device's hour.
 */
export function enqueueJob(
  input: JobSpec,
  opts: { dryRun?: boolean; provenance?: Provenance } = {},
): EnqueueOutcome {
  let spec = input;
  const dryRun = opts.dryRun === true;
  const provenance = opts.provenance ?? { requested_by: null, source: null };

  if (spec?.schema !== 1) return refuse(400, "invalid_spec", "schema must be 1");
  if (!spec.job_id) return refuse(400, "invalid_spec", "job_id required");
  if (typeof spec.workload !== "string" || !spec.workload)
    return refuse(400, "invalid_spec", "workload required");
  // The set below is what the collector and the host executor ship with. Beyond
  // it, an agent that declares a capability defines the workload — which is how
  // a new runner adds work the collector has never heard of without a release
  // here. Refusing when nothing on the fleet can run it keeps the failure at
  // enqueue time, where the caller sees it, rather than as a job queued forever.
  if (!workloadServiceableBy(spec.workload, spec.backend ?? null))
    return refuse(
      422, "no_capable_agent",
      `no agent can run workload '${spec.workload}'` +
        (spec.backend ? ` with backend '${spec.backend}'` : "") +
        "; a device must declare it in the capabilities it registers with",
      "list what the fleet can run with GET /api/v1/workloads",
    );
  // A job spec is stored in SQLite, served by the API and rendered on the
  // dashboard, so anything in one is effectively published to everyone on the
  // LAN. Refuse secrets outright rather than trusting every future caller to
  // remember: the executor resolves passwords from its own host Keychain, and
  // a spec only ever names the account.
  {
    const flat = JSON.stringify(spec).toLowerCase();
    for (const banned of ["\"password\"", "\"passwd\"", "\"secret\"", "\"token\"", "\"api_key\"", "\"apikey\""]) {
      if (flat.includes(banned)) {
        return refuse(
          400, "secret_in_spec",
          `job specs must not carry secrets (${banned.replace(/"/g, "")}); ` +
            "name the account instead and keep the password in the executor host's Keychain",
        );
      }
    }
  }
  // `latest` is the documented contract for CI and for hand-written jobs, not
  // a scheduler-only convenience. Resolving here means a job posted directly
  // is never pinned to a string that cannot name an artifact.
  try {
    spec = resolveLatestBuild(spec);
  } catch (e) {
    return refuse(400, "no_build", String((e as Error).message ?? e), "publish a build for this app first");
  }
  if (spec.executor !== "device" && spec.executor !== "host")
    return refuse(400, "invalid_spec", "executor must be 'device' or 'host'");

  if (spec.lease !== undefined && (typeof spec.lease !== "object" || spec.lease === null || Array.isArray(spec.lease)))
    return refuse(400, "invalid_spec", "lease must be an object");
  const ttlS =
    spec.lease?.ttl_s ??
    (LONG_LEASE_WORKLOADS.has(spec.workload) ? LONG_LEASE_TTL_S : DEFAULT_LEASE_TTL_S);
  if (!Number.isInteger(ttlS) || ttlS < 1 || ttlS > MAX_LEASE_TTL_S)
    return refuse(400, "invalid_spec", `lease.ttl_s must be an integer between 1 and ${MAX_LEASE_TTL_S}`);
  const maxAttempts = spec.lease?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    return refuse(400, "invalid_spec", "lease.max_attempts must be an integer >= 1");
  // Persist the effective lease so runners see it in the spec they claim and
  // can pace their beacons against it. A copy, so a dry run leaves the caller's
  // object as it was.
  spec = { ...spec, lease: { ttl_s: ttlS, max_attempts: maxAttempts } };

  const priority = spec.priority ?? 0;
  if (!Number.isInteger(priority)) return refuse(400, "invalid_spec", "priority must be an integer");
  const templateId = typeof spec.template_id === "string" ? spec.template_id : null;

  if (spec.preemptible !== undefined && typeof spec.preemptible !== "boolean")
    return refuse(400, "invalid_spec", "preemptible must be a boolean");

  // Dependencies. Refused at enqueue rather than discovered later: a chain that
  // names a job nobody ever posted would otherwise sit in 'waiting' forever,
  // looking exactly like a chain whose build is merely slow.
  let deps: string[] = [];
  if (spec.depends_on !== undefined) {
    if (!Array.isArray(spec.depends_on) || spec.depends_on.some((d) => typeof d !== "string" || !d))
      return refuse(400, "invalid_dependency", "depends_on must be an array of job ids");
    deps = [...new Set(spec.depends_on)];
    const bad = validateDependencies(spec.job_id, deps);
    if (bad) return refuse(400, "invalid_dependency", bad);
  }
  const badRef = validateDepRefs(JSON.stringify(spec), deps);
  if (badRef) return refuse(400, "invalid_dependency", badRef);

  const depState = dependencyState(deps);
  // A chain whose dependencies are all closed already gets no promotion event,
  // so the substitution that promotion would have done happens here instead.
  if (depState.status === "queued" && deps.length > 0) {
    const filled = substituteDepRefs(spec);
    if (filled.unresolved.length > 0)
      return refuse(422, "unresolved_reference", `cannot resolve ${filled.unresolved.join("; ")}`);
    spec = filled.spec;
  }
  const dependsOn = deps.length > 0 ? JSON.stringify(deps) : null;

  if (spec.targets?.match && !isValidMatch(spec.targets.match))
    return refuse(400, "invalid_match", `invalid targets.match expression: ${spec.targets.match}`);

  const pool = spec.targets?.pool;
  const match = spec.targets?.match;
  // Same predicate the claim uses, so neither fan-out nor a preview can name a
  // device that will then never be offered the job. For host jobs the
  // capability belongs to the executor rather than the device, so it is not
  // applied.
  const selected = () =>
    spec.executor === "device"
      ? matchingDevices(pool, match, spec.workload, spec.backend ?? null)
      : matchingDevices(pool, match);

  const existing = db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(spec.job_id);

  // Fan-out: one queued child per registered device in the target pool, each
  // pinned via targets.device_id.
  if (spec.fanout) {
    // Host jobs fan out too now. A host child is pinned with targets.device_id
    // exactly as a device child is, and the executor's own selectTargets
    // already honours that field, so nothing downstream needed teaching.
    const distinct = typeof spec.fanout === "object" && spec.fanout !== null
      ? (spec.fanout as { distinct?: string }).distinct
      : undefined;
    if (distinct !== undefined && typeof distinct !== "string")
      return refuse(400, "invalid_spec", "fanout.distinct must be a descriptor field name");

    let devices = selected();
    if (devices.length === 0)
      return refuse(
        400, "no_matching_devices",
        `no registered devices${pool ? ` in pool ${pool}` : ""}${match ? ` matching ${match}` : ""}` +
          ` can run ${spec.workload}`,
        "list devices with GET /api/v1/devices",
      );

    // "One per distinct OS" is the canary shape: a smoke pass on every OS on
    // the shelf without paying for every phone. Newest-seen wins within a
    // group, because that is the device most likely to still be plugged in.
    if (distinct) {
      const seen = new Map<string, typeof devices[number]>();
      for (const d of devices) {
        const key = String(
          (JSON.parse(d.descriptor) as Record<string, unknown>)[distinct] ?? "",
        );
        // matchingDevices returns registry order, which is last_seen DESC.
        if (!seen.has(key)) seen.set(key, d);
      }
      devices = [...seen.values()];
    }

    const children = devices.map((d) => {
      const child: JobSpec = {
        ...spec,
        job_id: `${spec.job_id}--${d.device_id}`,
        targets: { ...spec.targets, device_id: d.device_id },
      };
      delete child.fanout;
      return child;
    });

    if (dryRun) {
      return {
        ok: true, http: 200, status: depState.status, job_id: spec.job_id,
        fanout: children.map((c) => c.job_id),
        preview: { spec, candidates: devices.map(candidate), warnings: warningsFor(spec, devices.length, depState) },
      };
    }

    // Every child inherits the parent's dependencies, so a fan-out can hang off
    // a single build the same way one pinned job can.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts, priority, parent_job_id, template_id, depends_on, status, last_error, requested_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const created: string[] = [];
    for (const child of children) {
      const r = insert.run(
        child.job_id, child.executor, child.workload, JSON.stringify(child), ttlS, maxAttempts,
        priority, spec.job_id, templateId, dependsOn, depState.status,
        depState.status === "failed" ? depState.reason : null,
        provenance.requested_by, provenance.source,
      );
      if (r.changes > 0) created.push(child.job_id);
    }
    if (depState.status === "failed")
      for (const jobId of created)
        db.prepare("UPDATE jobs SET finished_at = datetime('now') WHERE job_id = ?").run(jobId);
    for (const jobId of created)
      announce({ type: "job", job_id: jobId, status: depState.status, workload: spec.workload, executor: spec.executor, parent: spec.job_id });
    return { ok: true, http: 201, status: depState.status, job_id: spec.job_id, fanout: created };
  }

  if (dryRun) {
    if (existing) return refuse(409, "duplicate_job", "job_id already exists", "omit job_id to have one generated");
    let devices = selected();
    if (spec.targets?.device_id) devices = devices.filter((d) => d.device_id === spec.targets?.device_id);
    return {
      ok: true, http: 200, status: depState.status, job_id: spec.job_id,
      preview: { spec, candidates: devices.map(candidate), warnings: warningsFor(spec, devices.length, depState) },
    };
  }

  try {
    db.prepare(
      `INSERT INTO jobs (job_id, executor, workload, spec, lease_ttl_s, max_attempts, priority, template_id, depends_on, status, last_error, finished_at, requested_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${depState.status === "failed" ? "datetime('now')" : "NULL"}, ?, ?)`,
    ).run(
      spec.job_id, spec.executor, spec.workload, JSON.stringify(spec), ttlS, maxAttempts, priority, templateId,
      dependsOn, depState.status, depState.status === "failed" ? depState.reason : null,
      provenance.requested_by, provenance.source,
    );
  } catch (e: unknown) {
    if (isUniqueViolation(e)) return refuse(409, "duplicate_job", "job_id already exists", "omit job_id to have one generated");
    throw e;
  }
  announce({ type: "job", job_id: spec.job_id, status: depState.status, workload: spec.workload, executor: spec.executor });
  return { ok: true, http: 201, status: depState.status, job_id: spec.job_id };
}

/**
 * What would make an otherwise valid job sit in the queue, said before it is
 * queued. Every one of these has cost somebody an afternoon of waiting on a job
 * that was never going to start.
 */
function warningsFor(spec: JobSpec, candidates: number, deps: { status: string; reason?: string }): string[] {
  const out: string[] = [];
  if (deps.status === "failed") out.push(`a dependency already failed (${deps.reason ?? "unknown"}); the job would be failed at once`);
  if (deps.status === "waiting") out.push("waiting on depends_on; it starts when those jobs are done");
  if (spec.executor === "device" && candidates === 0) {
    out.push("no registered device matches these targets and can run this workload; the job would queue until one does");
  }
  if (spec.executor === "host") {
    const live = db
      .prepare(`SELECT name FROM executors WHERE ${AGE("last_seen")} <= ?`)
      .all(EXECUTOR_LIVE_S) as { name: string }[];
    const wanted = spec.targets?.executor;
    if (live.length === 0) out.push("no host executor has polled in the last two minutes; nothing would claim this");
    else if (wanted && !live.some((e) => e.name === wanted))
      out.push(`targets.executor is '${wanted}', which has not polled in the last two minutes (live: ${live.map((e) => e.name).join(", ")})`);
  }
  return out;
}
