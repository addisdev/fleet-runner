/**
 * GET /api/evals and /api/evals/:input_sha — evals as a query, not a document.
 *
 * The plant-ID eval was assembled by hand: numbers copied out of result rows
 * into a Markdown table, because the rows themselves put top-1 accuracy in
 * `decode_tok_s` and p50 latency in `ttft_ms`, and top-5 and p95 had nowhere to
 * live at all. No query reproduces that report, which is the whole reason it had
 * to be typed. The named metric fields now exist (schemas/result.schema.json),
 * so the next eval should need no hand-written report — this endpoint is the
 * thing that makes that true.
 *
 * The shape is: an EVAL SET is one `params.input_sha256` — the exact bytes every
 * device scored. Within a set, results group by MODEL and pivot across DEVICES,
 * because "which model, on which hardware" is the question an eval is asked to
 * answer and every other arrangement makes you transpose it yourself.
 *
 * ## Excluded rows are reported, never dropped
 *
 * A row that carries no named metric for its family cannot be pivoted: there is
 * nothing to put in the cell. The tempting move is to filter it out, and that
 * would repeat the exact mistake this page exists to correct — the plant-ID rows
 * would vanish from a page whose reason for existing is that they could not be
 * queried. So every excluded row is counted, attributed, and listed with the
 * metric keys it does carry, and the page says so above the table.
 */
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { energyForJob, isEnergy, loadPowerConfig, meteredPools, type PowerConfig, type PowerMethod } from "../power.js";
import { iso, isSimulator, parse } from "./shared.js";

/** The workloads that score a shared input. Everything else is not an eval. */
export const EVAL_WORKLOADS = ["batch", "speech-eval", "embed-eval"] as const;

/** Same list src/api/results.ts uses to tell a vision batch from an LLM batch. */
const VISION_BACKENDS = new Set(["litert", "coreml", "tflite", "vision"]);

export type Family = "vision" | "llm" | "speech" | "embed";

export function familyOf(workload: string, backend: string | null | undefined): Family {
  if (workload === "speech-eval") return "speech";
  if (workload === "embed-eval") return "embed";
  return VISION_BACKENDS.has(String(backend ?? "")) ? "vision" : "llm";
}

/**
 * What "has named metrics" means, per family. A row carrying at least one of
 * these is pivotable; a row carrying none is excluded and said so.
 *
 * `llm` is the awkward case and deliberately so: `decode_tok_s` IS the named
 * field for an LLM batch, and is the *misused* field for a vision batch. Which
 * one a row is depends on the job's backend, not on the row — so the family is
 * decided from the spec before the metrics are read.
 */
export const NAMED_METRICS: Record<Family, readonly string[]> = {
  vision: ["top1_pct", "top5_pct", "p50_ms", "p95_ms", "images_per_s"],
  llm: ["prefill_tok_s", "decode_tok_s", "ttft_ms"],
  speech: ["wer_pct", "rtf", "clips"],
  embed: ["recall_at_1", "recall_at_5", "recall_at_10", "docs_per_s", "dim"],
};

/** The headline number per family — what the bars chart and what sorts a table. */
export const HEADLINE: Record<Family, { key: string; label: string; unit: string; higherIsBetter: boolean }> = {
  vision: { key: "top1_pct", label: "Top-1", unit: "%", higherIsBetter: true },
  llm: { key: "decode_tok_s", label: "Decode", unit: "tok/s", higherIsBetter: true },
  speech: { key: "wer_pct", label: "WER", unit: "%", higherIsBetter: false },
  embed: { key: "recall_at_1", label: "Recall@1", unit: "", higherIsBetter: true },
};

// --- energy per unit of work ---------------------------------------------

export type PerJoule = { value: number; unit: string; basis: string };

/**
 * Work done per joule, or null.
 *
 * Only DIRECT counts are used. Deriving a count by multiplying a rate by the
 * job's wall duration would multiply two uncertainties and produce a number that
 * looks measured, so a family with no stored count gets no column rather than a
 * plausible one. `omit it cleanly where it does not [exist]` means omit, not
 * approximate.
 */
