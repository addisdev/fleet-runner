/**
 * Energy accounting: what the wall says a pool drew while a job ran.
 *
 * Nothing on the shelf reports its own power. A phone knows its battery
 * percentage and a Mac knows nothing useful about a USB-attached device, so the
 * only honest source of watts is the smart plug the pool is on. This module
 * polls that plug into `power_samples`, and integrates those samples across a
 * job's claim window into watt-hours.
 *
 * Three things this file refuses to guess, because guessing them is how an
 * energy number stops meaning anything:
 *
 *  1. **Whether the plug measures one device or several.** A pool whose plug
 *     feeds exactly one device gets `energy_method: "plug"`. A pool with several
 *     devices behind one plug gets `"plug-shared"`, and the watt-hours are the
 *     POOL's, not the device's. See the divide-by-device warning on
 *     `energyForJob` — that division is the obvious wrong thing to do.
 *     Which case a pool is in is DECLARED in power.json. There is no default:
 *     a pool that does not say gets no energy figure at all.
 *
 *  2. **What the vendor's JSON looks like.** Tasmota, Shelly and Kasa all
 *     expose a current-draw reading and all three put it somewhere different
 *     (and Kasa reports milliwatts). So the config carries a path expression
 *     and a scale factor rather than this file carrying three parsers.
 *
 *  3. **Whether the number is the device's consumption.** It is not. A phone on
 *     a plug is also charging, and the plug sees charger + phone + whatever else
 *     shares the outlet. See the CHARGING section below.
 *
 * ## CHARGING — the honest answer, stated once
 *
 * The chosen approach is: **subtract a per-pool idle baseline, and separately
 * flag when the window contained charging.** Both halves are needed, and
 * neither alone is honest:
 *
 *   • The baseline (`idle_watts` in power.json, measured with the pool plugged
 *     in and idle) removes the standing load — the charger brick's own
 *     quiescent draw, a powered hub, the USB switch. That is a real, constant
 *     offset and leaving it in would inflate every short job.
 *
 *   • The baseline does NOT remove battery charging current. A phone at 40%
 *     pulls several watts into its battery whether or not it is running a job,
 *     and no subtraction of an idle figure can separate that from the work. So
 *     every result carries `includes_charging`, derived from the beacons in the
 *     same window, and the dashboard says so in words next to the number.
 *
 * The figure this module reports is therefore: **watt-hours at the wall, above
 * the pool's idle baseline, over the job's claim window — including any battery
 * charging that happened during it.** It is not "the energy the model used".
 * Anyone quoting it as that is quoting it wrong, and the UI says so.
 */
import { readFileSync } from "node:fs";
import { POWER_CONFIG_PATH } from "./config.js";
import { db } from "./db.js";
import { effectivePools } from "./api/shared.js";
import { extractWatts, percentile, integrateWh, type PoolPower, type PowerConfig, type PowerMethod } from "./watts.js";

// Re-exported so callers have one import for the whole feature.
export * from "./watts.js";

// --- config ---------------------------------------------------------------

export function loadPowerConfig(): PowerConfig | null {
  try {
    return JSON.parse(readFileSync(POWER_CONFIG_PATH, "utf8")) as PowerConfig;
  } catch {
    return null;
  }
}

/** Pools that can actually be sampled: a read URL and somewhere to find watts in it. */
export function meteredPools(cfg = loadPowerConfig()): [string, PoolPower][] {
  return Object.entries(cfg?.pools ?? {}).filter(([, p]) => !!p.read_url && !!p.watts_path);
}

// --- the sampler ----------------------------------------------------------

type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

const insertSample = () => db.prepare("INSERT INTO power_samples (pool, watts) VALUES (?, ?)");

/** One read. Exported so a future /api/power/:pool/read can reuse it. */
export async function readPoolWatts(cfg: PoolPower, timeoutMs = 5_000): Promise<number | null> {
  if (!cfg.read_url || !cfg.watts_path) return null;
  const res = await fetch(cfg.read_url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`plug answered ${res.status}`);
  const body = (await res.json()) as unknown;
  return extractWatts(body, cfg.watts_path, cfg.watts_scale ?? 1);
}

