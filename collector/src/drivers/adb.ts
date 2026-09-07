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
  /**
   * Launch the runner with the collector's address as an intent extra.
   *
   * This is the only one of the four enrolment paths that needed no new code
   * anywhere: `MainActivity` has read `--es base_url` since the shelf was
   * built, so that a whole shelf could be moved to a new collector without
   * rebuilding the app. What was missing was something on the host that sent
   * it.
   *
   * `-S` stops the app first. An activity that is already running gets
   * `onNewIntent` rather than `onCreate`, and the runner reads its extras in
   * `onCreate` -- so without this, re-pointing a device that is already running
   * would appear to do nothing at all.
   */
  async enrol(target: Target, opts: { url: string; deviceId?: string }): Promise<void> {
    const args = [
      "-s", target.id, "shell", "am", "start", "-S",
      "-n", `${RUNNER_PACKAGE}/${RUNNER_ACTIVITY}`,
      "--es", "base_url", opts.url,
    ];
    if (opts.deviceId) args.push("--es", "device_id", opts.deviceId);
    const { stdout } = await exec(ADB, args, { timeout: 30_000 });
    // `am start` exits 0 and prints `Error type 3` when the activity does not
    // exist, which is what a device with no runner installed looks like. A
    // silent success there would enrol nothing and report that it had.
    if (/Error type|does not exist|Activity class .* does not exist/i.test(stdout)) {
      throw new Error(`the runner is not installed on ${target.id} (${stdout.trim().split("\n")[0]})`);
    }
  },
};

/** The runner's package and activity, as the Android project declares them. */
const RUNNER_PACKAGE = "com.taylab.fleetrunner";
const RUNNER_ACTIVITY = ".MainActivity";
