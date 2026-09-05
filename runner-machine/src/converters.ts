/**
 * What "convert this checkpoint" means, per output format — decided from the
 * job's params, not guessed from the file.
 *
 * The same shape as `buildkinds.ts`: a pure planner that turns a requested
 * output into a list of commands, so the dispatch and every refusal are
 * testable on a machine with none of the three toolchains installed — which is
 * exactly the machine where the refusals matter, since a machine that HAS
 * coremltools will never exercise the "coremltools is not installed" path.
 *
 * The refusals are the interesting half. A conversion that quietly produces
 * the wrong thing is worse than one that will not start: an unquantised GGUF
 * uploaded under a `Q4_K_M` name is four times the size the schedule budgeted
 * for and silently changes what every dependent benchmark measured.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { which, run } from "./probe.js";

export const CONVERT_FORMATS = ["gguf", "coreml", "tflite"] as const;
export type ConvertFormat = (typeof CONVERT_FORMATS)[number];

export function isConvertFormat(v: unknown): v is ConvertFormat {
  return typeof v === "string" && (CONVERT_FORMATS as readonly string[]).includes(v);
}

/**
 * A quant name reaches a command line, so it is constrained to the alphabet
 * llama-quantize actually uses. `execFile` means there is no shell to inject
 * into, but an argument like `--help` arriving where a type name belongs would
 * still produce a "successful" run that converted nothing.
 */
export const QUANT_RE = /^[A-Za-z0-9_]{1,20}$/;

export type OutputSpec = { format: ConvertFormat; quant: string | null };

/**
 * `params.outputs` as the job wrote it.
 *
 * Throws with the reason rather than skipping a malformed entry: a job that
 * asked for three formats and got two, silently, is a job whose result row
 * lies about what the fleet has.
 */
export function parseOutputs(v: unknown): OutputSpec[] {
  if (!Array.isArray(v) || v.length === 0) {
    return errorOut("model-convert needs params.outputs: a non-empty array of { format, quant }");
  }
  const specs: OutputSpec[] = [];
  for (const [i, entry] of v.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return errorOut(`params.outputs[${i}] is not an object`);
    }
    const { format, quant } = entry as { format?: unknown; quant?: unknown };
    if (!isConvertFormat(format)) {
      return errorOut(
        `params.outputs[${i}].format must be one of ${CONVERT_FORMATS.join(", ")} (got ${JSON.stringify(format)})`,
      );
    }
    let q: string | null = null;
    if (quant !== undefined && quant !== null && quant !== "") {
      if (typeof quant !== "string" || !QUANT_RE.test(quant)) {
        return errorOut(`params.outputs[${i}].quant is not a quantisation name: ${JSON.stringify(quant)}`);
      }
      q = quant;
    }
    // Two entries asking for the same format and quant would race for one
    // output filename and upload whichever finished last, twice.
    if (specs.some((s) => s.format === format && s.quant === q)) {
      return errorOut(`params.outputs asks for ${format}/${q ?? "none"} twice`);
    }
    specs.push({ format, quant: q });
  }
  return specs;
}

const errorOut = (msg: string): never => {
  throw new Error(msg);
};

/**
 * Where the source checkpoint comes from.
 *
 * Two forms and no third: a 64-hex artifact sha, which the collector can hand
 * over and whose content is verified on the way in, or a HuggingFace repo id.
 * Anything else — a URL, a local path — is refused, because a `source` that is
 * a path would let an unauthenticated `POST /jobs` name a file on this machine
 * and have its bytes uploaded to the artifact store.
 */
export const HF_REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export type Source =
  | { kind: "artifact"; sha256: string }
  | { kind: "hf"; repo: string };

export function parseSource(v: unknown): Source {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error("model-convert needs params.source: an artifact sha256 or a HuggingFace repo id");
  }
  const s = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { kind: "artifact", sha256: s.toLowerCase() };
  if (HF_REPO_RE.test(s) && !s.includes("..")) return { kind: "hf", repo: s };
  throw new Error(`params.source is neither an artifact sha256 nor a HuggingFace repo id: ${s.slice(0, 80)}`);
}