export function perJoule(
  family: Family,
  metrics: Record<string, unknown>,
  params: Record<string, unknown>,
  energyWh: number | null,
): PerJoule | null {
  if (energyWh === null || !Number.isFinite(energyWh) || energyWh <= 0) return null;
  const joules = energyWh * 3600;

  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  let count: number | null = null;
  let unit = "";
  let basis = "";
  if (family === "llm") {
    count = n(params.gen_tokens);
    unit = "tok/J";
    basis = "params.gen_tokens";
  } else if (family === "vision") {
    count = n(params.images) ?? n(params.image_count) ?? n(params.count);
    unit = "img/J";
    basis = "params.images";
  } else if (family === "speech") {
    count = n(metrics.clips);
    unit = "clips/J";
    basis = "metrics.clips";
  } else {
    count = n(params.docs) ?? n(params.doc_count);
    unit = "docs/J";
    basis = "params.docs";
  }
  if (count === null) return null;
  return { value: count / joules, unit, basis };
}

// --- the pivot (pure) -----------------------------------------------------

export type EnergyView = {
  wh: number;
  method: PowerMethod | "os";
  /** true = the plug also saw the battery charging; null = no beacon covered it. */
  includes_charging: boolean | null;
  /** "result" when the runner stored it, "integrated" when this collector computed it. */
  source: "result" | "integrated";
  baseline_source: string | null;
  note: string | null;
};

export type EvalRow = {
  job_id: string;
  device_id: string;
  device_model: string | null;
  simulator: boolean;
  at: string | null;
  input_sha256: string | null;
  workload: string;
  backend: string | null;
  model: string | null;
  quant: string | null;
  accel: string | null;
  metrics: Record<string, any>;
  params: Record<string, any>;
  energy: EnergyView | null;
};

export type Cell = {
  job_id: string;
  device_id: string;
  device_model: string | null;
  simulator: boolean;
  at: string | null;
  metrics: Record<string, number | null>;
  energy: EnergyView | null;
  per_joule: PerJoule | null;
};

export type ModelRow = {
  key: string;
  model: string | null;
  quant: string | null;
  backend: string | null;
  accel: string | null;
  cells: Record<string, Cell>;
};

export type Excluded = {
  job_id: string;
  device_id: string;
  at: string | null;
  workload: string;
  backend: string | null;
  input_sha256: string | null;
  reason: string;
  /** The metric keys the row does carry, so the exclusion is checkable. */
  present: string[];
};

export type EvalSet = {
  input_sha256: string;
  family: Family;
  headline: (typeof HEADLINE)[Family];
  named_metrics: readonly string[];
  workloads: string[];
  /** Column order for the pivot. */
  devices: { device_id: string; device_model: string | null; simulator: boolean }[];
  models: ModelRow[];
  runs: number;
  latest_at: string | null;
  excluded: number;
  has_energy: boolean;
};

export type Pivot = { sets: EvalSet[]; excluded: Excluded[] };

const modelKey = (r: EvalRow) => `${r.model ?? "?"}|${r.quant ?? ""}|${r.backend ?? "?"}|${r.accel ?? ""}`;

/**
 * Group rows into eval sets, pivot each by model × device.
 *
 * Pure and exported so the arithmetic has a test that needs neither a database
 * nor hardware. Newer rows win per (set, model, device): an eval re-run on one
 * device replaces that cell and leaves the rest of the table alone, which is how
 * you actually add a candidate.
 */
