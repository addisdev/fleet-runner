/**
 * The 60-second beacon.
 *
 * `battery_pct`, `charging` and `thermal` keep the phones' shape so the
 * dashboard's Battery and Thermal cells work on a laptop with no change. The
 * three that follow are what a machine adds: `on_ac`, `idle_s` and `load_1m`
 * are read by the collector's `constraintsSatisfied` for `require_ac`,
 * `require_idle_s` and `max_load` — a computer somebody is typing on is
 * temporarily unsuitable, not broken, and those constraints keep such a job
 * queued instead of failing it.
 *
 * Same rule as the descriptor: a probe that cannot answer reports null. The
 * collector fails those constraints closed, so a null costs a deferred claim,
 * never a wrong one.
 */
import os from "node:os";
import { statfs } from "node:fs/promises";
import { out, readText, orNull, firstMatch, finite, run } from "./probe.js";
import type { BeaconSample } from "./protocol.js";

export type Thermal = "nominal" | "fair" | "serious" | "critical";

export async function beacon(platform: NodeJS.Platform = process.platform): Promise<BeaconSample> {
  const power =
    platform === "darwin" ? await macPower()
    : platform === "linux" ? await linuxPower()
    : platform === "win32" ? await windowsPower()
    : {};

  return {
    battery_pct: power.battery_pct ?? null,
    charging: power.charging ?? null,
    thermal: await thermal(platform),
    on_ac: power.on_ac ?? null,
    idle_s: await idleSeconds(platform),
    load_1m: loadOneMinute(platform),
    disk_free_gb: await diskFreeGb(),
  };
}

// --- power ------------------------------------------------------------------

type Power = { battery_pct?: number | null; charging?: boolean | null; on_ac?: boolean | null };

async function macPower(): Promise<Power> {
  const text = await orNull(() => out("pmset", ["-g", "batt"]));
  return parsePmsetBatt(text);
}

/**
 * `pmset -g batt` prints the power source, then a line per battery:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=…)  94%; charging; 0:23 remaining present: true
 * A desktop prints only the first line, which is a true `on_ac` and an honest
 * null battery rather than a machine sitting at 0%.
 */
export function parsePmsetBatt(text: string | null): Power {
  if (!text) return {};
  const onAc = /drawing from '(AC|Wall)/i.test(text) ? true : /drawing from 'Battery/i.test(text) ? false : null;
  const pct = finite(firstMatch(text, /(\d+)%/));
  const state = firstMatch(text, /%;\s*([a-z ]+);/i);
  const charging = state === null ? (pct === null ? null : onAc) : /charging/i.test(state) && !/discharging/i.test(state);
  return { battery_pct: pct, charging, on_ac: onAc };
}

async function linuxPower(): Promise<Power> {
  // upower first: it knows which supply is the battery. The sysfs files are the
  // fallback for a machine without it, which is most servers and containers.
  const viaUpower = await orNull(async () => {
    const list = await out("upower", ["-e"]);
    const dev = list?.split("\n").map((s) => s.trim()).find((s) => /BAT|battery/i.test(s));
    if (!dev) return null;
    const info = await out("upower", ["-i", dev]);
    if (!info) return null;
    const pct = finite(firstMatch(info, /percentage:\s*([\d.]+)/));
    const state = firstMatch(info, /state:\s*(\S+)/);
    return {
      battery_pct: pct === null ? null : Math.round(pct),
      charging: state === null ? null : /charging|fully-charged/.test(state) && state !== "discharging",
      on_ac: state === null ? null : state !== "discharging",
    };
  });
  if (viaUpower) return viaUpower;

  const cap = finite((await readText("/sys/class/power_supply/BAT0/capacity"))?.trim());
  const status = (await readText("/sys/class/power_supply/BAT0/status"))?.trim() ?? null;
  const acOnline = await orNull(async () => {
    const r = await run("sh", ["-c", "cat /sys/class/power_supply/A{C,DP,C0,CAD}*/online 2>/dev/null | head -1"]);
    const v = r.stdout.trim();
    return v === "" ? null : v === "1";
  });
  // No battery and no AC file is a desktop or a VM: mains power, no battery.
  const noBattery = cap === null && status === null;
  return {
    battery_pct: cap,
    charging: status === null ? null : /Charging|Full/i.test(status),
    on_ac: acOnline ?? (noBattery ? true : status === null ? null : !/Discharging/i.test(status)),
  };
}

async function windowsPower(): Promise<Power> {
  const text = await orNull(() => out("wmic", ["path", "Win32_Battery", "get", "EstimatedChargeRemaining,BatteryStatus", "/value"], 15000));
  if (!text) return {};
  const pct = finite(firstMatch(text, /EstimatedChargeRemaining=(\d+)/i));
  // Win32_Battery.BatteryStatus: 1 is discharging, 2 is on AC, 6-9 are the
  // charging states. Anything but 1 means the mains is connected.
  const status = finite(firstMatch(text, /BatteryStatus=(\d+)/i));
  return {
    battery_pct: pct,
    charging: status === null ? null : status >= 6 && status <= 9,
    on_ac: status === null ? null : status !== 1,
  };
}

// --- thermal ----------------------------------------------------------------