/**
 * The toolchains, as resolved on this machine. Every field is a path or null,
 * and null is what every refusal below reads.
 */
export type ConverterTools = {
  /** llama.cpp's convert_hf_to_gguf.py. */
  ggufConvert: string | null;
  /** llama-quantize, needed only for a gguf output that names a quant. */
  ggufQuantize: string | null;
  /** The interpreter that runs convert_hf_to_gguf.py. */
  ggufPython: string | null;
  /** An interpreter for which `import coremltools` exits 0. */
  coremlPython: string | null;
  /** collector/evals/plant-id-assets/convert_coreml.py. */
  coremlConvert: string | null;
  /** xcrun, for `coremlcompiler compile`. */
  xcrun: string | null;
  /** An interpreter for which `import ai_edge_litert` exits 0. */
  tflitePython: string | null;
  /** collector/evals/plant-id-assets/quantize_int8.py. */
  tfliteQuantize: string | null;
};

export const NO_TOOLS: ConverterTools = {
  ggufConvert: null, ggufQuantize: null, ggufPython: null,
  coremlPython: null, coremlConvert: null, xcrun: null,
  tflitePython: null, tfliteQuantize: null,
};

/**
 * The formats this machine can actually produce.
 *
 * `llama-quantize` is deliberately NOT required for `convert:gguf`: an f16
 * GGUF is a complete conversion and needs only the script. A job asking for a
 * quantised one on a machine without the binary is refused by name at run
 * time, which is the honest split — the capability says "I can make GGUFs",
 * and the refusal says which quant it could not make.
 */
export function convertersAvailable(t: ConverterTools): ConvertFormat[] {
  const formats: ConvertFormat[] = [];
  if (t.ggufConvert && t.ggufPython) formats.push("gguf");
  if (t.coremlPython && t.coremlConvert && t.xcrun) formats.push("coreml");
  if (t.tflitePython && t.tfliteQuantize) formats.push("tflite");
  return formats;
}

export type Step = { cmd: string; args: string[]; cwd: string; label: string };
export type ConvertPlan = {
  format: ConvertFormat;
  quant: string | null;
  steps: Step[];
  /** The file to upload, relative to the plan's `cwd`. */
  product: string;
  /** The `format` a ModelRef would carry for this product. */
  modelFormat: "gguf" | "mlmodelc" | "tflite";
};

/**
 * The Core ML script's own output naming.
 *
 * `collector/evals/plant-id-assets/convert_coreml.py` writes
 * `PlantNet300K.mlpackage` and `PlantNet300K-int8.mlpackage` with the names
 * hard-coded. Reusing the script rather than rewriting it means inheriting
 * that, so the constant lives here where the plan can be read against it
 * instead of being a string buried in a command line.
 */
export const COREML_PRODUCT_BASE = "PlantNet300K";

export type PlanContext = {
  /** The source: a directory for gguf, a checkpoint file for coreml/tflite. */
  source: string;
  /** Where the products are written. Every step runs here. */
  outDir: string;
  /** The stem for produced filenames, from the job or the source. */
  name: string;
  /** tflite only: images to calibrate the quantiser on. */
  calibrationDir?: string | null;
};

/**
 * Turns one requested output into the commands that make it.
 *
 * Throws, with the missing toolchain named, rather than returning a plan that
 * will fail at spawn time — the caller turns the throw into a result row, and
 * "coremltools is not installed on machine-x" is an answer while
 * "ENOENT: python3" is a puzzle.
 */
export function planConvert(spec: OutputSpec, tools: ConverterTools, ctx: PlanContext): ConvertPlan {
  if (spec.format === "gguf") return planGguf(spec, tools, ctx);
  if (spec.format === "coreml") return planCoreml(spec, tools, ctx);
  return planTflite(spec, tools, ctx);
}

