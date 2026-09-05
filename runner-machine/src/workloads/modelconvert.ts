/**
 * The `model-convert` workload: turn one source checkpoint into the formats
 * the fleet's three runners can actually load, on the machine that has the
 * memory to do it.
 *
 * The reason this is a fleet workload rather than a script somebody runs is
 * the machine, not the code: quantising a multi-gigabyte checkpoint needs more
 * RAM than a phone has and more patience than a laptop on battery has, and the
 * collector already knows which machine is on mains and idle. What this
 * workload adds is that the OUTPUT is addressable — every product is uploaded
 * as an artifact and the final row lists every sha, so a dependent job can say
 * `${jobs.<id>.artifact}` and get the model this conversion made rather than
 * whatever was in someone's Downloads folder.
 *
 * The conversions themselves are other people's tools, deliberately: llama.cpp
 * for GGUF, and the plant-ID assets' own `convert_coreml.py` and
 * `quantize_int8.py` for Core ML and LiteRT. Those two scripts already work
 * and are already the provenance of the models this fleet has benchmarked;
 * rewriting their coremltools plumbing here would produce a second answer to a
 * question that already has one.
 */
import { mkdir, open, rm, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, intParam, stringParam } from "../protocol.js";
import { fileMatchesHash } from "../collector.js";
import { dataDir } from "../git.js";
import { run, which } from "../probe.js";
import { runWithBeacons, lastMeaningful } from "../beaconing.js";
import {
  parseOutputs, parseSource, planConvert, probeConverters, convertersAvailable,
  type ConvertPlan, type ConverterTools, type Source,
} from "../converters.js";

/** A conversion of a 70B checkpoint is hours; a hung one should still end. */
const DEFAULT_STEP_TIMEOUT_S = 6 * 60 * 60;

