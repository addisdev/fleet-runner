/**
 * adb: every Android thing on the shelf.
 *
 * One driver, many shapes. A phone, a tablet, a Fire TV stick, a Quest headset
 * and a Wear watch are all reached by exactly these commands, which is why
 * Android needs no per-form-factor driver and Apple needs two. The runner APK
 * declares which shape it is when it registers; from out here they are
 * identical, and that is the correct answer rather than a limitation.
 */
import { exec, log } from "../fleet-client.js";
import { ADB } from "../workloads/device.js";
import { adbFailureIsWorthReporting } from "../targets.js";
import type { Target } from "../workloads/types.js";
import type { Driver } from "./types.js";

/**
 * The last complaint printed, so a permanently broken adb does not fill the
 * log. This runs every 60 seconds.
 */
let adbComplaint = "";

/** Exported for the tests: the parse is the part that has been wrong before. */
export function parseAdbDevices(stdout: string): string[] {
  return stdout
    .split("\n")
    .slice(1)
    .filter((l) => l.trim().endsWith("device"))
    .map((l) => l.split("\t")[0]);
}

export async function adbDevices(): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(ADB, ["devices"]));
    adbComplaint = "";
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string };
    // ENOENT is the iOS-only host this branch exists for: no adb, no Android
    // devices, nothing to say. Anything else means adb IS here and is failing
    // -- a version-mismatched daemon, a dead server -- and returning [] for
    // that silently empties the whole Android shelf. Every cabled phone reads
    // offline, and jobs fail with "no android targets matched this job", which
    // sends you looking at match expressions instead of at adb.
    if (adbFailureIsWorthReporting(err.code)) {
      const why = (err.stderr ?? err.message ?? "unknown").trim().split("\n")[0].slice(0, 160);
      if (why !== adbComplaint) {
        adbComplaint = why;
        log(`adb is present but failing, so no Android devices are visible: ${why}`);
      }
    }
    return [];
  }
  return parseAdbDevices(stdout);
}

export const adbDriver: Driver = {
  name: "adb",
  describes: "Android phones, tablets, TV sticks, headsets and watches over adb",
  async list(): Promise<Target[]> {
    return (await adbDevices()).map((id): Target => ({
      id,
      platform: "android",
      kind: "device",
      driver: "adb",
    }));
  },
  async install(target: Target, file: string): Promise<void> {
    await exec(ADB, ["-s", target.id, "install", "-r", file], { timeout: 120_000 });
  },
};
