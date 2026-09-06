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
};
