/**
 * Keeping the device registry down to real things.
 *
 * Two kinds of row outlive what they describe, and both were on the live brain
 * in October 2026: thirteen offline iOS rows that were simulator UUIDs from
 * runs long gone, and a Roku listed twice -- `roku-ip-192-168-50-218`, from a
 * sweep where the box answered SSDP but not device-info, offline beside the
 * `roku-X01600EMFRJ9` it really is. A fan-out with no pool reaches every row,
 * and a shelf where a third of the entries are ghosts is a shelf nobody reads.
 *
 * Forgetting here is what `DELETE /api/devices/:id` does: the row goes, the
 * results and beacons it posted stay, because they are measurements and a
 * device leaving the shelf does not make them untrue.
 */
import { db } from "./db.js";
import { parse } from "./api/shared.js";

/** How long a simulator may sit offline before it is forgotten. */
export function simulatorTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.FLEET_SIMULATOR_TTL_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 7;
}

/**
 * Is this row a simulator by its own say-so?
 *
 * Only what the agent declared: `kind: "simulator"` or `soc: "simulator"`,
 * which is what the host executor writes for every Apple simulator. Not the
 * looser `isSimulator()` heuristic the dashboard uses to keep simulators out of
 * hardware tables -- that one also fires on `x86_64`, which a real Intel
 * machine can report, and a real device is never forgotten. Android emulators
 * are not forgotten either: `emulator-5554` comes back under the same serial
 * the next time an AVD boots, and they already carry a presence TTL that hides
 * them while they are gone.
 */
export function declaredSimulator(descriptor: Record<string, unknown>): boolean {
  return descriptor.kind === "simulator" || descriptor.soc === "simulator";
}

/**
 * Forget simulator rows that have been offline longer than the TTL. Run by the
 * lease sweep. A simulator is recreated, never brought back: a UUID that has
 * not checked in for a week belongs to a device that no longer exists.
 *
 * A row that holds a lock or a claim is left alone, however old -- the same
 * rule the dashboard's Forget button follows.
 */
export function forgetStaleSimulators(days = simulatorTtlDays()): string[] {
  const rows = db
    .prepare(
      `SELECT device_id, descriptor FROM devices
        WHERE last_seen <= datetime('now', ?)
          AND NOT EXISTS (SELECT 1 FROM device_locks l WHERE l.device_id = devices.device_id)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status = 'claimed' AND j.claimed_by = devices.device_id)`,
    )
    .all(`-${Math.round(days * 86_400)} seconds`) as { device_id: string; descriptor: string }[];
  const gone: string[] = [];
  const del = db.prepare("DELETE FROM devices WHERE device_id = ?");
  for (const r of rows) {
    if (!declaredSimulator(parse<Record<string, unknown>>(r.descriptor, {}))) continue;
    if (del.run(r.device_id).changes > 0) gone.push(r.device_id);
  }
  return gone;
}

/** `roku-ip-192-168-50-218` for 192.168.50.218: the id the executor gives a Roku it knows only by address. */
export function rokuIpId(ip: string): string {
  return `roku-ip-${ip.replace(/\./g, "-")}`;
}

/**
 * When a Roku registers under its serial, retire the row the same box left
 * when it was known only by its IP.
 *
 * The executor names a Roku `roku-<serial>` when device-info answers and
 * `roku-ip-<address>` when only SSDP did, so one flaky sweep is enough to leave
 * a second row that never checks in again. The serial-named row re-registers
 * every minute, so a duplicate that comes back from another flaky sweep is
 * retired within the minute too. Not the other way round: an IP-named row
 * never displaces a serial-named one, because the serial is the better name.
 */
export function retireRokuIpDuplicate(deviceId: string, descriptor: Record<string, unknown>): string | null {
  if (!/^roku-/.test(deviceId) || deviceId.startsWith("roku-ip-")) return null;
  const ip = descriptor.ip;
  if (typeof ip !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const dup = rokuIpId(ip);
  const held =
    db.prepare("SELECT 1 FROM device_locks WHERE device_id = ?").get(dup) ??
    db.prepare("SELECT 1 FROM jobs WHERE status = 'claimed' AND claimed_by = ?").get(dup);
  if (held) return null;
  return db.prepare("DELETE FROM devices WHERE device_id = ?").run(dup).changes > 0 ? dup : null;
}
