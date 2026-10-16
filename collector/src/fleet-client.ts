// The host executor's collector-client primitives, shared by the workload
// modules under src/web/ and by the executor itself. One implementation of
// "post a result row" and "move an artifact" — the alternative is each
// workload module growing its own copy, and copies are where the result
// contract quietly forks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { withFailureReasons } from "./result-reason.js";

export const exec = promisify(execFile);

export const BASE = process.env.FLEET_URL ?? "http://127.0.0.1:8788";
export const NAME = process.env.FLEET_EXECUTOR_NAME ?? os.hostname().replace(/\.local$/, "");

/**
 * Every request this process makes to its own collector carries FLEET_TOKEN.
 *
 * The executor and its workload modules call fetch against BASE in a dozen
 * places, written before the collector had auth; threading a header through
 * each would leave the thirteenth to be found by a 401 in production. So fetch
 * is wrapped once, here, and adds the token only when the URL's origin is the
 * collector's: a token must never ride along to a site under test.
 *
 * The token wants `agent` (claims, results, artifacts) plus `read` for the
 * dashboard reads some workloads make (visual baselines, findings precision),
 * and `run` if this host runs the digest, which enqueues its own job.
 */
function installCollectorAuth(): void {
  const token = process.env.FLEET_TOKEN?.trim();
  if (!token) return;
  let origin: string;
  try {
    origin = new URL(BASE).origin;
  } catch {
    return;
  }
  const inner = globalThis.fetch;
  if ((inner as { fleetAuth?: boolean }).fleetAuth) return;
  const wrapped = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let same = false;
    try {
      same = new URL(url).origin === origin;
    } catch { /* relative or malformed: not ours */ }
    if (!same) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    if (!headers.has("x-fleet-source")) headers.set("x-fleet-source", "executor");
    return inner(input, { ...init, headers });
  };
  Object.assign(wrapped, { fleetAuth: true });
  globalThis.fetch = wrapped as typeof fetch;
}
installCollectorAuth();

export const log = (msg: string) => console.log(`[executor:${NAME}] ${msg}`);

export async function post(url: string, body: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
}

/**
 * Post one result row. Every host workload's rows go through here, so this is
 * where a row that says `ok: false` and nothing else is given a reason -- see
 * result-reason.ts.
 */
export const postResult = withFailureReasons(async (row: Record<string, unknown>) => {
  await post("/results", { schema: 1, kind: "result", ...row });
});

export async function postBeacon(jobId: string, deviceId: string, extra: Record<string, unknown>) {
  await post("/results", {
    schema: 1, kind: "beacon", job_id: jobId, device_id: deviceId, beacon: extra,
  });
}

export async function fetchArtifact(sha256: string, dest: string) {
  const res = await fetch(`${BASE}/artifacts/${sha256}`);
  if (!res.ok) throw new Error(`artifact ${sha256} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`artifact hash mismatch: ${got}`);
  writeFileSync(dest, buf);
}

export async function uploadArtifact(file: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-artifact-name": name },
    body: readFileSync(file),
  });
  if (!res.ok) throw new Error(`artifact upload -> ${res.status}`);
  return ((await res.json()) as { sha256: string }).sha256;
}

/**
 * The per-unit time budget a lease allows, in seconds. Shared by every web
 * workload: nothing beacons DURING one unit of work (a project run, a device
 * capture, a crawl segment), so each unit must finish inside the lease —
 * stopping a little short of it, so a timing-out unit reports its own failure
 * rather than being swept mid-flight and silently re-run by the next claimant.
 */
export function leaseBudgetS(job: { lease?: { ttl_s?: number }; params?: Record<string, unknown> }, fallbackS = 570): number {
  const lease = Number(job.lease?.ttl_s);
  const asked = Number(job.params?.timeout_s);
  const budget = Number.isFinite(asked) && asked > 0
    ? asked
    : (Number.isFinite(lease) && lease > 30 ? lease - 30 : fallbackS);
  return Math.max(30, budget);
}

/**
 * Nothing attached could run this job.
 *
 * Thrown where a host workload finds its target list empty, and caught once in
 * the executor's poll loop, which reports it as a skip rather than a failure --
 * the same convention as a device that is locked or lacks the app.
 *
 * It was a plain Error, which made it a failed job, which raised a `job-failed`
 * alert. `nightly-fleet-ui-smoke` failed six nights in a row for that reason
 * alone: its Android phone was unplugged. The unplugged phone is real news, and
 * `device-offline` already delivers it for every named device; the nightly
 * failing as well was the same fact twice, every night, and a nightly that is
 * always red is one nobody reads. A job that could not run has not failed.
 */
export class NoTargetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTargetsError";
  }
}