export function pivotEvals(rows: EvalRow[]): Pivot {
  const excluded: Excluded[] = [];
  const bySet = new Map<string, EvalRow[]>();

  for (const r of rows) {
    const family = familyOf(r.workload, r.backend);
    const present = Object.keys(r.metrics ?? {}).filter((k) => r.metrics[k] !== null && r.metrics[k] !== undefined);
    if (!r.input_sha256) {
      excluded.push({
        job_id: r.job_id, device_id: r.device_id, at: r.at, workload: r.workload, backend: r.backend,
        input_sha256: null,
        reason: "no params.input_sha256 — nothing says which eval set this scored, so it cannot be compared to anything",
        present,
      });
      continue;
    }
    const named = NAMED_METRICS[family].filter((k) => typeof r.metrics?.[k] === "number");
    if (named.length === 0) {
      excluded.push({
        job_id: r.job_id, device_id: r.device_id, at: r.at, workload: r.workload, backend: r.backend,
        input_sha256: r.input_sha256,
        reason: `no named ${family} metric (expected one of ${NAMED_METRICS[family].join(", ")}) — this row predates the schema fields and its numbers live in slots that mean something else`,
        present,
      });
      continue;
    }
    const list = bySet.get(r.input_sha256) ?? [];
    list.push(r);
    bySet.set(r.input_sha256, list);
  }

  const sets: EvalSet[] = [];
  for (const [input_sha256, list] of bySet) {
    const family = familyOf(list[0].workload, list[0].backend);
    const keys = NAMED_METRICS[family];

    const models = new Map<string, ModelRow>();
    const devices = new Map<string, { device_id: string; device_model: string | null; simulator: boolean }>();
    for (const r of list) {
      devices.set(r.device_id, { device_id: r.device_id, device_model: r.device_model, simulator: r.simulator });
      const key = modelKey(r);
      const row =
        models.get(key) ??
        ({ key, model: r.model, quant: r.quant, backend: r.backend, accel: r.accel, cells: {} } as ModelRow);
      const prior = row.cells[r.device_id];
      // Newest wins. A null `at` is treated as oldest so an undated row never
      // displaces a dated one.
      const t = r.at ? Date.parse(r.at) : -Infinity;
      const priorT = prior?.at ? Date.parse(prior.at) : prior ? -Infinity : -Infinity;
      if (!prior || t >= priorT) {
        const metrics: Record<string, number | null> = {};
        for (const k of keys) metrics[k] = typeof r.metrics?.[k] === "number" ? r.metrics[k] : null;
        row.cells[r.device_id] = {
          job_id: r.job_id,
          device_id: r.device_id,
          device_model: r.device_model,
          simulator: r.simulator,
          at: r.at,
          metrics,
          energy: r.energy,
          per_joule: perJoule(family, r.metrics ?? {}, r.params ?? {}, r.energy?.wh ?? null),
        };
      }
      models.set(key, row);
    }

    const times = list.map((r) => (r.at ? Date.parse(r.at) : 0));
    sets.push({
      input_sha256,
      family,
      headline: HEADLINE[family],
      named_metrics: keys,
      workloads: [...new Set(list.map((r) => r.workload))].sort(),
      devices: [...devices.values()].sort((a, b) => a.device_id.localeCompare(b.device_id)),
      models: [...models.values()].sort((a, b) => (a.model ?? "").localeCompare(b.model ?? "") || a.key.localeCompare(b.key)),
      runs: list.length,
      latest_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
      excluded: excluded.filter((e) => e.input_sha256 === input_sha256).length,
      has_energy: list.some((r) => r.energy !== null),
    });
  }

  sets.sort((a, b) => (b.latest_at ?? "").localeCompare(a.latest_at ?? ""));
  return { sets, excluded };
}

// --- database → EvalRow ---------------------------------------------------

type DbRow = { job_id: string; device_id: string; payload: string; created_at: string; workload: string; spec: string };

