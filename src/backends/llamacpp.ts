/**
 * The llama.cpp backend: fetch the model by content hash, shell `llama-bench`,
 * and turn its output into the fleet's metric names.
 *
 * llama-bench is used rather than a linked library on purpose. This agent runs
 * on whatever laptop it is dropped onto, and the binary there is the one the
 * operator built for that machine's accelerator — Metal, CUDA, Vulkan, plain
 * CPU. Shelling out means the numbers describe the build somebody actually
 * uses, and `--version` output lands in the error row when it does not.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Backend, IterResult } from "./types.js";
import type { JobSpec } from "../protocol.js";
import { intParam } from "../protocol.js";
import { CollectorClient, fileMatchesHash } from "../collector.js";
import { resolveLlamaBench } from "../capabilities.js";
import { memorySample } from "../telemetry.js";

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_CACHE_DIR ?? path.join(os.homedir(), ".cache", "fleet-runner-machine");
}

/** One row of `llama-bench -o json`. */
export type BenchRow = {
  n_prompt?: number;
  n_gen?: number;
  avg_ts?: number;
  avg_ns?: number;
  reps?: number;
  samples_ns?: number[];
};

export type ParsedBench = {
  prefillTokS?: number;
  decodeTokS?: number;
  /** Wall time the process spent outside the timed tests: model load plus start. */
  loadMs?: number;
};

/**
 * Parses `llama-bench -o json` into the fleet's names.
 *
 * A prompt row (`n_prompt > 0`, `n_gen == 0`) is prefill; a generation row
 * (`n_gen > 0`) is decode. Both are reported by llama-bench as tokens/second
 * already, so nothing is converted.
 *
 * `load_ms` is derived, and the derivation is the honest description of it:
 * llama-bench reports no load timer, so this is the process's wall time minus
 * the time it says it spent inside the tests — model load plus process start,
 * which is what the number is called on a phone too, but measured from the
 * outside rather than by the runtime.
 */
export function parseLlamaBench(stdout: string, wallMs: number): ParsedBench {
  const parsed: unknown = JSON.parse(stdout);
  const rows: BenchRow[] = Array.isArray(parsed)
    ? (parsed as BenchRow[])
    : Array.isArray((parsed as { results?: unknown })?.results)
      ? ((parsed as { results: BenchRow[] }).results)
      : [];
  if (rows.length === 0) throw new Error("llama-bench produced no result rows");

  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const prefill = rows.find((r) => (r.n_prompt ?? 0) > 0 && (r.n_gen ?? 0) === 0);
  const decode = rows.find((r) => (r.n_gen ?? 0) > 0 && (r.n_prompt ?? 0) === 0) ?? rows.find((r) => (r.n_gen ?? 0) > 0);

  let testedMs = 0;
  for (const r of rows) {
    const avgNs = num(r.avg_ns);
    if (avgNs !== undefined) testedMs += (avgNs * Math.max(num(r.reps) ?? 1, 1)) / 1e6;
    else if (Array.isArray(r.samples_ns)) testedMs += r.samples_ns.reduce((a, b) => a + (num(b) ?? 0), 0) / 1e6;
  }

  const loadMs = testedMs > 0 ? Math.max(0, Math.round(wallMs - testedMs)) : undefined;
  return { prefillTokS: num(prefill?.avg_ts), decodeTokS: num(decode?.avg_ts), loadMs };
}

export class LlamaCppBackend implements Backend {
  readonly name = "llama.cpp";
  private binary: string | null = null;
  private modelPath: string | null = null;
  private loadMs = 0;

  constructor(private readonly client: CollectorClient, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /**
   * Resolves the binary and puts the model on disk. The artifact's hash is
   * verified before it is used, on a fresh download and on a cache hit alike:
   * the file is named for its hash, and a name is not a check.
   *
   * The time returned is artifact preparation — download and verification —
   * not model load. llama-bench loads the model itself on every invocation, so
   * the load_ms that reaches results comes from `runIteration`.
   */
  async load(job: JobSpec): Promise<number> {
    const t0 = Date.now();
    const bin = await resolveLlamaBench(this.env);
    if (!bin) {
      throw new Error(
        "llama.cpp backend unavailable: no llama-bench on PATH (set FLEET_LLAMA_BENCH to its path)",
      );
    }
    this.binary = bin;

    const model = job.model;
    if (!model?.sha256) throw new Error("llama.cpp backend needs job.model.sha256");
    if (model.format !== "gguf") throw new Error(`llama.cpp backend needs a gguf model, got '${model.format}'`);

    const dir = cacheDir(this.env);
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${model.sha256}.gguf`);
    if (!(await fileMatchesHash(dest, model.sha256))) {
      await this.client.fetchArtifact(model.sha256, dest);
    }
    this.modelPath = dest;
    this.loadMs = Date.now() - t0;
    return this.loadMs;
  }

  async runIteration(job: JobSpec): Promise<IterResult> {
    if (!this.binary || !this.modelPath) throw new Error("load() not called");
    const promptTokens = intParam(job.params, "prompt_tokens", 512);
    const genTokens = intParam(job.params, "gen_tokens", 128);
    const reps = intParam(job.params, "llama_bench_reps", 1);
    const extra = Array.isArray(job.params?.llama_bench_args)
      ? (job.params.llama_bench_args as unknown[]).filter((a): a is string => typeof a === "string")
      : [];

    const args = [
      "-m", this.modelPath,
      "-p", String(promptTokens),
      "-n", String(genTokens),
      "-r", String(Math.max(reps, 1)),
      "-o", "json",
      ...extra,
    ];

    const t0 = Date.now();
    const { stdout, stderr, code, peakMem } = await runWatched(this.binary, args);
    const wallMs = Date.now() - t0;
    if (code !== 0) {
      throw new Error(`llama-bench exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
    }

    let parsed: ParsedBench;
    try {
      parsed = parseLlamaBench(stdout, wallMs);
    } catch (e) {
      throw new Error(`llama-bench output not parseable: ${(e as Error).message}; first 200 chars: ${stdout.slice(0, 200)}`);
    }

    return {
      prefillTokS: parsed.prefillTokS,
      decodeTokS: parsed.decodeTokS,
      // No time-to-first-token: llama-bench does not measure one, and deriving
      // it from the decode rate would be an invention rather than a reading.
      loadMs: parsed.loadMs,
      peakMemMb: peakMem?.mb,
      memMethod: peakMem?.method,
    };
  }

  unload(): void {
    this.binary = null;
    this.modelPath = null;
  }
}

/**
 * Runs a child and samples its memory while it works.
 *
 * The sample is taken from outside the process because that is the only vantage
 * a shelled-out benchmark leaves, and it is labeled with the method used —
 * `pss` on Linux where smaps_rollup gives a real proportional set size,
 * `max_rss` everywhere else. Two numbers measured differently are never
 * reported as if they were the same number; see `memorySample`.
 */
async function runWatched(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null; peakMem: { mb: number; method: string } | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let peak: { mb: number; method: string } | null = null;

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    const timer = setInterval(() => {
      if (child.pid === undefined) return;
      void memorySample(child.pid).then((s) => {
        if (s && (!peak || s.mb > peak.mb)) peak = s;
      });
    }, 250);

    const done = (code: number | null) => {
      clearInterval(timer);
      resolve({ stdout, stderr, code, peakMem: peak });
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(null);
    });
    child.on("close", done);
  });
}
