// CI entry point: upload a build (optional), enqueue a job through /api/v1,
// wait for the verdict, and exit with the same codes as `fleetr run`:
//
//   0 passed   1 failed, mixed or cancelled   2 usage or invalid spec
//   3 still running when --timeout ran out    4 skipped (nothing ran)
//   5 refused or unreachable
//
// A skip is exit 4, not 0: a job that reported `skipped:` tested nothing, and a
// check that goes green on it is lying. This is what a GitHub Actions step
// runs; see ci/example-workflow.yml. Standalone-testable:
//
//   npx tsx scripts/ci-enqueue.ts --job job.json [--artifact app.apk] [--timeout 900] [--channel pr|main]
//
// Auth: FLEET_RUNNER_TOKEN (or FLEET_TOKEN) is sent as a bearer token, which a
// collector with FLEET_AUTH=tokens requires (`run` scope). FLEET_DASH_TOKEN is
// still sent as x-fleet-token for a collector that only has the dashboard's
// speed bump. The upload rides the runner protocol, so with
// FLEET_AUTH_PROTOCOL=token the token needs `agent` as well.
//
// --artifact uploads the build and writes its hash into the spec's app.sha256
// (or model.sha256), replacing whatever placeholder was there
// ("replaced-by-upload" in the examples). A pull request's build is uploaded on
// the `pr` channel, so it never becomes the `latest` a nightly tests: that is
// automatic when GITHUB_EVENT_NAME is pull_request or pull_request_target, and
// --channel pr|main says it explicitly.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FleetApiError, FleetClient, type JobSummary } from "../src/client/index.js";

const EXIT = { passed: 0, failed: 1, usage: 2, pending: 3, skipped: 4, error: 5 } as const;

const USAGE =
  "usage: ci-enqueue --job <spec.json> [--artifact <file>] [--collector <url>] [--timeout <s>] [--channel pr|main]";

function die(code: number, msg: string): never {
  console.error(`ci-enqueue: ${msg}`);
  process.exit(code);
}

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!flag.startsWith("--") || value === undefined) die(EXIT.usage, `${flag} needs a value\n${USAGE}`);
  args.set(flag.replace(/^--/, ""), value);
}
const known = new Set(["job", "artifact", "collector", "timeout", "channel"]);
for (const k of args.keys()) if (!known.has(k)) die(EXIT.usage, `unknown flag --${k}\n${USAGE}`);