function evalRows(inputSha: string | null, limit: number): EvalRow[] {
  const rows = db
    .prepare(
      `SELECT r.job_id, r.device_id, r.payload, r.created_at, j.workload, j.spec
         FROM results r JOIN jobs j ON j.job_id = r.job_id
        WHERE j.workload IN (${EVAL_WORKLOADS.map(() => "?").join(",")})
          AND json_extract(r.payload, '$.final') = 1
        ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(...EVAL_WORKLOADS, limit) as DbRow[];

  const descriptors = new Map(
    (db.prepare("SELECT device_id, descriptor FROM devices").all() as { device_id: string; descriptor: string }[]).map(
      (d) => [d.device_id, parse<Record<string, unknown>>(d.descriptor, {})],
    ),
  );

  // power.json once per request, not once per row.
  const powerCfg: PowerConfig | null = loadPowerConfig();
  const metered = meteredPools(powerCfg).length > 0;

  const out: EvalRow[] = [];
  for (const r of rows) {
    const spec = parse<Record<string, any>>(r.spec, {});
    const payload = parse<Record<string, any>>(r.payload, {});
    const params = (spec.params ?? {}) as Record<string, any>;
    const sha = typeof params.input_sha256 === "string" && params.input_sha256 ? params.input_sha256 : null;
    if (inputSha && sha !== inputSha) continue;

    const metrics = (payload.metrics ?? {}) as Record<string, any>;
    const descriptor = descriptors.get(r.device_id) ?? {};

    // A stored energy_wh is the runner's own measurement and always wins: it
    // may come from a machine that reports its own power (`os`), which the plug
    // knows nothing about. Only when nothing was stored does the collector
    // integrate the pool's samples itself.
    let energy: EnergyView | null = null;
    if (typeof metrics.energy_wh === "number" && Number.isFinite(metrics.energy_wh)) {
      const m = metrics.energy_method;
      energy = {
        wh: metrics.energy_wh,
        method: m === "plug" || m === "plug-shared" || m === "os" ? m : "os",
        includes_charging: null,
        source: "result",
        baseline_source: null,
        note:
          m === "plug-shared"
            ? "Recorded by the runner. Several devices share this plug: the figure is the pool's and must not be divided per device."
            : "Recorded by the runner.",
      };
    } else if (metered) {
      const e = energyForJob(r.job_id, r.device_id, powerCfg);
      if (isEnergy(e))
        energy = {
          wh: e.energy_wh,
          method: e.energy_method,
          includes_charging: e.includes_charging,
          source: "integrated",
          baseline_source: e.baseline_source,
          note: e.note,
        };
    }

    out.push({
      job_id: r.job_id,
      device_id: r.device_id,
      device_model: (descriptor.model as string) ?? null,
      simulator: isSimulator(descriptor, r.device_id),
      at: iso(r.created_at),
      input_sha256: sha,
      workload: r.workload,
      backend: spec.backend ?? null,
      model: spec.model?.name ?? null,
      quant: spec.model?.quant ?? null,
      accel: params.accelerator ?? params.delegate ?? null,
      metrics,
      params,
      energy,
    });
  }
  return out;
}

export function registerEvals(app: FastifyInstance) {
  app.get("/api/evals", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(2000, Math.max(50, Number(q.limit ?? 800) || 800));
    const { sets, excluded } = pivotEvals(evalRows(null, limit));

    return {
      // Summaries only; a set's table comes from /api/evals/:input_sha.
      sets: sets.map((s) => ({
        input_sha256: s.input_sha256,
        family: s.family,
        workloads: s.workloads,
        models: s.models.length,
        devices: s.devices.length,
        runs: s.runs,
        latest_at: s.latest_at,
        excluded: s.excluded,
        has_energy: s.has_energy,
      })),
      excluded: {
        count: excluded.length,
        // Grouped so the page can say "8 rows from 2 jobs", not list 8 lines.
        by_reason: Object.entries(
          excluded.reduce<Record<string, number>>((acc, e) => {
            const k = e.input_sha256 === null ? "no eval set" : `no named metrics (${e.workload})`;
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {}),
        ).map(([reason, count]) => ({ reason, count })),
        rows: excluded.slice(0, 200),
      },
      // So a page with no sets can tell "nothing ran" from "everything ran but
      // nothing was queryable" — two very different states.
      scanned: limit,
      energy_configured: meteredPools().length > 0,
    };
  });

  app.get("/api/evals/:input_sha", async (req) => {
    const { input_sha } = req.params as { input_sha: string };
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(2000, Math.max(50, Number(q.limit ?? 800) || 800));
    const { sets, excluded } = pivotEvals(evalRows(input_sha, limit));
    return {
      set: sets[0] ?? null,
      excluded,
      energy_configured: meteredPools().length > 0,
    };
  });
}
