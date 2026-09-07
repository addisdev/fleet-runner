/**
 * The registry. Adding a way to reach devices is adding a file and a line here.
 *
 * Ordered, and the order matters exactly once: a booted simulator is reported
 * by BOTH simctl and devicectl, with the same UDID, and the dedupe below keeps
 * whichever driver spoke first. simctl is listed before devicectl so the copy
 * that survives is the one that knows it is a simulator — the other says
 * `kind: "device"`, which would put an emulated GPU's numbers in a table of
 * real silicon.
 *
 * `roku` is last, and not because of dedupe -- nothing else on this list can
 * see a Roku and there is no duplicate to resolve. It is the only driver whose
 * discovery costs a fixed wall-clock wait rather than a command that returns
 * when it is done: SSDP has no end-of-list, so it listens for a window and
 * reports whatever answered inside it. `listAllTargets` runs the drivers
 * concurrently, so that wait overlaps the others rather than adding to them,
 * and the position in this array is cosmetic.
 */
import { adbDriver } from "./adb.js";
import { simctlDriver } from "./simctl.js";
import { devicectlDriver } from "./devicectl.js";
import { rokuDriver } from "./roku.js";
import type { Driver } from "./types.js";
import type { Target } from "../workloads/types.js";

export type { Driver } from "./types.js";
export { adbDriver } from "./adb.js";
export { simctlDriver } from "./simctl.js";
export { devicectlDriver, devicectlDevices } from "./devicectl.js";
export { rokuDriver, rokuDevices, rokuTargetId, parseSsdpLocation, parseDeviceInfo, xmlTag } from "./roku.js";
export { bootedSimulators } from "./simctl.js";
export { adbDevices } from "./adb.js";

export const DRIVERS: Driver[] = [adbDriver, simctlDriver, devicectlDriver, rokuDriver];

export function driverNamed(name: string | undefined): Driver | undefined {
  return DRIVERS.find((d) => d.name === name);
}

/**
 * Fold the registry into one list, first driver wins on a duplicate id.
 *
 * `extra` lets a caller inject drivers in a test without touching the module's
 * own registry — the alternative being a mutable global that one test leaves
 * dirty for the next.
 */
export function dedupe(lists: Target[][]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/**
 * Everything attached to this host, from every driver.
 *
 * Drivers run concurrently because devicectl takes seconds and adb takes
 * milliseconds, and this is called every 60 seconds by presence reporting as
 * well as by every job that selects targets. `Promise.all` is safe here only
 * because a driver's `list()` is contracted never to throw; if one ever does,
 * the catch turns it into an empty list and says which driver went wrong
 * rather than taking discovery down with it.
 */
export async function listAllTargets(drivers: Driver[] = DRIVERS): Promise<Target[]> {
  const lists = await Promise.all(
    drivers.map(async (d) => {
      try {
        return await d.list();
      } catch (e) {
        // A driver that throws has broken its own contract. Reported rather
        // than swallowed, because the symptom otherwise is "my phone vanished".
        const { log } = await import("../fleet-client.js");
        log(`driver ${d.name} threw during discovery (${(e as Error).message}); ignoring its targets`);
        return [] as Target[];
      }
    }),
  );
  return dedupe(lists);
}