export async function runModelConvert(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (m: string) => console.log(`[${deviceId}] model-convert ${job.job_id}: ${m}`);
  const fail = async (error: string, artifacts?: string[], metrics?: Metrics) => {
    log(`failed: ${error}`);
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor, error,
      ...(artifacts?.length ? { artifacts } : {}),
      ...(metrics ? { metrics } : {}),
    });
  };

  let source: Source;
  let outputs: ReturnType<typeof parseOutputs>;
  try {
    source = parseSource(job.params?.source);
    outputs = parseOutputs(job.params?.outputs);
  } catch (e) {
    return fail((e as Error).message);
  }

  const tools = await probeConverters(env);
  const available = convertersAvailable(tools);
  const missing = outputs.filter((o) => !available.includes(o.format)).map((o) => o.format);
  if (missing.length === outputs.length) {
    // Every requested format is unbuildable here. Refused as one row rather
    // than N, and naming what this machine CAN do, because the answer the
    // operator needs is which machine to route the job to.
    return fail(
      `none of the requested formats can be converted on this machine (asked for ${[...new Set(missing)].join(", ")}; ` +
        `available here: ${available.length ? available.join(", ") : "none"})`,
    );
  }

  const workRoot = path.join(dataDir(env), "convert", safe(job.job_id));
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(workRoot, { recursive: true });

  const t0 = Date.now();
  const artifacts: string[] = [];
  let totalBytes = 0;
  try {
    let sourcePath: string;
    try {
      sourcePath = await materialiseSource(source, client, env, log);
    } catch (e) {
      return fail(`fetching the source failed: ${(e as Error).message}`);
    }

    let calibrationDir: string | null = null;
    const calibSha = stringParam(job.params, "calibration_sha256");
    if (calibSha) {
      try {
        calibrationDir = await materialiseSource({ kind: "artifact", sha256: calibSha.toLowerCase() }, client, env, log);
      } catch (e) {
        return fail(`fetching the calibration set failed: ${(e as Error).message}`);
      }
    }

    const name = stringParam(job.params, "name") ?? defaultName(source);
    const stepTimeoutMs = intParam(job.params, "timeout_s", DEFAULT_STEP_TIMEOUT_S) * 1000;
    const failures: string[] = [];

    for (const [i, spec] of outputs.entries()) {
      const outDir = path.join(workRoot, `${spec.format}-${(spec.quant ?? "none").toLowerCase()}`);
      await mkdir(outDir, { recursive: true });

      let plan: ConvertPlan;
      try {
        plan = planConvert(spec, tools, { source: sourcePath, outDir, name, calibrationDir });
      } catch (e) {
        failures.push((e as Error).message);
        log(`refused ${spec.format}/${spec.quant ?? "none"}: ${(e as Error).message}`);
        continue;
      }

      log(`converting ${spec.format}/${spec.quant ?? "none"} in ${plan.steps.length} step(s)`);
      const stepFailure = await runSteps(plan, job, client, deviceId, stepTimeoutMs, log);
      if (stepFailure) {
        failures.push(`${spec.format}/${spec.quant ?? "none"}: ${stepFailure}`);
        continue;
      }

      const product = path.join(outDir, plan.product);
      if (!existsSync(product)) {
        failures.push(
          `${spec.format}/${spec.quant ?? "none"}: the converter exited 0 but wrote no ${plan.product} (saw ${(await readdir(outDir).catch(() => [])).join(", ") || "nothing"})`,
        );
        continue;
      }
      const bytes = (await stat(product)).size;
      try {
        // Uploaded WITHOUT `x-artifact-app`: a converted model is not a build,
        // and publishing it under an app name would make it the thing a
        // nightly asking for `"sha256": "latest"` picks up.
        const up = await client.uploadArtifact(product, plan.product);
        artifacts.push(up.sha256);
        totalBytes += bytes;
        log(`${plan.product} -> ${up.sha256} (${bytes} bytes)`);
        // One row per output, so a four-output conversion is legible while it
        // is still running rather than only at the end.
        await client.postResult({
          schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
          iter: i + 1, ok: true, artifacts: [up.sha256],
          model_out: { format: plan.modelFormat, quant: plan.quant, name: plan.product, sha256: up.sha256, bytes },
        });
      } catch (e) {
        failures.push(`${spec.format}/${spec.quant ?? "none"}: upload failed: ${(e as Error).message}`);
      }
    }

    const convertS = Math.round((Date.now() - t0) / 100) / 10;
    const metrics = compact<Metrics>({
      convert_s: convertS,
      outputs: artifacts.length,
      artifact_bytes: totalBytes || undefined,
    });
    if (failures.length > 0) {
      // Partial success is still a failure of the job — a pipeline that asked
      // for three formats and got two must not read as green — but the shas
      // that DID land are listed, because they are real and a dependent job may
      // still want them.
      return fail(
        `${failures.length} of ${outputs.length} output(s) failed: ${failures.join(" | ").slice(0, 900)}`,
        artifacts,
        metrics,
      );
    }
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: true, device: descriptor,
      metrics,
      // Every sha, in the order the job asked for them, so a dependent job's
      // `${jobs.<id>.artifact}` resolves against a list that is not a surprise.
      artifacts,
    });
    log(`converted ${artifacts.length} output(s) in ${convertS}s`);
  } finally {
    // The products are in the artifact store now; the working copies are just
    // tens of gigabytes on somebody's boot disk.
    if (!env.FLEET_KEEP_CONVERT_WORK) await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs a plan's steps in order, stopping at the first that fails. */
async function runSteps(
  plan: ConvertPlan,
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  timeoutMs: number,
  log: (m: string) => void,
): Promise<string | null> {
  for (const step of plan.steps) {
    log(`  ${step.label}`);
    const r = await runWithBeacons({
      cmd: step.cmd, args: step.args, cwd: step.cwd, timeoutMs,
      jobId: job.job_id, deviceId, client,
    });
    if (r.cancelled) return "cancelled";
    if (r.timedOut) return `${step.label} timed out after ${Math.round(timeoutMs / 1000)}s`;
    if (r.spawnError) return `${step.label} could not start: ${r.spawnError}`;
    if (r.code !== 0) {
      return `${step.label} exited ${r.code ?? `on signal ${r.signal ?? "?"}`}: ${lastMeaningful(r.output) || "no output"}`;
    }
  }
  return null;
}

/**
 * The source on disk: a verified artifact, or a HuggingFace snapshot.
 *
 * An artifact that is a zip is extracted, because `convert_hf_to_gguf.py`
 * takes a DIRECTORY of a HuggingFace repo rather than a single file, and a
 * multi-file checkpoint can only reach the artifact store as one blob.
 */
async function materialiseSource(
  source: Source,
  client: CollectorClient,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): Promise<string> {
  if (source.kind === "hf") {
    const cli = (await which("huggingface-cli", env)) ?? (await which("hf", env));
    if (!cli) {
      throw new Error(
        `params.source is the HuggingFace repo ${source.repo}, but neither huggingface-cli nor hf resolves on this machine`,
      );
    }
    const dest = path.join(dataDir(env), "hf", source.repo.replace(/[^A-Za-z0-9._-]+/g, "-"));
    await mkdir(path.dirname(dest), { recursive: true });
    log(`downloading ${source.repo}`);
    const r = await run(cli, ["download", source.repo, "--local-dir", dest], 6 * 60 * 60 * 1000);
    if (r.code !== 0) throw new Error(`${path.basename(cli)} download ${source.repo} failed: ${lastMeaningful(r.stderr || r.stdout) || `exit ${r.code}`}`);
    return dest;
  }

  const cacheDir = path.join(dataDir(env), "sources");
  const blob = path.join(cacheDir, `${source.sha256}.bin`);
  if (!(await fileMatchesHash(blob, source.sha256))) {
    log(`fetching artifact ${source.sha256.slice(0, 12)}`);
    await client.fetchArtifact(source.sha256, blob);
  }
  if (!(await isZip(blob))) return blob;

  const extracted = path.join(cacheDir, source.sha256);
  if (!existsSync(extracted)) {
    await mkdir(extracted, { recursive: true });
    const r = await run("unzip", ["-q", "-o", blob, "-d", extracted], 60 * 60 * 1000);
    if (r.code !== 0) {
      await rm(extracted, { recursive: true, force: true }).catch(() => {});
      throw new Error(`unzipping ${source.sha256.slice(0, 12)} failed: ${lastMeaningful(r.stderr || r.stdout) || `exit ${r.code}`}`);
    }
  }
  // A zip of one directory is the common shape; hand the converter that
  // directory rather than its parent, which would look empty of config.json.
  const entries = await readdir(extracted, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("__MACOSX"));
  const files = entries.filter((e) => e.isFile());
  if (dirs.length === 1 && files.length === 0) return path.join(extracted, dirs[0]!.name);
  return extracted;
}

/** The four bytes that make a file a zip. */
export async function isZip(file: string): Promise<boolean> {
  try {
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      return bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** A filename stem for the products, from the job or from the source. */
export function defaultName(source: Source): string {
  const raw = source.kind === "hf" ? (source.repo.split("/").pop() ?? "model") : `model-${source.sha256.slice(0, 12)}`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "model";
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);

/** Kept for the tests: what the planner needs, with nothing installed. */
export type { ConverterTools };