/**
 * Poll every metered pool into `power_samples`. Returns a stop function.
 *
 * Wire it into server.ts once, at startup. The timers are unref'd, so a
 * collector with nothing else to do still exits.
 */
export function startPowerSampler(opts: { log?: Log } = {}): () => void {
  const log = opts.log;
  const pools = meteredPools();
  if (pools.length === 0) {
    log?.info({ config: POWER_CONFIG_PATH }, "power sampler idle — no pool declares read_url + watts_path");
    return () => {};
  }

  const stmt = insertSample();
  const timers: NodeJS.Timeout[] = [];
  // A plug on a flaky AP fails every tick. Logging each one buries the log, so
  // the first failure and every twentieth after it are reported, and the
  // recovery is reported too — otherwise nothing ever says it came back.
  const failures = new Map<string, number>();

  for (const [pool, cfg] of pools) {
    const everyMs = Math.max(5, Number(cfg.read_interval_s ?? 30)) * 1000;
    const tick = async () => {
      try {
        const watts = await readPoolWatts(cfg);
        if (watts === null) {
          const n = (failures.get(pool) ?? 0) + 1;
          failures.set(pool, n);
          if (n === 1 || n % 20 === 0)
            log?.warn({ pool, path: cfg.watts_path, misses: n }, "power read: watts_path found no number");
          return;
        }
        if ((failures.get(pool) ?? 0) > 0) log?.info({ pool }, "power read recovered");
        failures.set(pool, 0);
        stmt.run(pool, watts);
      } catch (e) {
        const n = (failures.get(pool) ?? 0) + 1;
        failures.set(pool, n);
        if (n === 1 || n % 20 === 0)
          log?.warn({ pool, err: (e as Error).message, failures: n }, "power read failed");
      }
    };
    void tick();
    const t = setInterval(() => void tick(), everyMs);
    t.unref?.();
    timers.push(t);
  }

  log?.info(
    { pools: pools.map(([p]) => p), config: POWER_CONFIG_PATH },
    "power sampler started",
  );
  return () => timers.forEach(clearInterval);
}

// --- retention ------------------------------------------------------------

/**
 * Same shape and same posture as the beacon/event retention on the System
 * screen: count first, delete only when asked. A 30 s sample is ~2,900 rows per
 * pool per day, so this table grows like beacon_samples does and needs the same
 * button — deleting measurements on a timer is a worse default than a person
 * pressing something.
 *
 * `/api/system/retention` in src/api/mutations.ts is where this belongs as a
 * `power_days` field; that file is not mine to edit, so it is exported here for
 * that endpoint to call.
 */
export function powerRetention(days: number, dryRun = true): { power_samples: number } {
  const n = (
    db
      .prepare("SELECT COUNT(*) AS n FROM power_samples WHERE ts <= datetime('now', ?)")
      .get(`-${days} days`) as { n: number }
  ).n;
  if (!dryRun) db.prepare("DELETE FROM power_samples WHERE ts <= datetime('now', ?)").run(`-${days} days`);
  return { power_samples: n };
}

// --- energy for one job ---------------------------------------------------

export type JobEnergy = {
  job_id: string;
  device_id: string | null;
  pool: string;
  energy_wh: number;
  /**
   * "plug"        — this plug feeds exactly one device, per power.json.
   * "plug-shared" — several devices sit behind this plug. `energy_wh` is the
   *                 POOL's draw for the window. DO NOT divide it by the number
   *                 of devices to get a per-device figure: the devices are not
   *                 identical, they are not all busy, and the idle ones are
   *                 already inside the baseline. A per-device number that was
   *                 arrived at by division is fabricated, and it would be
   *                 indistinguishable in storage from a measured one.
   */
  energy_method: PowerMethod;
  from: string;
  to: string;
  window_s: number;
  covered_s: number;
  samples: number;
  gaps: number;
  baseline_w: number;
  baseline_source: "config" | "estimated-p10" | "none";
  /**
   * True when a device in this pool reported `charging` during the window, null
   * when no beacon covered it. When true, `energy_wh` includes energy that went
   * into a battery rather than into the work — the baseline cannot remove that.
   */
  includes_charging: boolean | null;
  /** One sentence a UI can print verbatim next to the number. */
  note: string;
};

