/**
 * simctl: booted Apple simulators, of every platform.
 *
 * The change worth knowing about is one line. `bootedSimulators()` used to
 * return a list of UDIDs and the caller labelled all of them `ios`, because at
 * the time the only simulators on the shelf were iPhones. simctl has always
 * grouped its answer by runtime — the JSON keys are
 * `com.apple.CoreSimulator.SimRuntime.tvOS-18-2` and friends — so the platform
 * was sitting in the response the whole time, being discarded.
 *
 * Reading it is what makes an Apple TV simulator and an Apple Watch simulator
 * first-class fleet devices, with no new tooling and no new install path:
 * `simctl install` and `simctl launch` take a tvOS or watchOS simulator's UDID
 * exactly as they take an iPhone's.
 */
import { exec } from "../fleet-client.js";
import { simulatorPlatform } from "../targets.js";
import type { Target } from "../workloads/types.js";
import type { Driver } from "./types.js";

type SimctlList = { devices: Record<string, { udid: string; state: string }[]> };

/**
 * Booted simulators as (udid, platform) pairs.
 *
 * Exported and pure over its input so the tests can hand it a recorded simctl
 * response — including the tvOS and watchOS runtimes that no test machine is
 * guaranteed to have booted.
 */
export function bootedFrom(parsed: SimctlList): { udid: string; platform: string }[] {
  const out: { udid: string; platform: string }[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const platform = simulatorPlatform(runtime);
    // A runtime this build does not recognise is skipped rather than filed
    // under iOS. Apple adds runtimes; guessing puts a device the fleet cannot
    // describe into a table that compares hardware.
    if (platform === null) continue;
    for (const d of devices) if (d.state === "Booted") out.push({ udid: d.udid, platform });
  }
  return out;
}

export async function bootedSimulators(): Promise<{ udid: string; platform: string }[]> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    return bootedFrom(JSON.parse(stdout) as SimctlList);
  } catch {
    return []; // no Xcode tooling on this host
  }
}

export const simctlDriver: Driver = {
  name: "simctl",
  describes: "booted Apple simulators (iOS, tvOS, watchOS, visionOS) over simctl",
  async list(): Promise<Target[]> {
    return (await bootedSimulators()).map(({ udid, platform }): Target => ({
      id: udid,
      platform,
      kind: "simulator",
      driver: "simctl",
    }));
  },
  async install(target: Target, file: string): Promise<void> {
    await exec("xcrun", ["simctl", "install", target.id, file], { timeout: 120_000 });
  },
  /**
   * Launch the runner with the collector's address in its environment.
   *
   * `simctl launch` passes any `SIMCTL_CHILD_`-prefixed variable through to the
   * launched process with the prefix stripped, which is the only mechanism a
   * simulator offers that does not involve typing into it.
   *
   * `--terminate-running-process` for the same reason adb needs `-S`: a runner
   * that is already up would otherwise be brought to the foreground with its
   * old collector still configured, which looks exactly like an enrolment that
   * worked.
   *
   * UNVERIFIED. The environment is passed correctly -- that is simctl's
   * documented behaviour -- but nothing in the iOS runner reads FLEET_URL yet.
   * It reads `@AppStorage("base_url")`, which a launch environment does not
   * touch. Until the app is taught to, this enrols nothing and the workload
   * will report that the device never registered.
   */
  async enrol(target: Target, opts: { url: string; deviceId?: string }): Promise<void> {
    const env: Record<string, string> = { SIMCTL_CHILD_FLEET_URL: opts.url };
    if (opts.deviceId) env.SIMCTL_CHILD_FLEET_DEVICE_ID = opts.deviceId;
    await exec(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", target.id, RUNNER_BUNDLE_ID],
      { timeout: 60_000, env: { ...process.env, ...env } },
    );
  },
};

/**
 * The iOS/tvOS runner's bundle identifier, as project.yml declares it.
 *
 * The tvOS target is `.tv` and the visionOS one `.vision`; this is the iOS one,
 * and enrolling an Apple TV simulator with it will fail to find the app. Left
 * as the single common case rather than a lookup table, because a table with
 * three untested entries is three ways to be wrong instead of one.
 */
const RUNNER_BUNDLE_ID = "com.taylab.fleetrunner";
