/**
 * devicectl: real Apple hardware — iPhone, iPad, Apple TV, Watch, Vision Pro.
 *
 * The listing is slow and every caller wants the same answer, so the raw
 * response is fetched once per discovery pass and shared. `physicalApple` in
 * targets.ts does the filtering, and its rules are the hard-won part: devicectl
 * lists simulators as devices with no flag saying so, and `tunnelState` is not
 * a reachability test. Both of those cost an evening each; neither is restated
 * here.
 *
 * What changed when this became a driver is the platform. The filter tested
 * `platform !== "iOS"` and dropped everything else, so an Apple TV cabled to
 * the executor host was invisible — not unsupported, just filtered out by a
 * line that had no reason to be that narrow. It now maps every Apple platform
 * devicectl names, which is what makes a tvOS `install` land on real hardware
 * rather than only on a simulator.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../fleet-client.js";
import { applePlatform, physicalApple, type IosDeviceInfo } from "../targets.js";
import type { Target } from "../workloads/types.js";
import type { Driver } from "./types.js";

export async function devicectlDevices(): Promise<IosDeviceInfo[]> {
  try {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "devices.json");
    await exec("xcrun", ["devicectl", "list", "devices", "--json-output", out], { timeout: 30_000 });
    const parsed = JSON.parse(readFileSync(out, "utf8")) as {
      result?: {
        devices?: {
          identifier: string;
          connectionProperties?: { tunnelState?: string; transportType?: string; pairingState?: string };
          hardwareProperties?: { marketingName?: string; productType?: string; platform?: string };
          deviceProperties?: { name?: string; osVersionNumber?: string };
        }[];
      };
    };
    return (parsed.result?.devices ?? []).map((d) => ({
      identifier: d.identifier,
      name: d.deviceProperties?.name,
      marketingName: d.hardwareProperties?.marketingName,
      productType: d.hardwareProperties?.productType,
      osVersion: d.deviceProperties?.osVersionNumber,
      transport: d.connectionProperties?.transportType,
      tunnelState: d.connectionProperties?.tunnelState,
      pairingState: d.connectionProperties?.pairingState,
      platform: d.hardwareProperties?.platform,
    }));
  } catch {
    return []; // no Xcode tooling on this host
  }
}

/** Targets from an already-fetched listing, so a caller need not pay twice. */
export function targetsFrom(all: IosDeviceInfo[]): Target[] {
  return physicalApple(all).map((d): Target => ({
    id: d.identifier,
    // physicalApple has already refused anything applePlatform does not name, so
    // the fallback is unreachable — it is here because the type says the map
    // can return null and inventing "ios" at this point is the exact mistake
    // this driver was written to stop.
    platform: applePlatform(d.platform) ?? "ios",
    kind: "device",
    driver: "devicectl",
  }));
}

export const devicectlDriver: Driver = {
  name: "devicectl",
  describes: "cabled or paired Apple hardware (iPhone, iPad, Apple TV, Watch, Vision Pro) over devicectl",
  async list(): Promise<Target[]> {
    return targetsFrom(await devicectlDevices());
  },
  async install(target: Target, file: string): Promise<void> {
    await exec("xcrun", ["devicectl", "device", "install", "app", "--device", target.id, file], {
      timeout: 300_000,
    });
  },
};
