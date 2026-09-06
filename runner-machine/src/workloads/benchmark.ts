/**
 * The benchmark workload: timed load, warmups excluded from measurement,
 * one result row per iteration, then a summary row at iter 0 that closes the
 * job. The same shape both phone runners post, so a laptop's rows land in the
 * same `GET /api/results/bench` table beside a phone's.
 */
import type { Backend, IterResult } from "../backends/types.js";
import { SyntheticBackend } from "../backends/synthetic.js";
import { LlamaCppBackend } from "../backends/llamacpp.js";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, intParam, compact } from "../protocol.js";
import { beacon, memorySample } from "../telemetry.js";
import { BEACON_MS } from "../beaconing.js";
import * as JobCancellation from "../cancellation.js";

export function backendFor(job: JobSpec, client: CollectorClient): Backend {
  const name = job.backend ?? "synthetic";
  if (name === "synthetic") return new SyntheticBackend();
  if (name === "llama.cpp") return new LlamaCppBackend(client);
  throw new Error(`backend '${name}' not supported by this runner yet`);
}

const mean = (xs: number[]): number | undefined =>
  xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function runBenchmark(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
): Promise<void> {
  const warmups = intParam(job.params, "warmup_iters", 1);
  const measures = intParam(job.params, "measure_iters", 3);
  // Sustained mode: keep iterating for N minutes instead of a fixed count. The
  // per-iteration rows ARE the thermal curve, which on a laptop is the whole
  // question — a fan-cooled machine holds a rate a phone cannot.
  const sustainedMinutes = intParam(job.params, "sustained_minutes", 0);

  const startSample = await beacon();
  const batteryStart = startSample.battery_pct ?? undefined;
  const thermals: string[] = [];

  let backend: Backend | null = null;
  try {
    backend = backendFor(job, client);
    const loadMs = await backend.load(job);
    for (let w = 0; w < warmups; w++) await backend.runIteration(job);

    const iters: IterResult[] = [];
    const deadline = sustainedMinutes > 0 ? Date.now() + sustainedMinutes * 60_000 : 0;
    let i = 0;
    // Seeded at the start of the run, not at zero: the agent's own beacon loop
    // has just been round, and an immediate second one would be noise.
    let lastBeaconAt = Date.now();
    while (sustainedMinutes > 0 ? Date.now() < deadline : i < measures) {
      // A cancelled job stops between iterations, never mid-iteration: the rows
      // already posted stay valid, this one just never starts.
      if (JobCancellation.isCancelled(job.job_id)) {
        backend.unload();
        await client.postResult({
          schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
          iter: 0, final: true, ok: false, device: descriptor, error: "cancelled",
        });
        return;
      }
      i += 1;
      const r = await backend.runIteration(job);
      iters.push(r);

      // One telemetry pass per iteration, not three: each one shells out.
      const sample = await beacon();
      const t = sample.thermal;
      if (t) thermals.push(t);
      const mem = r.peakMemMb !== undefined ? null : await memorySample();
      await client.postResult({
        schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId, iter: i,
        metrics: compact<Metrics>({
          prefill_tok_s: r.prefillTokS,
          decode_tok_s: r.decodeTokS,
          ttft_ms: r.ttftMs,
          peak_mem_mb: r.peakMemMb ?? mem?.mb,
          mem_method: r.memMethod ?? mem?.method,
          thermal: t ? [t] : undefined,
          battery_end_pct: sample.battery_pct ?? undefined,
        }),
      });

      // Beacon on a CLOCK, not on an iteration count.
      //
      // This used to fire on `sustainedMinutes > 0 && i % 5 === 0`, and both
      // halves of that were wrong in the same direction. Counting iterations
      // means a fast backend beacons twelve times a minute and a slow one
      // beacons once an hour, and gating on sustained mode means an ordinary
      // benchmark never beacons inside the loop at all.
      //
      // The second half is what the conformance suite caught. This beacon is
      // the ONLY way a running workload hears that it was cancelled — the
      // collector answers a beacon carrying a job_id with `lease_renewed:
      // false` once the claim is gone — so a plain twenty-iteration benchmark
      // could not learn it had been cancelled until the agent's background
      // beacon came round a minute later, by which time it had finished.
      // Cancelling it did nothing observable, which is indistinguishable from
      // cancellation being broken.
      //
      // It is also the lease renewal. A non-sustained run longer than its
      // lease was being requeued underneath itself and run twice.
      if (Date.now() - lastBeaconAt >= BEACON_MS) {
        lastBeaconAt = Date.now();
        // Only an explicit false cancels: a beacon that fails to post throws
        // to the catch below rather than quietly stopping the job.
        const renewed = await client.postBeacon({
          schema: SCHEMA, kind: "beacon", job_id: job.job_id, device_id: deviceId, beacon: sample,
        });
        if (!renewed) JobCancellation.cancel(job.job_id);
      }
    }
    // Taken before unload(), and on its own block, so it disturbs nothing.
    const attestation = backend.attest?.() ?? null;
    backend.unload();

    const end = await beacon();
    const lastIter = iters.at(-1);
    const summaryMem = lastIter?.peakMemMb !== undefined ? null : await memorySample();
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: true, device: descriptor,
      metrics: compact<Metrics>({
        // A backend that loads the model inside each run (llama-bench does)
        // reports the real load time per iteration; the synthetic backend
        // loads once, in load(), and reports it there.
        load_ms: lastIter?.loadMs ?? loadMs,
        prefill_tok_s: mean(iters.map((r) => r.prefillTokS).filter((n): n is number => n !== undefined)),
        decode_tok_s: mean(iters.map((r) => r.decodeTokS).filter((n): n is number => n !== undefined)),
        ttft_ms: mean(iters.map((r) => r.ttftMs).filter((n): n is number => n !== undefined)),
        peak_mem_mb: lastIter?.peakMemMb ?? summaryMem?.mb,
        mem_method: lastIter?.memMethod ?? summaryMem?.method,
        thermal: thermals.length ? thermals : undefined,
        battery_start_pct: batteryStart,
        battery_end_pct: end.battery_pct ?? undefined,
        // Only the synthetic backend answers this; the rest return undefined
        // and compact() drops the keys. It is on the final row rather than on
        // every iteration because it is a fact about the build, not about a
        // measurement.
        synthetic_digest: attestation?.digest,
        synthetic_rounds: attestation?.rounds,
      }),
    });
  } catch (e) {
    backend?.unload();
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor,
      error: (e as Error).message ?? String(e),
    });
  }
}