export type EnergyRefusal = { job_id: string; energy_wh: null; reason: string };

const MS = (sqliteTs: string) => Date.parse(`${sqliteTs.replace(" ", "T")}Z`);

/**
 * Fallback baseline when power.json does not declare `idle_watts`: the 10th
 * percentile of the pool's samples over the day around the job.
 *
 * This is an estimate and is labelled as one everywhere it surfaces. It assumes
 * the shelf is idle most of the time, which is true of this fleet and may not be
 * true of yours. A measured `idle_watts` is always better; this exists so a
 * pool that has not been characterised still produces something with the right
 * sign, rather than silently reporting charger draw as work.
 */
export function baselineWatts(pool: string, aroundIso: string, cfg?: PoolPower): { w: number; source: JobEnergy["baseline_source"] } {
  if (typeof cfg?.idle_watts === "number" && Number.isFinite(cfg.idle_watts))
    return { w: cfg.idle_watts, source: "config" };
  const rows = db
    .prepare(
      `SELECT watts FROM power_samples
        WHERE pool = ? AND ts BETWEEN datetime(?, '-12 hours') AND datetime(?, '+12 hours')`,
    )
    .all(pool, aroundIso, aroundIso) as { watts: number }[];
  const p10 = percentile(rows.map((r) => r.watts), 0.1);
  return p10 === null ? { w: 0, source: "none" } : { w: p10, source: "estimated-p10" };
}

/**
 * Watt-hours for one job, integrated from its pool's plug across
 * [claimed_at, finished_at].
 *
 * Returns an `EnergyRefusal` naming what is missing rather than a zero or a
 * guess. Every refusal here is a configuration or coverage fact the operator can
 * act on, which is only true if it is stated.
 *
 * `config` is optional so a caller looping over many jobs reads power.json once
 * instead of once per row.
 */