function planGguf(spec: OutputSpec, tools: ConverterTools, ctx: PlanContext): ConvertPlan {
  if (!tools.ggufConvert || !tools.ggufPython) {
    throw new Error(
      "gguf: llama.cpp's convert_hf_to_gguf.py does not resolve here (set FLEET_LLAMA_CPP to the checkout, or FLEET_CONVERT_HF_TO_GGUF to the script)",
    );
  }
  // f16 IS the converter's own output, so asking for it is one step, not two.
  const wantsQuant = spec.quant !== null && !/^f(16|32)$/i.test(spec.quant);
  const f16 = path.join(ctx.outDir, `${ctx.name}-f16.gguf`);
  const steps: Step[] = [
    {
      cmd: tools.ggufPython,
      args: [tools.ggufConvert, ctx.source, "--outfile", f16, "--outtype", "f16"],
      cwd: ctx.outDir,
      label: "convert_hf_to_gguf",
    },
  ];
  if (!wantsQuant) {
    return { format: "gguf", quant: spec.quant, steps, product: path.basename(f16), modelFormat: "gguf" };
  }
  if (!tools.ggufQuantize) {
    throw new Error(
      `gguf/${spec.quant}: llama-quantize does not resolve here, so only an f16 GGUF can be produced (set FLEET_LLAMA_QUANTIZE)`,
    );
  }
  const quantised = path.join(ctx.outDir, `${ctx.name}-${spec.quant!.toLowerCase()}.gguf`);
  steps.push({
    cmd: tools.ggufQuantize,
    args: [f16, quantised, spec.quant!],
    cwd: ctx.outDir,
    label: `llama-quantize ${spec.quant}`,
  });
  return { format: "gguf", quant: spec.quant, steps, product: path.basename(quantised), modelFormat: "gguf" };
}

function planCoreml(spec: OutputSpec, tools: ConverterTools, ctx: PlanContext): ConvertPlan {
  if (!tools.coremlPython || !tools.coremlConvert) {
    throw new Error(
      "coreml: no interpreter here imports coremltools (set FLEET_COREML_PYTHON to one, e.g. a 3.12 venv — coremltools' BlobWriter has no 3.14 wheel)",
    );
  }
  if (!tools.xcrun) {
    throw new Error("coreml: xcrun does not resolve, so `coremlcompiler compile` cannot run — an .mlpackage is not a loadable model");
  }
  // The script writes both variants every run; the quant selects which one is
  // compiled and published rather than which one is produced.
  const int8 = spec.quant !== null && /^int8$/i.test(spec.quant);
  if (spec.quant !== null && !int8 && !/^fp?16$/i.test(spec.quant)) {
    throw new Error(`coreml/${spec.quant}: convert_coreml.py produces fp16 weights and an int8 variant, nothing else`);
  }
  const base = int8 ? `${COREML_PRODUCT_BASE}-int8` : COREML_PRODUCT_BASE;
  return {
    format: "coreml",
    quant: spec.quant,
    modelFormat: "mlmodelc",
    product: `${base}.mlmodelc.zip`,
    steps: [
      { cmd: tools.coremlPython, args: [tools.coremlConvert, ctx.source], cwd: ctx.outDir, label: "convert_coreml.py" },
      { cmd: tools.xcrun, args: ["coremlcompiler", "compile", `${base}.mlpackage`, "."], cwd: ctx.outDir, label: "coremlcompiler compile" },
      // ditto rather than zip: an .mlmodelc is a bundle, and the symlinks and
      // permission bits a plain zip drops are the difference between a model
      // that loads on the phone and one that does not. Same call the build
      // workload makes for a .app.
      { cmd: "ditto", args: ["-c", "-k", "--sequesterRsrc", "--keepParent", `${base}.mlmodelc`, `${base}.mlmodelc.zip`], cwd: ctx.outDir, label: "ditto" },
    ],
  };
}