const BASE = (args.get("collector") ?? process.env.FLEET_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const JOB_FILE = args.get("job");
const ARTIFACT = args.get("artifact");
const TIMEOUT_S = Number(args.get("timeout") ?? 900);
const TOKEN = (process.env.FLEET_RUNNER_TOKEN || process.env.FLEET_TOKEN || "").trim() || null;
const DASH_TOKEN = process.env.FLEET_DASH_TOKEN?.trim() || null;

if (!JOB_FILE) die(EXIT.usage, USAGE);
if (!Number.isFinite(TIMEOUT_S) || TIMEOUT_S < 0) die(EXIT.usage, "--timeout must be a number of seconds");

/** `pr`, or null for a build that may become `latest`. */
function channelOf(flag: string | undefined, event: string | undefined): "pr" | null {
  if (flag === "pr") return "pr";
  if (flag === "main") return null;
  if (flag !== undefined) die(EXIT.usage, `--channel must be pr or main, not ${flag}`);
  return event === "pull_request" || event === "pull_request_target" ? "pr" : null;
}
const CHANNEL = channelOf(args.get("channel"), process.env.GITHUB_EVENT_NAME);

let spec: Record<string, any>;
try {
  spec = JSON.parse(readFileSync(JOB_FILE, "utf8"));
} catch (e) {
  die(EXIT.usage, `cannot read ${JOB_FILE}: ${(e as Error).message}`);
}
if (!spec || typeof spec !== "object" || Array.isArray(spec)) die(EXIT.usage, `${JOB_FILE} is not a JSON job spec`);

const client = new FleetClient({
  baseUrl: BASE,
  token: TOKEN,
  source: "ci",
  headers: DASH_TOKEN ? { "x-fleet-token": DASH_TOKEN } : {},
});

if (ARTIFACT) {
  let body: Buffer;
  try {
    body = readFileSync(ARTIFACT);
  } catch (e) {
    die(EXIT.usage, `cannot read ${ARTIFACT}: ${(e as Error).message}`);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/artifacts`, {
      method: "POST",
      // Tag the build with the app it belongs to, so a nightly can ask for the
      // latest one instead of pinning a hash somebody has to remember to bump.
      headers: {
        ...client.headers(),
        "content-type": "application/octet-stream",
        "x-artifact-name": ARTIFACT.split("/").pop()!,
        ...(spec.app?.name ? { "x-artifact-app": String(spec.app.name) } : {}),
        ...(spec.app?.build ? { "x-artifact-build": String(spec.app.build) } : {}),
        ...(spec.app?.platform ? { "x-artifact-platform": String(spec.app.platform) } : {}),
        ...(CHANNEL ? { "x-artifact-channel": CHANNEL } : {}),
      },
      body: new Uint8Array(body),
    });
  } catch (e) {
    die(EXIT.error, `cannot reach ${BASE}: ${(e as Error).message}`);
  }
  if (!res.ok) die(EXIT.error, `artifact upload -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { sha256 } = (await res.json()) as { sha256: string };
  const local = createHash("sha256").update(body).digest("hex");
  if (sha256 !== local) die(EXIT.error, `artifact hash mismatch: ${sha256} != ${local}`);
  if (spec.app) spec.app.sha256 = sha256;
  else if (spec.model) spec.model.sha256 = sha256;
  console.log(`artifact uploaded: ${sha256}${CHANNEL ? " (pr channel: never latest)" : ""}`);
}

let jobId: string;
try {
  const created = await client.createJob(spec as never);
  jobId = created.job_id;
  console.log(`enqueued ${jobId}`);
} catch (e) {
  if (!(e instanceof FleetApiError)) throw e;
  if (e.code === "duplicate_job" && typeof spec.job_id === "string") {
    jobId = spec.job_id;
    console.log(`job ${jobId} already queued; waiting on it`);
  } else {
    const schemaErrors = (e.details as { schema_errors?: { path: string; message: string }[] } | undefined)?.schema_errors ?? [];
    for (const se of schemaErrors) console.error(`  ${se.path}  ${se.message}`);
    const usage = e.status === 400;
    die(usage ? EXIT.usage : EXIT.error, `enqueue refused (${e.status} ${e.code}): ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
  }
}

// Long-poll /wait in slices of at most 120 s (the server's limit) until the
// job finishes or --timeout runs out. A collector that blips is retried until
// the deadline; one that never answers again is exit 5, not 3.
const deadline = Date.now() + TIMEOUT_S * 1000;
let summary: JobSummary | null = null;
let lastError: FleetApiError | null = null;
for (;;) {
  const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
  try {
    summary = await client.waitJob(jobId, { timeout_s: Math.min(120, left) }, { timeoutMs: (Math.min(120, left) + 30) * 1000 });
    lastError = null;
    if (summary.finished) break;
  } catch (e) {
    if (!(e instanceof FleetApiError)) throw e;
    if (e.status !== 0 && e.status < 500) die(EXIT.error, `wait refused (${e.status} ${e.code}): ${e.message}`);
    lastError = e;
    await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(0, deadline - Date.now()))));
  }
  if (Date.now() >= deadline) break;
}

if (!summary || lastError) die(EXIT.error, lastError?.message ?? `no answer from ${BASE}`);

console.log(`job ${jobId}: ${summary.finished ? summary.verdict : `still ${summary.verdict}`}`);
for (const d of summary.devices) {
  const state = d.skipped ? "skipped" : d.ok === true ? "passed" : d.ok === false ? "FAILED" : d.status;
  console.log(`  ${d.device_id}  ${state}`);
  if (d.failing_step) console.log(`    failing step: ${d.failing_step}`);
  if (d.error && !d.ok) console.log(`    ${d.error.split("\n")[0].slice(0, 300)}`);
}
console.log(`details: ${BASE}${summary.links.detail}`);

if (!summary.finished) die(EXIT.pending, `still ${summary.verdict} after ${TIMEOUT_S}s; it keeps running. fleetr wait ${jobId}`);
if (summary.verdict === "passed") process.exit(EXIT.passed);
if (summary.verdict === "skipped") die(EXIT.skipped, "skipped: nothing ran, so nothing was tested. This is not a pass.");
die(EXIT.failed, `${summary.verdict}: per-device details above and on the dashboard`);
