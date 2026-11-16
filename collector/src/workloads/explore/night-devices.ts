/**
 * Which night-QA emulators `scripts/explore-night.ts` booted, kept on disk so
 * that "shut down only what it booted" survives the night command dying.
 *
 * Until 2026-11-12 the command remembered what it booted in memory only. On
 * 11-02 at 23:33 the brain went away mid-night, a failed fetch crashed the
 * command before its `finally`, and `fleet-explore-1` (~7 GB) stayed up. Every
 * later night found it running, took it for someone else's ("not booted by
 * me") and left it up again: nine days and sixteen hours, by day, on a host
 * out of memory. Now:
 *
 *   - each boot is written down with the emulator's kernel boot id, so a
 *     record can never be mistaken for a different boot of the same AVD, or
 *     for an emulator another session started on the same serial;
 *   - a night that finds its own earlier boot still up with no live owner
 *     adopts it, and so shuts it down at its end;
 *   - `explore-night.ts --sweep` (launchd, at 06:00 and through the day)
 *     stops recorded emulators whose night is over: no owner process left and
 *     no brain job on the device. Nothing without a record is ever touched.
 *
 * The decisions are pure and live here so they can be tested without an
 * emulator.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BootRecord = {
  kind: "emulator";
  avd: string;
  serial: string;
  /** /proc/sys/kernel/random/boot_id inside the emulator: new on every boot. */
  boot_id: string;
  /** The explore-night process that booted (or adopted) it. */
  owner_pid: number;
  booted_at: string;
};

/** What runs on a record's serial now, or null when nothing does. */
export type Seen = { avd: string; boot_id: string } | null;

export type SweepAction = { action: "forget" | "keep" | "stop"; why: string };

/** Where the records live: outside ~/.fleet/bin, which install.sh replaces. */
export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_EXPLORE_STATE ?? path.join(env.HOME ?? os.homedir(), ".fleet", "explore-night", "booted.json");
}

export function readRecords(file: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): BootRecord[] {
  try {
    const v = JSON.parse(read(file)) as unknown;
    return Array.isArray(v)
      ? v.filter((r): r is BootRecord => !!r && typeof r === "object" && (r as BootRecord).kind === "emulator"
        && typeof (r as BootRecord).serial === "string" && typeof (r as BootRecord).boot_id === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeRecords(file: string, records: BootRecord[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The records with `rec` in place of any for the same serial. */
export function withRecord(records: BootRecord[], rec: BootRecord): BootRecord[] {
  return [...records.filter((r) => r.serial !== rec.serial), rec];
}

export function withoutSerial(records: BootRecord[], serial: string): BootRecord[] {
  return records.filter((r) => r.serial !== serial);
}

/** Whether `seen` is the very boot `rec` describes. */
export function sameBoot(rec: BootRecord, seen: Seen): boolean {
  return !!seen && seen.avd === rec.avd && !!rec.boot_id && seen.boot_id === rec.boot_id;
}

/**
 * At the start of a night, an emulator for the AVD is already up. It is this
 * night's to shut down only if an earlier night booted that very boot and the
 * night that booted it is gone; anything else (another session's emulator,
 * one started by hand, a night still running) is left as it is.
 */
export function adoptable(records: BootRecord[], serial: string, seen: Seen, ownerAlive: (pid: number) => boolean): BootRecord | null {
  const rec = records.find((r) => r.serial === serial);
  if (!rec || !sameBoot(rec, seen)) return null;
  return ownerAlive(rec.owner_pid) ? null : rec;
}

/**
 * What the morning sweep does with one record.
 *
 *   - gone, or the serial now runs another boot: forget the record, touch nothing;
 *   - its night is still running (the owner process is alive): keep; that
 *     night shuts it down itself when it ends;
 *   - a brain job is on it, or the brain cannot say: keep;
 *   - otherwise its night is over and nothing uses it: stop it.
 */
export function sweepAction(rec: BootRecord, seen: Seen, o: { ownerAlive: boolean; busy: string | null }): SweepAction {
  if (!seen) return { action: "forget", why: `${rec.avd} is no longer running on ${rec.serial}` };
  if (!sameBoot(rec, seen)) {
    return { action: "forget", why: `${rec.serial} now runs ${seen.avd} (boot ${seen.boot_id.slice(0, 8) || "?"}), not the boot a night started; not ours, left alone` };
  }
  if (o.ownerAlive) return { action: "keep", why: `${rec.avd}: its night (pid ${rec.owner_pid}) is still running and shuts it down when it ends` };
  if (o.busy) return { action: "keep", why: `${rec.avd}: ${o.busy}` };
  return { action: "stop", why: `${rec.avd} on ${rec.serial}: its night is over (pid ${rec.owner_pid} gone) and no job uses it` };
}

/** Why the brain's device row says the device is in use, or null. */
export function deviceBusy(row: { current_job?: string | null; lock?: unknown } | null): string | null {
  if (!row) return null;
  if (row.current_job) return `the brain has job ${row.current_job} on it`;
  if (row.lock) return "the brain holds a lock on it";
  return null;
}