export function energyForJob(jobId: string, deviceId?: string, config?: PowerConfig | null): JobEnergy | EnergyRefusal {
  const no = (reason: string): EnergyRefusal => ({ job_id: jobId, energy_wh: null, reason });

  const job = db
    .prepare("SELECT job_id, claimed_at, finished_at, claimed_by FROM jobs WHERE job_id = ?")
    .get(jobId) as { job_id: string; claimed_at: string | null; finished_at: string | null; claimed_by: string | null } | undefined;
  if (!job) return no("no such job");
  if (!job.claimed_at || !job.finished_at) return no("job has no claimed_at/finished_at window");

  // Which device ran it: the caller's answer, else the row that reported the
  // result, else claimed_by — which names a device for device-executor jobs and
  // a host executor for host ones.
  const device =
    deviceId ??
    (db.prepare("SELECT device_id FROM results WHERE job_id = ? LIMIT 1").get(jobId) as { device_id: string } | undefined)
      ?.device_id ??
    job.claimed_by;
  if (!device) return no("cannot tell which device ran this job");

  const row = db.prepare("SELECT pools, pools_override FROM devices WHERE device_id = ?").get(device) as
    | { pools: string; pools_override: string | null }
    | undefined;
  if (!row) return no(`device ${device} is not registered, so its pool is unknown`);

  const cfg = config ?? loadPowerConfig();
  if (!cfg) return no(`no power config at ${POWER_CONFIG_PATH}`);

  const candidates = effectivePools(row).filter((p) => {
    const pc = cfg.pools?.[p];
    return !!pc?.read_url && !!pc?.watts_path;
  });
  if (candidates.length === 0) return no(`no metered pool for device ${device}`);
  // Two metered plugs for one device is a wiring question, not something to
  // average: adding them would double-count a device on both, and picking one
  // silently would make the number depend on pool ordering.
  if (candidates.length > 1)
    return no(`device ${device} is in ${candidates.length} metered pools (${candidates.join(", ")}) — cannot attribute`);

  const pool = candidates[0];
  const pc = cfg.pools![pool];
  if (pc.energy_method !== "plug" && pc.energy_method !== "plug-shared")
    return no(
      `pool ${pool} does not declare energy_method — set "plug" (this plug feeds one device) or "plug-shared" (several devices behind it) in power.json`,
    );

  const fromMs = MS(job.claimed_at);
  const toMs = MS(job.finished_at);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return no("job window is empty or unparseable");

  const samples = (
    db
      .prepare("SELECT ts, watts FROM power_samples WHERE pool = ? AND ts BETWEEN ? AND ? ORDER BY ts")
      .all(pool, job.claimed_at, job.finished_at) as { ts: string; watts: number }[]
  ).map((s) => ({ t: MS(s.ts), w: s.watts }));

  const base = baselineWatts(pool, job.claimed_at, pc);
  const out = integrateWh(samples, fromMs, toMs, { baselineW: base.w });
  if (out.wh === null)
    return no(`only ${out.samples} power sample(s) inside the job window for pool ${pool}`);

  // Beacons decide the charging flag: the device is the only thing that knows.
  const charge = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN COALESCE(json_extract(sample,'$.beacon.charging'), json_extract(sample,'$.charging')) = 1
                       THEN 1 ELSE 0 END) AS charging
         FROM beacon_samples WHERE device_id = ? AND ts BETWEEN ? AND ?`,
    )
    .get(device, job.claimed_at, job.finished_at) as { n: number; charging: number | null };
  const includes_charging = charge.n === 0 ? null : (charge.charging ?? 0) > 0;

  const parts: string[] = [
    `Wall energy for pool "${pool}" over the job window, less a ${base.w.toFixed(2)} W idle baseline (${
      base.source === "config" ? "measured, from power.json" : base.source === "estimated-p10" ? "ESTIMATED from the pool's own samples, not measured" : "none available — the charger's own draw is still in this number"
    }).`,
  ];
  if (pc.energy_method === "plug-shared")
    parts.push("This plug feeds several devices: the figure is the whole pool's and must not be divided per device.");
  if (includes_charging === true)
    parts.push("The device was charging during this window, so the figure includes battery replenishment as well as the work.");
  else if (includes_charging === null)
    parts.push("No beacon covered this window, so whether the device was also charging is unknown.");
  if (out.gaps > 0) parts.push(`${out.gaps} sampling gap(s) were skipped rather than interpolated, so this is a floor.`);
  const coverage = out.window_ms > 0 ? out.covered_ms / out.window_ms : 0;
  if (coverage < 0.9)
    parts.push(`Samples cover only ${Math.round(coverage * 100)}% of the window.`);
  if (out.wh < 0)
    parts.push("Negative: the idle baseline is higher than the draw observed during the job, which means the baseline is wrong.");

  return {
    job_id: jobId,
    device_id: device,
    pool,
    energy_wh: out.wh,
    energy_method: pc.energy_method,
    from: `${job.claimed_at.replace(" ", "T")}Z`,
    to: `${job.finished_at.replace(" ", "T")}Z`,
    window_s: Math.round(out.window_ms / 1000),
    covered_s: Math.round(out.covered_ms / 1000),
    samples: out.samples,
    gaps: out.gaps,
    baseline_w: base.w,
    baseline_source: base.source,
    includes_charging,
    note: parts.join(" "),
  };
}

export const isEnergy = (e: JobEnergy | EnergyRefusal): e is JobEnergy => e.energy_wh !== null;
