/**
 * The protocol, made testable. Point it at a running agent and it says whether
 * that agent is a fleet runner.
 *
 *   npm run conformance -- --device machine-mymac
 *   npm run conformance -- --device pixel-4a --url http://fleet-host.local:8788
 *
 * ## Why this exists
 *
 * The runners share a protocol and no code. That is the right call — three
 * native agents are the reason a benchmark row from an iPhone means anything —
 * but it means every new platform is another hand-written implementation of the
 * same contract, and the contract lives in prose, two JSON Schemas, and the
 * memory of whoever wrote the last one.
 *
 * Prose does not fail a build. The `recall_at1` bug is what that costs: Swift's
 * `convertToSnakeCase` does not split on a digit, so `recallAt1` encoded one
 * underscore short of the declared name and the metric silently never arrived.
 * Nothing was broken, nothing threw, and the number was simply absent. Clause 3
 * below is that bug, turned into a check any runner can be pointed at.
 *
 * ## What "conformant" means here
 *
 * Not "implements every workload" — a watch that cannot run llama.cpp is a
 * perfectly good fleet member. It means the agent is HONEST: it claims only
 * what it declared, it reports metrics under the names the schema declares, it
 * refuses what it cannot do rather than going quiet, it renews a lease while
 * it works, and it stops when told to stop.
 *
 * Every clause is a thing that has actually gone wrong, on some platform, in
 * this fleet.
 *
 * ## How to read a failure
 *
 * A FAIL is a bug in the agent under test. A SKIP is a clause this agent's
 * declared capabilities put out of scope, which is not a mark against it. A
 * WARN is a soft contract — something every runner should do that no runner is
 * yet refused for not doing; each one says what would make it a FAIL.
 *
 * The suite never mutates the fleet it is pointed at beyond the jobs it
 * enqueues, and every job it enqueues is pinned to the device under test and
 * prefixed `conf-`. Run it against a throwaway collector when you can:
 * `npm run conformance` starts one for you unless --url says otherwise.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const BASE = arg("url") ?? process.env.FLEET_URL ?? "http://127.0.0.1:8788";
const DEVICE = arg("device") ?? process.env.FLEET_CONFORMANCE_DEVICE;
/** How long to wait for an agent to answer any single step. */
const PATIENCE_S = Number(arg("patience") ?? 90);
/**
 * How long a cancelled job may keep posting before it counts as ignoring the
 * cancel. Two beacon intervals plus slack: a runner beaconing every 30 s has
 * one full interval to hear the news and one iteration to act on it.
 */
const CANCEL_WINDOW_MS = 75_000;

/**
 * Whether this module is being RUN or merely imported.
 *
 * `referenceDigest` is exported so the collector's own suite can pin it — the
 * reference implementation is worth nothing if it silently drifts — and an
 * import must not start driving jobs at a collector or exit the process.
 */
const RUNNING_DIRECTLY = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (RUNNING_DIRECTLY && !DEVICE) {
  console.error(
    "usage: npm run conformance -- --device <device_id> [--url <collector>] [--patience <s>]\n\n" +
    "The device must already be registered and polling. Start your runner, point it at\n" +
    "the collector, and give its device_id here.",
  );
  process.exit(2);
}

// --- reporting --------------------------------------------------------------

let failures = 0;
let warnings = 0;
const results: string[] = [];

