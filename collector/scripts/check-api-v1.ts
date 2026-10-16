// The /api/v1 contract, checked against a running collector.
//
// Every response this script receives is validated against the schema the
// OpenAPI document says it has. That is the point: the generated client, the
// MCP tools and every agent reading openapi.json believe those schemas, and a
// handler that drifts from its schema would otherwise lie to all of them at
// once while every test still passed.
//
// Runs from `npm test` against the same throwaway collector as the smoke run,
// after it. Usage: FLEET_URL=http://127.0.0.1:PORT tsx scripts/check-api-v1.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { FleetApiError, FleetClient } from "../src/client/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
const spec = JSON.parse(readFileSync(path.join(ROOT, "openapi.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema({ $id: "fleet", components: spec.components });

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Does `body` match component `name`? Reports the first few mismatches. */
function conforms(what: string, name: string, body: unknown) {
  const v = ajv.getSchema(`fleet#/components/schemas/${name}`);
  if (!v) return check(`${what} has schema ${name}`, false, "no such component");
  const ok = v(body) as boolean;
  check(`${what} matches ${name}`, ok, ok ? "" : JSON.stringify(v.errors?.slice(0, 3)));
}

async function refusal(what: string, p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
    check(what, false, `expected ${status} ${code}, got success`);
  } catch (e) {
    const err = e as FleetApiError;
    check(what, err.status === status && err.code === code, `got ${err.status} ${err.code}: ${err.message}`);
  }
}

const raw = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const fleet = new FleetClient({ baseUrl: BASE, source: "contract", actor: "contract-check" });
const DEVICE = `v1check-${Date.now().toString(36)}`;

console.log("meta");
conforms("health", "Health", await fleet.getHealth());
conforms("whoami", "WhoAmI", await fleet.whoami());
{
  const doc = (await fleet.getOpenApi()) as typeof spec;
  check("served openapi.json is the committed one", JSON.stringify(doc) === JSON.stringify(spec));
  const ids = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((ops) => Object.values(ops).map((o) => o.operationId));
  check("operationIds are unique", new Set(ids).size === ids.length);
}

console.log("workloads");
const workloads = await fleet.listWorkloads();
conforms("listWorkloads", "WorkloadList", workloads);
{
  const input = ajv.getSchema("fleet#/components/schemas/JobSpecInput")!;
  const bad: string[] = [];
  for (const w of workloads.items) {
    if (!w.example) continue;
    if (!input(w.example)) bad.push(`${w.name}: ${ajv.errorsText(input.errors)}`);
    if (w.params && !ajv.validate(w.params, (w.example as { params?: unknown }).params ?? {})) bad.push(`${w.name} params: ${ajv.errorsText()}`);
  }
  check("every workload's example is a spec createJob accepts", bad.length === 0, bad.join("; "));
  check("shell is marked dangerous", workloads.items.find((w) => w.name === "shell")?.dangerous === true);
  conforms("getWorkload", "Workload", await fleet.getWorkload("benchmark"));
  await refusal("unknown workload is 404 not_found", fleet.getWorkload("no-such-workload"), 404, "not_found");
}

console.log("jobs");
await raw("POST", "/devices/register", {
  device_id: DEVICE, descriptor: { model: "Contract Phone", os: "Android 15", platform: "android", kind: "phone" },
  pools: ["v1check"], capabilities: ["benchmark"],
});
{
  const v = await fleet.validateJob({ workload: "benchmark", executor: "device", backend: "synthetic", targets: { device_id: DEVICE } });
  conforms("validateJob (valid)", "Validation", v);
  check("validate lists the device as a candidate", v.valid && (v.candidates ?? []).some((c) => c.device_id === DEVICE), JSON.stringify(v));

  const typo = await fleet.validateJob({ workload: "benchmark", executor: "device", target: { pool: "x" } } as never);
  conforms("validateJob (typo)", "Validation", typo);
  check("a misspelt top-level key is refused", !typo.valid && JSON.stringify(typo.schema_errors).includes("target"));

  await refusal("createJob refuses a spec without executor", fleet.createJob({ workload: "benchmark" } as never), 400, "invalid_spec");
  await refusal("createJob refuses a workload nothing declares", fleet.createJob({ workload: "made-up-thing", executor: "device" }), 422, "no_capable_agent");
}

const created = await fleet.createJob({ workload: "benchmark", executor: "device", backend: "synthetic", targets: { device_id: DEVICE } });
conforms("createJob", "JobCreated", created);
check("createJob generates a job id carrying the source", created.job_id.startsWith("contract-benchmark-"), created.job_id);
await refusal("reposting a job id is 409 duplicate_job", fleet.createJob({ job_id: created.job_id, workload: "benchmark", executor: "device" }), 409, "duplicate_job");

{
  const s = await fleet.getJobSummary(created.job_id);
  conforms("getJobSummary (queued)", "JobSummary", s);
  check("queued summary is unfinished with verdict queued", !s.finished && s.verdict === "queued", `${s.verdict}`);
  check("requested_by and source are recorded", s.requested_by === "contract-check" && s.source === "contract", `${s.requested_by} ${s.source}`);
  const w = await fleet.waitJob(created.job_id, { timeout_s: 1 });
  check("waitJob returns unfinished at its timeout", !w.finished);
}

const claim = await raw("GET", `/devices/${DEVICE}/next-job`);
check("device claims the job", claim.status === 200);

// An artifact a result refers to, so the summary has something to list.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5e30000000049454e44ae426082", "hex");
const uploaded = await fetch(`${BASE}/artifacts`, {
  method: "POST", headers: { "content-type": "application/octet-stream", "x-artifact-name": "shot.png" }, body: png,
});
const art = (await uploaded.json()) as { sha256: string; media_type: string };
check("upload sniffs image/png", art.media_type === "image/png", JSON.stringify(art));
const html = await fetch(`${BASE}/artifacts`, {
  method: "POST", headers: { "content-type": "application/octet-stream", "x-artifact-name": "report.html" }, body: "<!doctype html><script>alert(1)</script>",
});
const htmlArt = (await html.json()) as { sha256: string; media_type: string };

const waiting = fleet.waitJob(created.job_id, { timeout_s: 20 });
const started = Date.now();
await raw("POST", "/results", {
  schema: 1, kind: "result", job_id: created.job_id, device_id: DEVICE, iter: 0, final: true, ok: true,
  metrics: { decode_tps: 10 }, artifacts: [art.sha256],
});
{
  const s = await waiting;
  conforms("waitJob (finished)", "JobSummary", s);
  check("waitJob wakes when the job finishes, not at its timeout", s.finished && Date.now() - started < 8_000, `${Date.now() - started}ms`);
  check("verdict passed, one device", s.verdict === "passed" && s.counts.passed === 1 && s.devices[0]?.device_id === DEVICE, JSON.stringify(s.counts));
  check("summary lists the output artifact with its media type", s.artifacts.some((a) => a.sha256 === art.sha256 && a.media_type === "image/png" && a.role === "output"));
}

conforms("getJob", "JobDetail", await fleet.getJob(created.job_id));
conforms("listJobs", "JobList", await fleet.listJobs({ source: "contract" }));
{
  const mine = await fleet.listJobs({ mine: true });
  check("listJobs mine=true finds the caller's job", mine.items.some((j) => j.job_id === created.job_id));
}
await refusal("cancelling a finished job is 409 conflict", fleet.cancelJob(created.job_id), 409, "conflict");
{
  const r = await fleet.retryJob(created.job_id, {});
  conforms("retryJob", "RetryResult", r);
  const c = await fleet.cancelJob(r.job_id, { reason: "contract check" });
  conforms("cancelJob", "CancelResult", c);
  check("cancel names what it cancelled", c.cancelled.includes(r.job_id));
  // The dashboard's Jobs screen builds its filter menus and its "has error"
  // box from these; they used to exist only on the unversioned /api/jobs.
  const errored = await fleet.listJobs({ has_error: true });
  check("listJobs has_error=true finds the cancelled job, and only jobs with an error",
    errored.items.some((j) => j.job_id === r.job_id) && errored.items.every((j) => j.last_error !== null));
  check("listJobs facets count every status, over the whole table",
    (errored.facets.status_counts.cancelled ?? 0) >= 1 && (errored.facets.status_counts.done ?? 0) >= 1, JSON.stringify(errored.facets.status_counts));
  check("listJobs facets name the workloads", errored.facets.workloads.includes("benchmark"), JSON.stringify(errored.facets.workloads));
}
await refusal("unknown job is 404 not_found", fleet.getJobSummary("no-such-job"), 404, "not_found");

{
  const fan = await fleet.createJob({ workload: "benchmark", executor: "device", backend: "synthetic", fanout: true, targets: { pool: "v1check" } });
  check("fan-out returns the parent and its children", (fan.fanout ?? []).length >= 1, JSON.stringify(fan));
  const s = await fleet.getJobSummary(fan.job_id);
  conforms("getJobSummary (fan-out parent)", "JobSummary", s);
  check("fan-out summary says so", s.fanout === true);
  await refusal("getJob on a fan-out parent is 404 with a hint", fleet.getJob(fan.job_id), 404, "not_found");
  const c = await fleet.cancelJob(fan.job_id);
  check("cancelling the parent cancels the children", c.cancelled.length === (fan.fanout ?? []).length);
  const after = await fleet.getJobSummary(fan.job_id);
  check("a cancelled fan-out reads cancelled", after.status === "cancelled" && after.verdict === "cancelled", `${after.status}/${after.verdict}`);
}

console.log("results, artifacts, fleet");
{
  const r = await fleet.listResults({ job: created.job_id });
  conforms("listResults", "ResultList", r);
  check("results omit payload by default", r.items.length > 0 && r.items.every((x) => !("payload" in x)));
  const full = await fleet.listResults({ job: created.job_id, include: "payload" });
  check("include=payload brings it back", full.items.every((x) => typeof x.payload === "object"));
  conforms("listFlaky", "FlakyCellList", await fleet.listFlaky());
}
{
  conforms("getArtifact", "Artifact", await fleet.getArtifact(art.sha256));
  const bytes = await fleet.getArtifactContent(art.sha256);
  check("artifact content is served as image/png", bytes.headers.get("content-type") === "image/png");
  check("artifact content is sandboxed", (bytes.headers.get("content-security-policy") ?? "").includes("sandbox"));
  const page = await fleet.getArtifactContent(htmlArt.sha256);
  check("an HTML artifact is never served inline", (page.headers.get("content-disposition") ?? "").startsWith("attachment"));
  await refusal("a malformed sha is 400", fleet.getArtifact("nothex"), 400, "bad_request");
}
console.log("findings");
{
  check("an artifact says its channel", (await fleet.getArtifact(art.sha256)).channel === "main");
  const flow = `appId: com.example.contract\n---\n- launchApp\n# ${DEVICE}\n`;
  const up = await fetch(`${BASE}/artifacts`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-artifact-name": "replay.yaml" }, body: flow });
  const flowSha = ((await up.json()) as { sha256: string }).sha256;
  const app = `contract-${DEVICE}`;
  const posted = await raw("POST", "/findings", {
    fingerprint: `${app}-1`, app, build: "1.0 (1)", platform: "android", device_id: DEVICE, job_id: "contract-explore", mission_id: "m",
    check: "crash", severity: "high", title: "Crashes on save", detail: "FATAL EXCEPTION", screen: "s1", screen_name: "Save",
    steps: ["Open the app", "Tap Save"], replay: { kind: "maestro", sha256: flowSha, attempts: 2, reproduced: 2 },
    artifacts: { shot: art.sha256, replay: flowSha },
  });
  const id = String(((await posted.json()) as { id: number }).id);
  const page = await fleet.listFindings({ app, since: "24h" });
  conforms("listFindings", "FindingList", page);
  check("listFindings finds it, in the list envelope", page.items.length === 1 && page.total === 1 && page.items[0].verdict === null);
  check("listFindings facets name every app and count the open ones", page.facets.apps.includes(app) && page.facets.counts.open === 1, JSON.stringify(page.facets));
  {
    const legacy = await raw("GET", `/api/findings/${id}`);
    check("the older finding route is deprecated, with its successor", (legacy.headers.get("link") ?? "").includes(`</api/v1/findings/${id}>; rel="successor-version"`));
    const precision = await raw("GET", "/api/findings/precision");
    check("precision, which has no successor, is not marked deprecated", precision.headers.get("deprecation") === null);
  }
  const one = await fleet.getFinding(id);
  conforms("getFinding", "FindingDetail", one);
  check("getFinding inlines the replay flow and links the evidence",
    one.replay_flow?.text === flow && one.evidence.some((e) => e.role === "shot" && e.url.endsWith(`${art.sha256}/content`)));
  await refusal("fixed before real is 409 conflict", fleet.setFindingVerdict(id, { verdict: "fixed" }), 409, "conflict");
  await refusal("an unknown verdict is 400", fleet.setFindingVerdict(id, { verdict: "meh" } as never), 400, "bad_request");
  const real = await fleet.setFindingVerdict(id, { verdict: "real", note: "contract" });
  conforms("setFindingVerdict (real)", "FindingVerdictResult", real);
  check("real makes a candidate regression", real.finding.regression?.state === "candidate" && real.finding.history.length === 1);
  const fixed = await fleet.setFindingVerdict(id, { verdict: "fixed" });
  check("fixed makes it active and says so", fixed.finding.regression?.state === "active" && /active/.test(fixed.change ?? ""));
  conforms("listFindings (verdict=fixed)", "FindingList", await fleet.listFindings({ verdict: "fixed", app }));
  await refusal("an unknown finding is 404", fleet.getFinding("999999999"), 404, "not_found");
  await refusal("a non-numeric finding id is 404", fleet.getFinding("abc"), 404, "not_found");
  await refusal("a bad since is 400", fleet.listFindings({ since: "whenever" }), 400, "bad_request");
  const audit = await fleet.listAudit({ per_page: 20 });
  check("a verdict is audited with its finding as the subject",
    audit.items.some((a) => a.route === `/api/v1/findings/${id}/verdict` && a.subject === id && a.actor === "contract-check"));
}

{
  const devices = await fleet.listDevices({ pool: "v1check" });
  conforms("listDevices", "DeviceList", devices);
  // Facets are over every device, so a filter never empties its own menu.
  const narrowed = await fleet.listDevices({ pool: "no-such-pool" });
  check("listDevices facets ignore the filter", narrowed.items.length === 0 && narrowed.facets.pools.includes("v1check"), JSON.stringify(narrowed.facets));
}
conforms("getDevice", "DeviceDetail", await fleet.getDevice(DEVICE));
conforms("listTemplates", "TemplateList", await fleet.listTemplates());
conforms("listSchedules", "ScheduleList", await fleet.listSchedules());
conforms("listAlerts", "AlertList", await fleet.listAlerts());
conforms("listAudit", "AuditEntryList", await fleet.listAudit({ per_page: 5 }));

console.log("envelope");
{
  const res = await raw("GET", "/api/v1/devices?simulator=perhaps");
  const body = await res.json();
  check("a bad query value is 400 in the envelope", res.status === 400, String(res.status));
  conforms("bad query", "Error", body);
  const nf = await raw("GET", "/api/v1/nothing-here");
  conforms("unknown v1 path", "Error", await nf.json());
  const bad = await raw("POST", "/api/v1/jobs", "{not json");
  conforms("unparseable body", "Error", await bad.json());
  check("unparseable body is 400", bad.status === 400);
}
{
  const legacy = await raw("GET", "/api/devices");
  check("legacy routes carry Deprecation", /^@\d+$/.test(legacy.headers.get("deprecation") ?? ""));
  check("and a successor-version Link", (legacy.headers.get("link") ?? "").includes('</api/v1/devices>; rel="successor-version"'));
  const protocol = await raw("GET", `/devices/${DEVICE}/next-job`);
  check("the runner protocol is not deprecated", protocol.headers.get("deprecation") === null);
}
{
  const m = await raw("GET", "/metrics");
  const text = await m.text();
  check("/metrics is Prometheus text", m.status === 200 && (m.headers.get("content-type") ?? "").startsWith("text/plain") && /^fleet_jobs\{status="done"\} \d+$/m.test(text));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