function planTflite(spec: OutputSpec, tools: ConverterTools, ctx: PlanContext): ConvertPlan {
  if (!tools.tflitePython || !tools.tfliteQuantize) {
    throw new Error(
      "tflite: no interpreter here imports ai_edge_litert (set FLEET_TFLITE_PYTHON to one — `pip install ai-edge-litert Pillow numpy`)",
    );
  }
  // The LiteRT path this repo owns is post-training quantisation of an
  // existing .tflite. Copying a float model to a new name and calling it a
  // conversion would publish an artifact whose only change is its filename.
  if (spec.quant === null || !/^int8$/i.test(spec.quant)) {
    throw new Error(
      `tflite/${spec.quant ?? "none"}: the LiteRT converter here is quantize_int8.py, so quant must be int8`,
    );
  }
  if (!ctx.calibrationDir) {
    throw new Error(
      "tflite/int8: needs params.calibration_sha256, a zip of ~100 calibration images DISJOINT from the eval set",
    );
  }
  const out = `${ctx.name}-int8.tflite`;
  return {
    format: "tflite",
    quant: spec.quant,
    modelFormat: "tflite",
    product: out,
    steps: [
      {
        cmd: tools.tflitePython,
        args: [tools.tfliteQuantize, ctx.source, ctx.calibrationDir, path.join(ctx.outDir, out)],
        cwd: ctx.outDir,
        label: "quantize_int8.py",
      },
    ],
  };
}

// --- probes -----------------------------------------------------------------

/**
 * Where the plant-ID conversion scripts are.
 *
 * They live in the collector's tree, which this agent does not import code
 * from — but a python script invoked by path is not an import, it is a tool,
 * and rewriting coremltools plumbing that already exists and is known to work
 * would be the worse call. `FLEET_EVAL_ASSETS` names the directory when the
 * two repos are not checked out side by side.
 */
export function evalAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLEET_EVAL_ASSETS) return env.FLEET_EVAL_ASSETS;
  // runner-machine/src/converters.ts -> ../../collector/evals/plant-id-assets.
  // fileURLToPath, not `.pathname`: this repo's own checkout sits under a
  // directory with a space in it, and the URL form spells that `%20`.
  return fileURLToPath(new URL("../../collector/evals/plant-id-assets", import.meta.url));
}

/** An interpreter for which `import <mod>` exits 0, or null. */
export async function pythonThatImports(
  mod: string,
  candidates: (string | undefined)[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = await which(candidate, env);
    if (!resolved) continue;
    const r = await run(resolved, ["-c", `import ${mod}`], 60_000);
    if (r.code === 0) return resolved;
  }
  return null;
}

async function fileIfReadable(file: string | undefined | null): Promise<string | null> {
  if (!file) return null;
  try {
    await access(file);
    return file;
  } catch {
    return null;
  }
}

/** Asks the machine each question the planner will ask of the answers. */
export async function probeConverters(env: NodeJS.ProcessEnv = process.env): Promise<ConverterTools> {
  const assets = evalAssetsDir(env);
  const ggufScript =
    env.FLEET_CONVERT_HF_TO_GGUF ??
    (env.FLEET_LLAMA_CPP ? path.join(env.FLEET_LLAMA_CPP, "convert_hf_to_gguf.py") : undefined);

  const [ggufConvert, ggufQuantize, ggufPython, coremlPython, coremlConvert, xcrun, tflitePython, tfliteQuantize] =
    await Promise.all([
      fileIfReadable(ggufScript),
      which(env.FLEET_LLAMA_QUANTIZE ?? "llama-quantize", env),
      which(env.FLEET_PYTHON ?? "python3", env),
      pythonThatImports("coremltools", [env.FLEET_COREML_PYTHON, env.FLEET_PYTHON, "python3.12", "python3"], env),
      fileIfReadable(path.join(assets, "convert_coreml.py")),
      which("xcrun", env),
      pythonThatImports("ai_edge_litert", [env.FLEET_TFLITE_PYTHON, env.FLEET_PYTHON, "python3"], env),
      fileIfReadable(path.join(assets, "quantize_int8.py")),
    ]);

  return { ggufConvert, ggufQuantize, ggufPython, coremlPython, coremlConvert, xcrun, tflitePython, tfliteQuantize };
}
