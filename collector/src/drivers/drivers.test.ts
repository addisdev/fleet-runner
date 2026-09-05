/**
 * Checks for discovery: the parsers each driver owns, the platform mapping
 * that decides what a device IS, and the dedupe rule that decides which of two
 * drivers' answers survives.
 *
 * Folded into scripts/smoke.ts by the same `check(name, cond, detail)` shape
 * the other pure-function modules use, so `npm test` runs them.
 *
 * The samples are real shapes. The tvOS and watchOS runtimes matter most: no
 * machine in this fleet is guaranteed to have one booted, so the only way these
 * paths are ever exercised is against a recorded response — and they are the
 * paths that decide whether an Apple TV is a fleet device or an invisible one.
 */
import { parseAdbDevices } from "./adb.js";
import { bootedFrom } from "./simctl.js";
import { targetsFrom } from "./devicectl.js";
import { dedupe, listAllTargets, driverNamed, DRIVERS } from "./index.js";
import { applePlatform, simulatorPlatform, physicalApple, type IosDeviceInfo } from "../targets.js";
import { devicePlatform, deviceKind } from "../api/shared.js";
import type { Target } from "../workloads/types.js";
import type { Driver } from "./types.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

// `adb devices` on a host with one phone, one emulator, one unauthorised
// device and the trailing blank line adb always prints. CRLF because adb's
// shell transport uses it and has broken a parser here before.
const ADB_OUT = [
  "List of devices attached",
  "R5CT30ABCDE\tdevice",
  "emulator-5554\tdevice",
  "9A241FFAZ00123\tunauthorized",
  "",
].join("\r\n");

// simctl -j with four runtimes booted. The unknown one is deliberate: Apple
// adds runtimes, and the rule is that an unrecognised one is skipped, not
// filed under iOS.
const SIMCTL = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { udid: "IPHONE-BOOTED", state: "Booted" },
      { udid: "IPHONE-OFF", state: "Shutdown" },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [{ udid: "APPLETV-BOOTED", state: "Booted" }],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [{ udid: "WATCH-BOOTED", state: "Booted" }],
    "com.apple.CoreSimulator.SimRuntime.xrOS-2-2": [{ udid: "VISION-BOOTED", state: "Booted" }],
    "com.apple.CoreSimulator.SimRuntime.holoOS-1-0": [{ udid: "FUTURE-BOOTED", state: "Booted" }],
  },
};

// devicectl: a wired Apple TV, a wired iPhone, and a simulator that devicectl
// also reports as a device (transport sameMachine) — the duplicate that the
// ordering rule exists for.
const DEVICECTL: IosDeviceInfo[] = [
  { identifier: "APPLETV-REAL", platform: "tvOS", transport: "wired", pairingState: "paired" },
  { identifier: "IPHONE-REAL", platform: "iOS", transport: "wired", pairingState: "paired" },
  { identifier: "IPHONE-BOOTED", platform: "iOS", transport: "sameMachine" },
  { identifier: "THE-MAC-ITSELF", platform: "macOS", transport: "wired", pairingState: "paired" },
];

