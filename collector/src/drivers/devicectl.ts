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
  /**
   * Launch the runner and hand it a `fleetrunner://join` URL.
   *
   * `--payload-url` is documented as "a URL to pass to the application for it to
   * open", which arrives in SwiftUI as `onOpenURL`. The runner parses it in
   * `ContentView.parseJoin` and starts immediately.
   *
   * A URL rather than `--environment-variables`, even though devicectl has
   * both, because the URL is the mechanism that works from everywhere else too:
   * a QR code pointed at with a phone, a link tapped in Safari, `simctl
   * openurl`, TestFlight. An Apple TV has no camera and its on-screen keyboard
   * is a grid driven by a remote, so for one of those this is the entire
   * enrolment story -- and it should be the same path a person can use by hand
   * when no Mac with Xcode is in the room.
   *
   * `--terminate-existing` for the reason every driver here needs its
   * equivalent: an app already running would be brought to the foreground with
   * its previous collector still configured, which looks exactly like an
   * enrolment that worked.
   *
   * UNVERIFIED. No paired Apple hardware was attached to the machine this was
   * written on, so this command line has never been run. The flag and its
   * meaning are from `devicectl device process launch --help` on the Xcode
   * installed here, and the URL shape matches what the app parses.
   */
  async enrol(target: Target, opts: { url: string; deviceId?: string }): Promise<void> {
    const join = new URL("fleetrunner://join");
    join.searchParams.set("url", opts.url);
    if (opts.deviceId) join.searchParams.set("device_id", opts.deviceId);
    // Which product to launch depends on the platform: one source tree, three
    // bundle identifiers. An Apple TV asked for the iOS bundle simply has no
    // such app, and the error says so rather than misbehaving.
    const bundle = BUNDLE_IDS[target.platform] ?? BUNDLE_IDS.ios;
    await exec(
      "xcrun",
      [
        "devicectl", "device", "process", "launch",
        "--device", target.id,
        "--terminate-existing",
        "--payload-url", join.toString(),
        bundle,
      ],
      { timeout: 120_000 },
    );
  },
};

/**
 * The runner's bundle identifier per Apple platform, as project.yml declares
 * them. One source tree, three products, three identifiers.
 */
const BUNDLE_IDS: Record<string, string> = {
  ios: "com.taylab.fleetrunner",
  tvos: "com.taylab.fleetrunner.tv",
  visionos: "com.taylab.fleetrunner.vision",
};