function pass(clause: string, name: string, detail = "") {
  results.push(`  ok    [${clause}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(clause: string, name: string, detail = "") {
  failures++;
  results.push(`  FAIL  [${clause}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function warn(clause: string, name: string, detail = "") {
  warnings++;
  results.push(`  warn  [${clause}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(clause: string, name: string, why: string) {
  results.push(`  skip  [${clause}] ${name} — ${why}`);
}
function check(clause: string, name: string, cond: boolean, detail = "") {
  if (cond) pass(clause, name);
  else fail(clause, name, detail);
}

// --- collector plumbing -----------------------------------------------------

async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type JobRow = {
  job_id: string;
  status: string;
  claimed_by: string | null;
  attempts: number;
  last_error: string | null;
  /** ISO, and the field this suite watches to see a beacon renew a lease. */
  lease_deadline?: string | null;
};
type ResultRow = { device_id: string; iter: number; payload: Record<string, unknown> };

/**
 * The job detail endpoint carries its result rows, so one GET answers both
 * "what is its status" and "what has it posted". There is no separate results
 * endpoint and none is needed.
 */
const detail = (id: string) => api<JobRow & { results?: ResultRow[] }>("GET", `/api/jobs/${encodeURIComponent(id)}`);
const job = (id: string) => detail(id);
const rows = async (id: string) => (await detail(id)).results ?? [];

/** Wait until `pred` holds for the job, or give up. Returns the last row seen. */
async function waitForJob(id: string, pred: (j: JobRow) => boolean, seconds = PATIENCE_S): Promise<JobRow> {
  const deadline = Date.now() + seconds * 1000;
  let last: JobRow | null = null;
  while (Date.now() < deadline) {
    last = await job(id);
    if (pred(last)) return last;
    await sleep(1000);
  }
  if (!last) throw new Error(`job ${id} never appeared`);
  return last;
}

const CLOSED = new Set(["done", "failed", "cancelled"]);
const isClosed = (j: JobRow) => CLOSED.has(j.status);

let seq = 0;
const jobId = (what: string) => `conf-${what}-${Date.now().toString(36)}-${seq++}`;

/** Enqueue pinned to the device under test. Never fans out, never floats. */
async function enqueue(spec: Record<string, unknown>): Promise<string> {
  const id = spec.job_id as string;
  await api("POST", "/jobs", {
    schema: 1,
    executor: "device",
    ...spec,
    targets: { ...(spec.targets as object ?? {}), device_id: DEVICE },
  });
  return id;
}

/** Best effort: leave nothing running behind us. */
async function cancelQuietly(id: string) {
  try {
    await api("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`);
  } catch { /* already closed */ }
}

// --- the reference synthetic digest -----------------------------------------

/**
 * The synthetic backend's block state, recomputed here from the spec rather
 * than imported from any runner.
 *
 * Independence is the whole point. Every runner pins this digest in its OWN
 * test suite against its OWN implementation, which proves each one is
 * self-consistent and proves nothing at all about whether the three agree.
 * This is a fourth implementation, written from the documented rules —
 * `block[i] = (i * 31) & 0xff`, then N rounds of SHA-256 with the digest
 * folded into the front of the block — so an agent matching it is agreeing
 * with the specification, not with a shared library.
 *
 * That agreement is the entire basis of the fleet's cross-platform table. If a
 * phone and a laptop are not doing this same arithmetic, their tok/s are two
 * different measurements printed in one column.
 */
const BLOCK_SIZE = 4096;
export function referenceDigest(rounds: number): string {
  const block = Buffer.allocUnsafe(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) block[i] = (i * 31) & 0xff;
  for (let i = 0; i < rounds; i++) {
    const out = createHash("sha256").update(block).digest();
    out.copy(block, 0, 0, out.length);
  }
  return createHash("sha256").update(block).digest("hex");
}

// --- the metric vocabulary --------------------------------------------------

/**
 * Every metric name the result schema declares, via the generated mirror.
 *
 * schemas/metrics.json is what the runner repositories already check
 * themselves against; reading the same file here means the suite cannot drift
 * from the check that runs in CI.
 */
function declaredMetrics(): Set<string> {
  const mirror = JSON.parse(readFileSync(path.join(ROOT, "schemas/metrics.json"), "utf8")) as
    | string[]
    | { metrics?: string[] };
  const names = Array.isArray(mirror) ? mirror : mirror.metrics ?? [];
  if (names.length === 0) throw new Error("schemas/metrics.json parsed to no names; refusing to check against nothing");
  return new Set(names);
}

// --- clauses ----------------------------------------------------------------

type Device = {
  device_id: string;
  descriptor: Record<string, unknown>;
  capabilities: string[] | null;
  platform: string;
  kind: string | null;
  status: string;
  /** Flattened from the last beacon; `busy` is what clause 9 reads. */
  beacon: { busy?: { job_id?: string; collector?: string } | null } | null;
};

/** 1. It registered, and said enough about itself to be scheduled. */
function clauseRegistration(dev: Device): void {
  const C = "1 register";
  const d = dev.descriptor;
  check(C, "the device is registered and online", dev.status === "online", `status=${dev.status}`);
  check(C, "the descriptor names a model", typeof d.model === "string" && d.model !== "", JSON.stringify(d.model));
  check(C, "the descriptor names an OS", typeof d.os === "string" && d.os !== "", JSON.stringify(d.os));
  check(C, "the descriptor names an app version", typeof d.app_ver === "string" && d.app_ver !== "");

  if (dev.capabilities === null) {
    // Legacy agents are offered everything, on purpose, so this cannot be a
    // failure without breaking the shelf. It is still the single most useful
    // thing a new runner can send.
    warn(C, "no capabilities declared", "the queue will offer this agent every workload; declare a list to be routed properly");
  } else {
    check(C, "capabilities is a list of strings", dev.capabilities.every((c) => typeof c === "string" && c !== ""));
    check(C, "capabilities is not empty", dev.capabilities.length > 0, "an agent declaring [] is offered nothing");
  }

  // Declared platform: soft, because the collector still infers one for agents
  // that predate the field, and every phone on the shelf does.
  if (typeof d.platform === "string" && d.platform !== "") {
    pass(C, `platform declared as ${d.platform}`);
  } else {
    warn(C, "platform not declared", `inferred as '${dev.platform}' from the os string; a non-phone agent that does not declare one is mislabelled`);
  }
  if (typeof d.kind === "string" && d.kind !== "") pass(C, `kind declared as ${d.kind}`);
  else warn(C, "kind not declared", "the dashboard will draw this agent as a phone");
}

/** 2. It runs the work it says it runs, and closes the job when done. */
async function clauseBenchmark(dev: Device): Promise<Record<string, unknown> | null> {
  const C = "2 benchmark";
  const caps = dev.capabilities;
  if (caps !== null && !caps.includes("benchmark") && !caps.some((c) => c.startsWith("benchmark:"))) {
    skip(C, "synthetic benchmark", "this agent does not declare `benchmark`");
    return null;
  }
  const id = jobId("bench");
  const ITERS = 2;
  await enqueue({
    job_id: id, workload: "benchmark", backend: "synthetic",
    params: { prompt_tokens: 32, gen_tokens: 8, warmup_iters: 0, measure_iters: ITERS },
  });
  const j = await waitForJob(id, isClosed);
  check(C, "the job closes rather than sitting claimed", isClosed(j), `status=${j.status}`);
  check(C, "the job succeeds", j.status === "done", j.last_error ?? "");

  const all = await rows(id);
  const mine = all.filter((r) => r.device_id === DEVICE);
  check(C, "the agent posted results under its own device_id", mine.length > 0, `saw ${all.map((r) => r.device_id).join(",")}`);
  const final = mine.find((r) => r.payload.final === true);
  check(C, "exactly one row is marked final", mine.filter((r) => r.payload.final === true).length === 1);
  if (!final) return null;
  check(C, "the final row carries a verdict", typeof final.payload.ok === "boolean");

  // Per-iteration rows are the contract the benchmark engine documents: one
  // row per measured iteration, plus the final summary. A runner that posts
  // only a summary produces a number nobody can see the spread of.
  const iterRows = mine.filter((r) => r.payload.final !== true);
  if (iterRows.length === ITERS) pass(C, `one row per measured iteration (${ITERS})`);
  else warn(C, "per-iteration rows missing", `asked for ${ITERS}, saw ${iterRows.length}; the spread of a benchmark is not visible without them`);

  const metrics = (final.payload.metrics ?? {}) as Record<string, unknown>;
  check(C, "the final row carries metrics", Object.keys(metrics).length > 0);
  for (const key of ["prefill_tok_s", "decode_tok_s"]) {
    const v = metrics[key];
    check(C, `${key} is a positive number`, typeof v === "number" && Number.isFinite(v) && v > 0, `${key}=${JSON.stringify(v)}`);
  }
  return metrics;
}

/** 3. Its metric names are the ones the schema declares. */
function clauseMetricNames(metrics: Record<string, unknown> | null): void {
  const C = "3 metrics";
  if (!metrics) return skip(C, "metric vocabulary", "no benchmark metrics to check");
  const declared = declaredMetrics();
  const unknown = Object.keys(metrics).filter((k) => !declared.has(k));
  if (unknown.length === 0) {
    pass(C, `every metric name is declared (${Object.keys(metrics).length} checked)`);
  } else {
    // This is the recall_at1 failure mode, and it is a FAIL rather than a warn
    // because the cost is silent: the collector stores the whole payload, so
    // the number is not lost — it is simply unqueryable forever, and nobody
    // finds out until a report cannot be reproduced.
    fail(C, "metric names the schema has never heard of", unknown.join(", ") +
      " — a name not in schemas/result.schema.json is stored but can never be queried; check for a snake_case encoder that split the name differently");
  }
}

/** 4. The synthetic backend is the same arithmetic here as everywhere else. */
function clauseDigest(metrics: Record<string, unknown> | null): void {
  const C = "4 identity";
  const attested = metrics?.synthetic_digest;
  if (typeof attested !== "string") {
    warn(C, "no synthetic digest attested",
      "the fleet's whole cross-platform table rests on this backend being identical everywhere, and nothing checks it across runners; " +
      "report metrics.synthetic_digest and this clause becomes a proof");
    return;
  }
  const rounds = Number(metrics?.synthetic_rounds ?? 0);
  if (!Number.isFinite(rounds) || rounds <= 0) {
    fail(C, "a digest was attested without a round count", "synthetic_digest means nothing without synthetic_rounds");
    return;
  }
  const expect = referenceDigest(rounds);
  check(C, `the synthetic block after ${rounds} rounds matches the specification`, attested === expect,
    `agent=${attested.slice(0, 16)}… reference=${expect.slice(0, 16)}… — this agent's tok/s are NOT comparable with the rest of the fleet`);
}

/** 5. It never claims a workload it did not declare. */
async function clauseUndeclared(dev: Device): Promise<void> {
  const C = "5 capabilities";
  if (dev.capabilities === null) {
    skip(C, "refuses undeclared work", "this agent declares nothing, so it is offered everything by design");
    return;
  }
  // A workload no agent declares is refused at enqueue by the collector, which
  // is the collector's own contract and not this agent's. So the probe is a
  // workload the FLEET knows and this agent did not claim.
  const known = ["benchmark", "batch", "vision-eval", "speech-eval", "embed-eval", "thermal", "vantage"];
  const undeclared = known.find((w) => !dev.capabilities!.some((c) => c === w || c.startsWith(`${w}:`)));
  if (!undeclared) {
    skip(C, "refuses undeclared work", "this agent declares every workload the probe knows to try");
    return;
  }
  let id: string;
  try {
    id = jobId("undeclared");
    await enqueue({ job_id: id, workload: undeclared, params: {} });
  } catch (e) {
    // A 422 here means no agent on the whole fleet declares it, which is the
    // collector refusing on everyone's behalf. Nothing to learn about this one.
    skip(C, "refuses undeclared work", `no agent on this fleet declares '${undeclared}'`);
    return;
  }
  // Give it long enough to have claimed it if it were going to.
  await sleep(8000);
  const j = await job(id);
  check(C, `does not claim '${undeclared}', which it never declared`,
    j.claimed_by !== DEVICE, `claimed_by=${j.claimed_by}`);
  await cancelQuietly(id);
}

/** 6. A cancelled job actually stops. */
async function clauseCancellation(dev: Device): Promise<void> {
  const C = "6 cancel";
  const caps = dev.capabilities;
  if (caps !== null && !caps.includes("benchmark") && !caps.some((c) => c.startsWith("benchmark:"))) {
    skip(C, "cancellation", "needs `benchmark` to have something long to cancel");
    return;
  }
  const id = jobId("cancel");
  // Long enough that it cannot simply finish inside the observation window
  // below, even on a fast machine.
  await enqueue({
    job_id: id, workload: "benchmark", backend: "synthetic",
    params: { prompt_tokens: 512, gen_tokens: 512, warmup_iters: 0, measure_iters: 60 },
  });
  const claimed = await waitForJob(id, (j) => j.claimed_by === DEVICE || isClosed(j), 60);
  if (isClosed(claimed)) {
    warn(C, "the job finished before it could be cancelled", "this agent is too fast for the probe; not a fault");
    return;
  }
  await api("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`);
  const j = await waitForJob(id, (x) => x.status === "cancelled", 60);
  check(C, "the job reaches cancelled", j.status === "cancelled", `status=${j.status}`);

  // What is measured here is LATENCY, not immediacy, and the difference is the
  // whole design of cancellation in this fleet.
  //
  // A workload does not receive a cancel. It learns about one by beaconing and
  // being told `lease_renewed: false`, then stops at its next iteration
  // boundary. So the honest question is not "did it stop instantly" — it
  // cannot — but "did it stop within one beacon interval, or did it run to
  // completion regardless". A runner that finishes all sixty iterations and
  // then notices is not cancellable; it is merely ignorable.
  //
  // Two consecutive quiet polls end the wait, so a well-behaved agent costs
  // seconds rather than the whole budget.
  const started = Date.now();
  let last = (await rows(id)).length;
  let quiet = 0;
  let stoppedAfterMs: number | null = null;
  while (Date.now() - started < CANCEL_WINDOW_MS) {
    await sleep(3000);
    const now = (await rows(id)).length;
    if (now === last) {
      if (++quiet >= 2) { stoppedAfterMs = Date.now() - started; break; }
    } else {
      quiet = 0;
      last = now;
    }
  }
  if (stoppedAfterMs !== null) {
    pass(C, `the agent stopped posting ${Math.round(stoppedAfterMs / 1000)}s after the cancel`);
  } else {
    fail(C, "the agent was still working a full beacon interval after cancellation",
      `rows were still arriving ${Math.round(CANCEL_WINDOW_MS / 1000)}s later; the workload must beacon on a clock ` +
      "between units of work — a beacon carrying the job_id is the only way a running job hears that it was cancelled");
  }
}

/** 7. A long job's lease is renewed while it runs. */
async function clauseLease(dev: Device): Promise<void> {
  const C = "7 lease";
  const caps = dev.capabilities;
  if (caps !== null && !caps.includes("benchmark") && !caps.some((c) => c.startsWith("benchmark:"))) {
    skip(C, "lease renewal", "needs `benchmark` to have something long enough to renew during");
    return;
  }
  const id = jobId("lease");
  // A short lease, so a renewal has to happen within the probe's patience.
  await enqueue({
    job_id: id, workload: "benchmark", backend: "synthetic",
    lease: { ttl_s: 60, max_attempts: 1 },
    params: { prompt_tokens: 256, gen_tokens: 256, warmup_iters: 0, measure_iters: 60 },
  });
  const claimed = await waitForJob(id, (j) => j.claimed_by === DEVICE || isClosed(j), 60);
  if (isClosed(claimed)) {
    skip(C, "lease renewal", "the job finished before a renewal was due");
    return;
  }
  const first = claimed.lease_deadline ?? null;
  await sleep(35_000);
  const later = await job(id);
  if (isClosed(later)) {
    skip(C, "lease renewal", "the job finished before a renewal was observed");
  } else if (first && later.lease_deadline && later.lease_deadline > first) {
    pass(C, "the lease deadline advanced while the job ran");
  } else if (later.attempts > claimed.attempts) {
    fail(C, "the lease lapsed and the job was requeued", "the agent is not beaconing during work; a long job will be requeued under it and run twice");
  } else {
    warn(C, "no lease renewal observed", `deadline stayed at ${first ?? "(none)"}; if this agent runs jobs longer than its lease it will be requeued mid-run`);
  }
  await cancelQuietly(id);
}

/** 8. An impossible precondition is refused out loud, not silently. */
async function clauseConstraints(dev: Device): Promise<void> {
  const C = "8 constraints";
  const caps = dev.capabilities;
  if (caps !== null && !caps.includes("benchmark") && !caps.some((c) => c.startsWith("benchmark:"))) {
    skip(C, "constraint refusal", "needs `benchmark`");
    return;
  }
  const id = jobId("battery");
  // 101% is a battery level no device has. A runner that enforces
  // min_battery_pct against live state must refuse this; one that ignores
  // constraints will happily run it, which is the bug worth finding.
  await enqueue({
    job_id: id, workload: "benchmark", backend: "synthetic",
    constraints: { min_battery_pct: 101 },
    params: { prompt_tokens: 32, gen_tokens: 8, warmup_iters: 0, measure_iters: 1 },
  });
  const j = await waitForJob(id, isClosed, 60);
  if (j.status === "failed") {
    const mine = (await rows(id)).filter((r) => r.device_id === DEVICE);
    const said = mine.some((r) => typeof r.payload.error === "string" && (r.payload.error as string).length > 0);
    check(C, "an unmeetable battery constraint is refused with a reason", said,
      "the job failed but the agent posted no error text; a refusal nobody can read is a silent failure");
  } else if (j.status === "done") {
    fail(C, "an unmeetable battery constraint was ignored", "min_battery_pct: 101 cannot be satisfied by any device, and this agent ran the job anyway");
  } else {
    // Still queued is also correct: some constraints are collector-enforced and
    // simply never offer the job.
    pass(C, `the job never ran (status=${j.status})`);
  }
  await cancelQuietly(id);
}

/**
 * Clause 9: an agent that belongs to more than one fleet behaves.
 *
 * This clause is unusual and deliberately so: it is **skipped for the great
 * majority of agents**, because an agent registered with one collector has
 * nothing to get wrong here. Multi-homing is opt-in and most runners will never
 * do it -- a Roku channel, a browser tab and a phone on a shelf are all
 * single-brain by nature.
 *
 * What it can check from one collector is the half that is observable from one
 * collector, which turns out to be the important half: does this agent tell
 * this brain when it is working for another one, and does it hand back a job it
 * cannot take. The full race -- two brains, two jobs, one device -- needs two
 * collectors and lives in fleet/test/multibrain.test.ts.
 *
 * A single-brain agent that never sends `busy` is CONFORMANT. The failure this
 * looks for is the opposite: an agent that says it is busy elsewhere and then
 * claims work anyway, which would mean two jobs on one piece of hardware and
 * two numbers that are both wrong.
 */
async function clauseMultiHome(dev: Device): Promise<void> {
  const C = "9 multi-home";
  const busy = dev.beacon?.busy as { job_id?: string; collector?: string } | null | undefined;
  if (!busy) {
    skip(
      C,
      "busy honoured",
      "this agent is not currently working for another collector, which is the ordinary case",
    );
  } else {
    // It told us it is busy. The rule is that it must not then take work here.
    const id = jobId("multihome");
    await enqueue({
      job_id: id, workload: "benchmark", backend: "synthetic",
      params: { prompt_tokens: 32, gen_tokens: 8, warmup_iters: 0, measure_iters: 1 },
    });
    // One long-poll interval is enough: if this agent were going to claim it, it
    // would have by now.
    const j = await waitForJob(id, (row) => row.status !== "queued", 40).catch(() => null);
    check(
      C,
      "an agent busy for another brain does not claim work here",
      j === null || j.status === "queued",
      `it said it was busy with ${busy.job_id ?? "?"} on ${busy.collector ?? "an unnamed collector"} and then claimed this job anyway`,
    );
    await cancelQuietly(id);
  }

  // And the endpoint the race needs, which is the collector's side rather than
  // the agent's -- checked here because an agent author reading a FAIL needs to
  // know whether the brain they are testing against even has it.
  const probe = await fetch(`${BASE}/jobs/definitely-not-a-job/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: DEVICE }),
  });
  if (probe.status === 404) {
    // Ambiguous by construction: a collector without the endpoint 404s, and so
    // does one that has it and cannot find the job. Both are fine; what matters
    // is that neither is an error an agent should treat as fatal.
    pass(C, "the collector answers a release for an unknown job with 404, as an agent must tolerate");
  } else {
    check(C, "a release for an unknown job is refused cleanly", probe.status < 500, `status=${probe.status}`);
  }
}

// --- run --------------------------------------------------------------------

async function main() {
  console.log(`conformance: ${DEVICE} against ${BASE}\n`);

  let dev: Device;
  try {
    dev = await api<Device>("GET", `/api/devices/${encodeURIComponent(DEVICE!)}`);
  } catch (e) {
    console.error(
      `cannot read device '${DEVICE}' from ${BASE}: ${(e as Error).message}\n\n` +
      "Start the runner, point it at this collector, and wait for it to register.",
    );
    process.exit(2);
  }

  clauseRegistration(dev);
  const metrics = await clauseBenchmark(dev);
  clauseMetricNames(metrics);
  clauseDigest(metrics);
  await clauseUndeclared(dev);
  await clauseCancellation(dev);
  await clauseLease(dev);
  await clauseConstraints(dev);
  await clauseMultiHome(dev);

  console.log(results.join("\n"));
  console.log(
    `\n${failures === 0 ? "CONFORMANT" : `${failures} FAILURE(S)`}` +
    (warnings > 0 ? `, ${warnings} warning(s)` : "") +
    `\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

if (RUNNING_DIRECTLY) {
  main().catch((e) => {
    console.error(`conformance run failed: ${(e as Error).message}`);
    process.exit(2);
  });
}