/**
 * The phones' four-state enum, mapped from what a computer will tell you.
 *
 * Neither mapping is the same measurement the phones make, and that is worth
 * knowing before comparing a laptop's "serious" to a phone's: macOS reports
 * how far the scheduler has throttled the CPU, Linux reports a temperature.
 * Both are mapped to the shared enum because the dashboard's Thermal cell and
 * the `thermal-critical` alert are built on it, and a laptop that has been
 * throttled to half speed mid-benchmark is exactly the thing those exist to
 * surface. The thresholds are here, in one place, rather than implied.
 */
export async function thermal(platform: NodeJS.Platform = process.platform): Promise<Thermal | null> {
  if (platform === "darwin") {
    const t = await orNull(() => out("pmset", ["-g", "therm"]));
    const limit = finite(firstMatch(t, /CPU_Speed_Limit\s*=\s*(\d+)/));
    if (limit !== null) return speedLimitToThermal(limit);
    // pmset prints a speed limit only once something has been recorded, so an
    // Apple silicon Mac that has never been throttled says so in words. That
    // is a reading, not a missing probe: taking it as null would leave the
    // Thermal cell permanently empty for most of the Macs on a shelf.
    return t !== null && /No thermal warning level has been recorded/i.test(t) ? "nominal" : null;
  }
  if (platform === "linux") {
    const c = await orNull(async () => {
      const r = await run("sh", ["-c", "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null"]);
      const temps = r.stdout.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (temps.length === 0) return null;
      // Millidegrees on every kernel that exposes this; a bare degree reading
      // would be under 1000 and is passed through unchanged.
      const max = Math.max(...temps);
      return max > 1000 ? max / 1000 : max;
    });
    return c === null ? null : celsiusToThermal(c);
  }
  return null;
}

/** macOS: 100 is unthrottled; the scheduler drops it as the machine heats. */
export function speedLimitToThermal(limit: number): Thermal {
  if (limit >= 100) return "nominal";
  if (limit >= 75) return "fair";
  if (limit >= 50) return "serious";
  return "critical";
}

/** Linux: the hottest thermal zone, in °C. */
export function celsiusToThermal(c: number): Thermal {
  if (c < 70) return "nominal";
  if (c < 85) return "fair";
  if (c < 95) return "serious";
  return "critical";
}

// --- idle, load, disk -------------------------------------------------------

/**
 * Seconds since the last human input.
 *
 * macOS keeps it in the HID system and `ioreg` prints it in nanoseconds. Linux
 * has no equivalent without a display server, so `xprintidle` is used when it
 * is installed and the answer is null otherwise.
 *
 * `/proc/uptime`'s second field is deliberately NOT used here: it is cumulative
 * idle CPU-seconds summed over every core, so an idle 16-core box reports about
 * sixteen seconds of "idle" per second of wall time. Feeding that to
 * `require_idle_s` would make every machine look permanently untouched, which
 * is the opposite of what the constraint is for.
 */
export async function idleSeconds(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform === "darwin") {
    const text = await orNull(() => out("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r"]));
    const ns = finite(firstMatch(text, /"HIDIdleTime"\s*=\s*(\d+)/));
    return ns === null ? null : Math.round(ns / 1e9);
  }
  if (platform === "linux") {
    const ms = finite(await orNull(() => out("xprintidle", [])));
    return ms === null ? null : Math.round(ms / 1000);
  }
  return null;
}

/** Windows' loadavg is always [0,0,0]; reporting it would be a fabricated zero. */
export function loadOneMinute(platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "win32") return null;
  const v = os.loadavg()[0];
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

async function diskFreeGb(): Promise<number | null> {
  return orNull(async () => {
    const s = await statfs(process.platform === "win32" ? process.cwd() : "/");
    const bytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(bytes) ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null;
  });
}

// --- memory -----------------------------------------------------------------

export type MemorySample = { mb: number; method: string };

/**
 * Peak memory for a process, labeled with how it was measured.
 *
 * The phones report `pss` (Android) and `phys_footprint` (iOS) and never
 * compare the two as if they were the same number. A machine can only offer
 * PSS on Linux, where smaps_rollup exposes it; macOS and Windows can offer
 * resident set size and nothing closer, so that is what they say — `max_rss`,
 * a third label rather than one of the phones' two.
 *
 * NOTE: `max_rss` is not in the `mem_method` enum in
 * collector/schemas/result.schema.json, which lists only
 * `phys_footprint` and `pss`. Calling an RSS reading either of those would be
 * exactly the laundering that schema comment exists to forbid, so the honest
 * label is emitted and the collector's enum needs the third value added.
 */
export async function memorySample(pid: number = process.pid): Promise<MemorySample | null> {
  if (process.platform === "linux") {
    const pss = finite(firstMatch(await readText(`/proc/${pid}/smaps_rollup`), /^Pss:\s*(\d+)\s*kB/m));
    if (pss !== null) return { mb: Math.round(pss / 1024), method: "pss" };
    const hwm = finite(firstMatch(await readText(`/proc/${pid}/status`), /^VmHWM:\s*(\d+)\s*kB/m));
    if (hwm !== null) return { mb: Math.round(hwm / 1024), method: "max_rss" };
    return null;
  }
  if (pid === process.pid) {
    const rss = process.memoryUsage().rss;
    return Number.isFinite(rss) ? { mb: Math.round(rss / (1024 * 1024)), method: "max_rss" } : null;
  }
  const kb = finite(await orNull(() => out("ps", ["-o", "rss=", "-p", String(pid)])));
  return kb === null ? null : { mb: Math.round(kb / 1024), method: "max_rss" };
}
