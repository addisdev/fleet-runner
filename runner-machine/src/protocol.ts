/**
 * TypeScript mirror of the collector's schemas/{job,result}.schema.json
 * ("schema": 1).
 *
 * Shared protocol, not shared code. The collector's own `src/fleet-client.ts`
 * has the same primitives and this file deliberately does not import it: the
 * Android and iOS runners each re-implement the protocol too, and a fourth
 * agent that reached into the collector's source would be the only one that
 * could not be moved, packaged or versioned on its own.
 */

export const SCHEMA = 1;

export type ModelRef = {
  name: string;
  format: "gguf" | "mlmodelc" | "tflite";
  quant?: string;
  sha256: string;
};

export type JobSpec = {
  schema: number;
  job_id: string;
  workload: string;
  executor: "device" | "host";
  model?: ModelRef;
  backend?: string;
  params?: Record<string, unknown>;
  targets?: Record<string, unknown>;
  constraints?: {
    require_charging?: boolean;
    min_battery_pct?: number;
    [k: string]: unknown;
  };
  lease?: { ttl_s?: number; max_attempts?: number };
};

/**
 * The descriptor a machine registers with.
 *
 * The first five fields are the ones `targets.match` expressions already read
 * (see collector/src/match.ts), so an expression written for the phones
 * — `ram_mb >= 8000`, `os ~ 'macos'` — keeps working against a laptop without
 * being rewritten. The rest are new, and describe the things that are only
 * true of a computer.
 *
 * Every field is nullable on purpose. A probe that cannot answer reports null;
 * it never throws and never guesses, because a guessed `soc` is worse than an
 * absent one when the whole point of the field is comparing hardware.
 */
export type Descriptor = {
  model: string | null;
  soc: string | null;
  ram_mb: number | null;
  os: string | null;
  app_ver: string;

  kind: "laptop" | "desktop" | null;
  arch: string | null;
  gpu: string | null;
  vram_mb: number | null;
  cpu_cores: number | null;
};

/**
 * The beacon sample.
 *
 * `battery_pct`, `charging` and `thermal` are exactly the shape the phones
 * send, so the dashboard's existing Battery and Thermal cells render a laptop
 * without a change. `on_ac`, `idle_s` and `load_1m` are the fields the
 * collector's `constraintsSatisfied` reads for `require_ac`, `require_idle_s`
 * and `max_load` — the constraints that exist because a machine someone is
 * typing on is temporarily unsuitable rather than broken.
 */
export type BeaconSample = {
  battery_pct: number | null;
  charging: boolean | null;
  thermal: "nominal" | "fair" | "serious" | "critical" | null;
  on_ac: boolean | null;
  idle_s: number | null;
  load_1m: number | null;
  disk_free_gb: number | null;
};

/**
 * Metrics. Only names that appear in collector/schemas/metrics.json —
 * the generated list is the contract, and inventing a name here is how the
 * plant-ID eval's accuracy ended up living in `decode_tok_s`.
 */
export type Metrics = {
  load_ms?: number;
  prefill_tok_s?: number;
  decode_tok_s?: number;
  ttft_ms?: number;
  peak_mem_mb?: number;
  mem_method?: string;
  thermal?: string[];
  battery_start_pct?: number;
  battery_end_pct?: number;

  /** build: wall-clock seconds for the build itself, excluding checkout and upload. */
  build_s?: number;
  /** build: size of the produced app or package. */
  artifact_bytes?: number;

  /** self-check: free space on this machine's data volume. */
  disk_free_gb?: number;
  /** self-check: offset against NTP, positive when this machine is behind. */
  clock_offset_ms?: number;
  /** self-check: how many checks failed, so the alert rule needs no parsing. */
  checks_failed?: number;
};

/**
 * One self-check finding.
 *
 * `ok` is deliberately three-valued. `false` is a failure and counts toward
 * `checks_failed`; `null` is a check that could not run — the tool is not
 * installed, the network is down — which is information, not a fault, and
 * counting it would make every Linux box permanently red for not having Xcode.
 */
export type CheckRow = {
  name: string;
  ok: boolean | null;
  value?: string | number;
  detail?: string;
};

/** build: what a successful build produced, so the row is traceable to a commit. */
export type BuildRow = {
  app: string;
  build: string;
  sha256: string;
  commit: string;
  ref: string;
  repo: string;
  kind: string;
};

export type ResultPost = {
  schema: number;
  kind: "result" | "beacon";
  job_id?: string;
  device_id: string;
  iter?: number;
  final?: boolean;
  ok?: boolean;
  device?: Descriptor;
  metrics?: Metrics;
  beacon?: BeaconSample;
  error?: string;
  artifacts?: string[];
  /**
   * self-check's per-check breakdown and build's provenance. Neither is in
   * collector/schemas/result.schema.json — the collector stores a result's
   * whole payload as JSON, so a named field survives and can be rendered
   * later, whereas folding either into `metrics` would mean inventing metric
   * names outside schemas/metrics.json.
   */
  checks?: CheckRow[];
  build?: BuildRow;
};

export type RegisterPost = {
  device_id: string;
  descriptor: Descriptor;
  pools: string[];
  capabilities: string[];
};

/** Reads an integer job param, falling back when it is absent or not a number. */
export function intParam(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Drops null/undefined so an unanswered probe stays off the wire entirely. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}
