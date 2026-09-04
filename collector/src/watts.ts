/**
 * Reading watts out of a smart plug, and integrating them into watt-hours.
 *
 * Pure, and its own module for the reason src/match.ts and src/am-start.ts are:
 * everything here decides what number gets stored, and anything only reachable
 * through src/power.ts is only testable with a database and a plug on the
 * network. src/power.ts owns the polling, the SQL and the per-job attribution;
 * this file owns the arithmetic and the vendor-shape parsing, and imports
 * nothing.
 *
 * See src/power.ts for what the resulting figure does and does not mean —
 * in particular the charging caveat, which is a property of the measurement,
 * not of this arithmetic.
 */

/** Matches `energy_method` in schemas/result.schema.json. */
export type PowerMethod = "plug" | "plug-shared";

export type PoolPower = {
  /** Existing on/off webhooks. Untouched by this module. */
  on?: string;
  off?: string;

  /** GET here to read the pool's current draw. Absent = pool is switchable but not metered. */
  read_url?: string;
  /**
   * Where the watts live in that response, as a path expression:
   *   Tasmota  (`/cm?cmnd=Status%2010`)  "StatusSNS.ENERGY.Power"
   *   Shelly 1 (`/status`)               "meters[0].power"
   *   Shelly 2 (`/rpc/Switch.GetStatus`) "[\"switch:0\"].apower"  (or switch:0.apower)
   *   Kasa     (bridge /emeter)          "emeter.get_realtime.power_mw" + watts_scale 0.001
   */
  watts_path?: string;
  /** Multiplier onto the extracted value. 0.001 for a plug that reports milliwatts. */
  watts_scale?: number;
  /** Seconds between reads for this pool. Default 30. */
  read_interval_s?: number;

  /**
   * REQUIRED for any energy figure. Declares whether this plug feeds one device
   * or the whole pool. Not inferred from how many devices are registered in the
   * pool — a pool can have three devices and three plugs, or one device today
   * and four tomorrow, and only the person who wired it knows.
   */
  energy_method?: PowerMethod;

  /**
   * Watts this pool draws plugged in and idle: chargers, hubs, the switch
   * itself. Subtracted from every integration. Measure it with the shelf quiet
   * and nothing claimed. Omit it and the collector falls back to a weak
   * estimate from the samples themselves (see `baselineWatts`) and says so.
   */
  idle_watts?: number;
};

export type PowerConfig = { pools?: Record<string, PoolPower> };

// --- the path expression (pure) -------------------------------------------

/**
 * "a.b[0].c" / `["switch:0"].apower` → ["a","b",0,"c"] / ["switch:0","apower"].
 *
 * Bracket-quoted segments exist for Shelly Gen2, whose keys contain a colon;
 * an unquoted `switch:0.apower` also works because only `.` and `[` split.
 */
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const close = path.indexOf("]", i);
      if (close < 0) throw new Error(`unterminated '[' in watts path: ${path}`);
      const seg = path.slice(i + 1, close).trim();
      const quoted =
        (seg.startsWith('"') && seg.endsWith('"')) || (seg.startsWith("'") && seg.endsWith("'"));
      if (quoted) out.push(seg.slice(1, -1));
      else if (/^\d+$/.test(seg)) out.push(Number(seg));
      else out.push(seg);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    const seg = path.slice(i, j).trim();
    if (seg) out.push(seg);
    i = j;
  }
  if (out.length === 0) throw new Error(`empty watts path: '${path}'`);
  return out;
}

/** Walk a parsed path. `undefined` for any miss — a wrong path is not an exception. */
export function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of parsePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/**
 * The watts at `path`, scaled. Null when the path misses or the value is not a
 * number — a plug that answered with an error object must produce no sample
 * rather than a zero, because a zero is a measurement and "the plug did not
 * answer" is not.
 *
 * Numeric strings are accepted: several firmwares quote their numbers.
 */
export function extractWatts(body: unknown, path: string, scale = 1): number | null {
  const raw = readPath(body, path);
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  const w = n * (Number.isFinite(scale) ? scale : 1);
  return Number.isFinite(w) ? w : null;
}

// --- integration (pure) ---------------------------------------------------

export type WattSample = { t: number; w: number };

export type Integration = {
  /** Watt-hours above the baseline. Null when fewer than two samples land in the window. */
  wh: number | null;
  /** Watt-hours before the baseline was subtracted, for anyone checking the arithmetic. */
  wh_raw: number | null;
  samples: number;
  /** Milliseconds of the window actually spanned by usable sample pairs. */
  covered_ms: number;
  window_ms: number;
  /** Pairs skipped for being further apart than `maxGapMs` — the plug was unreachable. */
  gaps: number;
};

/**
 * Trapezoidal integration of watts over [fromMs, toMs].
 *
 * Two deliberate refusals:
 *   • No extrapolation past the first or last sample inside the window. If the
 *     sampler started late, the uncovered head is reported as uncovered, not
 *     back-filled from the earliest reading.
 *   • No bridging a gap longer than `maxGapMs`. A plug offline for ten minutes
 *     interpolated across is a fabricated ten minutes of draw; the gap is
 *     counted and the segment is dropped, so `covered_ms` shrinks and the
 *     caller can see the figure is a floor.
 */
export function integrateWh(
  samples: WattSample[],
  fromMs: number,
  toMs: number,
  opts: { baselineW?: number; maxGapMs?: number } = {},
): Integration {
  const baselineW = opts.baselineW ?? 0;
  const maxGapMs = opts.maxGapMs ?? 5 * 60_000;
  const window_ms = Math.max(0, toMs - fromMs);

  const inWindow = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.w) && s.t >= fromMs && s.t <= toMs)
    .sort((a, b) => a.t - b.t);

  if (inWindow.length < 2)
    return { wh: null, wh_raw: null, samples: inWindow.length, covered_ms: 0, window_ms, gaps: 0 };

  let joulesRaw = 0;
  let joulesNet = 0;
  let covered_ms = 0;
  let gaps = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const a = inWindow[i - 1];
    const b = inWindow[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    if (dt > maxGapMs) {
      gaps++;
      continue;
    }
    const mean = (a.w + b.w) / 2;
    joulesRaw += mean * dt;
    joulesNet += (mean - baselineW) * dt;
    covered_ms += dt;
  }

  // watt·ms → Wh
  const toWh = (x: number) => x / 3_600_000;
  return {
    wh: covered_ms === 0 ? null : toWh(joulesNet),
    wh_raw: covered_ms === 0 ? null : toWh(joulesRaw),
    samples: inWindow.length,
    covered_ms,
    window_ms,
    gaps,
  };
}

/** Median, for the baseline estimate. Null on an empty list. */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** The value at `p` (0–1) of a sorted copy. Used for the fallback baseline. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))));
  return xs[idx];
}