export function runDriverChecks(check: Check) {
  // --- adb ------------------------------------------------------------------
  const adb = parseAdbDevices(ADB_OUT);
  check("adb: only lines ending in 'device' are targets", adb.length === 2, adb.join(","));
  check("adb: an unauthorised device is not a target", !adb.includes("9A241FFAZ00123"));
  check("adb: the header line is not a serial", !adb.some((s) => s.startsWith("List")));
  check("adb: CRLF does not end up in the serial", adb.every((s) => !/[\r\n]/.test(s)), adb.join("|"));

  // --- the Apple platform mapping ------------------------------------------
  check("devicectl tvOS maps to tvos", applePlatform("tvOS") === "tvos");
  check("devicectl xrOS maps to visionos, not to xros", applePlatform("xrOS") === "visionos");
  check("devicectl macOS is not a fleet target", applePlatform("macOS") === null);
  check("an unknown devicectl platform is refused, not guessed", applePlatform("holoOS") === null);
  check("simctl runtime keys carry the platform", simulatorPlatform("com.apple.CoreSimulator.SimRuntime.tvOS-18-2") === "tvos");
  check("a runtime key with no version is not parsed", simulatorPlatform("nonsense") === null);

  // --- simctl ---------------------------------------------------------------
  const booted = bootedFrom(SIMCTL);
  const byUdid = new Map(booted.map((b) => [b.udid, b.platform]));
  check("simctl: only Booted simulators are listed", !byUdid.has("IPHONE-OFF"), [...byUdid.keys()].join(","));
  check("simctl: an iPhone simulator is ios", byUdid.get("IPHONE-BOOTED") === "ios");
  check("simctl: an Apple TV simulator is tvos, not ios", byUdid.get("APPLETV-BOOTED") === "tvos", String(byUdid.get("APPLETV-BOOTED")));
  check("simctl: a Watch simulator is watchos", byUdid.get("WATCH-BOOTED") === "watchos");
  check("simctl: an xrOS simulator is visionos", byUdid.get("VISION-BOOTED") === "visionos");
  check("simctl: an unrecognised runtime is skipped, not called ios", !byUdid.has("FUTURE-BOOTED"));

  // --- devicectl ------------------------------------------------------------
  const physical = physicalApple(DEVICECTL);
  check(
    "devicectl: a wired Apple TV is physical hardware",
    physical.some((d) => d.identifier === "APPLETV-REAL"),
    physical.map((d) => d.identifier).join(","),
  );
  check("devicectl: a sameMachine entry is a simulator, not hardware", !physical.some((d) => d.identifier === "IPHONE-BOOTED"));
  check("devicectl: the host Mac is not one of its own targets", !physical.some((d) => d.identifier === "THE-MAC-ITSELF"));
  const dcTargets = targetsFrom(DEVICECTL);
  check(
    "devicectl: the Apple TV target says tvos",
    dcTargets.find((t) => t.id === "APPLETV-REAL")?.platform === "tvos",
    JSON.stringify(dcTargets),
  );
  check("devicectl: every target names its driver", dcTargets.every((t) => t.driver === "devicectl"));

  // --- dedupe ---------------------------------------------------------------
  // The ordering rule: simctl before devicectl, so the copy that survives is
  // the one that knows it is a simulator. Getting this backwards puts an
  // emulated GPU's numbers into a table of real silicon.
  const sim: Target = { id: "IPHONE-BOOTED", platform: "ios", kind: "simulator", driver: "simctl" };
  const dupe: Target = { id: "IPHONE-BOOTED", platform: "ios", kind: "device", driver: "devicectl" };
  const merged = dedupe([[sim], [dupe]]);
  check("dedupe: one id yields one target", merged.length === 1, String(merged.length));
  check("dedupe: the simulator answer wins", merged[0]?.kind === "simulator", merged[0]?.kind ?? "(none)");
  check(
    "the registry orders simctl before devicectl",
    DRIVERS.findIndex((d) => d.name === "simctl") < DRIVERS.findIndex((d) => d.name === "devicectl"),
    DRIVERS.map((d) => d.name).join(","),
  );

  // --- the registry ---------------------------------------------------------
  check("every driver has a name and a description", DRIVERS.every((d) => !!d.name && !!d.describes));
  check("a driver can be found by name", driverNamed("adb")?.name === "adb");
  check("an unknown driver name is undefined, not a throw", driverNamed("ssh") === undefined);

  // A driver that breaks its own contract must not take discovery down with
  // it: the symptom otherwise is every phone on the shelf vanishing at once.
  const thrower: Driver = {
    name: "broken",
    describes: "a driver that throws",
    list() { throw new Error("boom"); },
  };
  const fine: Driver = {
    name: "fine",
    describes: "a driver that works",
    async list() { return [{ id: "STILL-HERE", platform: "android", kind: "device", driver: "fine" }]; },
  };
  return listAllTargets([thrower, fine]).then((targets) => {
    check(
      "a throwing driver does not empty the shelf",
      targets.length === 1 && targets[0].id === "STILL-HERE",
      JSON.stringify(targets),
    );
  });
}

/**
 * The declared-platform rule, which is the other half of the same change: a
 * driver says what it found, and an agent says what it is.
 */
export function runDescriptorChecks(check: Check) {
  check("a declared platform is believed", devicePlatform({ platform: "macos", os: "macos-15.2" }) === "macos");
  check(
    "a declared platform wins over the os regex",
    devicePlatform({ platform: "tvos", os: "iphoneos-18" }) === "tvos",
  );
  check("a declared platform is lowercased", devicePlatform({ platform: "  TvOS  " }) === "tvos");
  // The fallback is the old rule, kept exactly, so upgrading the collector does
  // not relabel a shelf of agents that predate the field.
  check("no declared platform falls back to the os regex: iOS", devicePlatform({ os: "ios-18.2" }) === "ios");
  check("no declared platform falls back to the os regex: iPad", devicePlatform({ os: "iPadOS 17" }) === "ios");
  check("no declared platform and no iOS marker is android", devicePlatform({ os: "android-14" }) === "android");
  check("an empty descriptor is android, as it always was", devicePlatform({}) === "android");
  check("an empty platform string is not a platform", devicePlatform({ platform: "   ", os: "android-14" }) === "android");

  check("a declared kind is believed", deviceKind({ kind: "tv" }) === "tv");
  check("an undeclared kind is null, never a guess", deviceKind({ os: "android-14" }) === null);
  check("an empty kind string is null", deviceKind({ kind: "" }) === null);
  check("a non-string kind is null", deviceKind({ kind: 7 }) === null);
}
