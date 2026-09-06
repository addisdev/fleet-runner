/**
 * Which attached things the fleet should actually run work on.
 *
 * Its own module so the smoke suite can assert on it: the executor is a
 * long-running process with a main() loop and cannot be imported.
 */

/** Simulators join the fleet by name. Overridable for a host that names its own differently. */
export const SIM_PREFIX = process.env.FLEET_SIM_PREFIX ?? "fleet-";

/**
 * Is this something the fleet should be running work on?
 *
 * "Attached" is not the same as "in the fleet". Both hosts are working
 * machines: the Xcode Mac has scratch simulators booted for unrelated work,
 * and it had an Android emulator named `jerv-test` running too. Registering
 * those lets a nightly claim somebody's throwaway device and report the result
 * as fleet hardware.
 *
 * The rule is the same for every kind of virtual device, which is the point --
 * an earlier version gated iOS simulators only, and an Android emulator walked
 * straight in the day after.
 *
 *   physical hardware  -> in. Somebody cabled it up deliberately.
 *   virtual device     -> in only if its NAME opts in.
 *
 * Pass `null` for hardware, or the simulator/AVD name for anything virtual.
 */
export function fleetOwned(virtualName: string | null | undefined, prefix = SIM_PREFIX): boolean {
  if (virtualName === null || virtualName === undefined) return true;
  return virtualName.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * The name of the virtual device behind this id, or null if it is real hardware.
 *
 * Decided by asking simctl, never by which enumerator produced the target:
 * devicectl also lists booted simulators as connected devices, so the same
 * UDID arrives twice, once as a simulator and once as a device. Trusting the
 * caller's label let that second copy walk past the check.
 */
export function simulatorName(
  udid: string,
  sims: Record<string, { udid: string; name: string }[]> | null,
): string | null {
  return Object.values(sims ?? {}).flat().find((d) => d.udid === udid)?.name ?? null;
}

/** An adb serial of the form `emulator-5554` is an emulator, not a phone. */
export function isAndroidEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** What `devicectl list devices` tells us about one entry. */
export type IosDeviceInfo = {
  identifier: string;
  name?: string;
  marketingName?: string;
  productType?: string;
  osVersion?: string;
  transport?: string;
  tunnelState?: string;
  pairingState?: string;
  platform?: string;
};

/**
 * devicectl's platform name, as the fleet spells it -- or null for something
 * that is not an Apple device at all.
 *
 * devicectl says "iOS", "tvOS", "watchOS", "xrOS"; the fleet says "ios",
 * "tvos", "watchos", "visionos". The odd one is xrOS, which is what the
 * toolchain still calls visionOS internally: matching on the marketing name
 * would silently drop every headset.
 *
 * This exists because `physicalIos` used to test `platform !== "iOS"` and
 * return false for everything else. That one line is why an Apple TV plugged
 * into the executor host was invisible to the fleet -- not missing support,
 * just a filter that had no reason to be that narrow.
 *
 * A platform this does not know returns null and the device is ignored, which
 * is deliberate: a Mac appears in `devicectl list devices` too, and the host
 * running the executor is not one of its own targets.
 */
export function applePlatform(devicectlPlatform: string | undefined): string | null {
  switch (devicectlPlatform) {
    case "iOS": return "ios";
    case "tvOS": return "tvos";
    case "watchOS": return "watchos";
    case "xrOS": case "visionOS": return "visionos";
    default: return null;
  }
}

/**
 * The platform behind a CoreSimulator runtime identifier.
 *
 * simctl groups booted devices under keys like
 * `com.apple.CoreSimulator.SimRuntime.tvOS-18-2`. The suffix carries the
 * platform and the version, and the executor threw both away and called every
 * booted simulator "ios" -- which is why a booted Apple TV simulator and a
 * booted iPhone were the same thing to the fleet.
 *
 * Unknown runtimes return null rather than a guess, so a runtime Apple adds
 * later is skipped visibly instead of being filed under iOS.
 */
export function simulatorPlatform(runtimeKey: string): string | null {
  const m = /SimRuntime\.([A-Za-z]+)-/.exec(runtimeKey);
  if (!m) return null;
  switch (m[1]) {
    case "iOS": return "ios";
    case "tvOS": return "tvos";
    case "watchOS": return "watchos";
    case "xrOS": case "visionOS": return "visionos";
    default: return null;
  }
}

/**
 * Real, reachable Apple hardware -- not simulators, whatever devicectl calls them.
 *
 * This was `physicalIos` and it returned iPhones and iPads only, because its
 * first line was `platform !== "iOS"`. That was never a support boundary, only
 * the platforms that happened to be on the shelf: an Apple TV cabled to this
 * Mac was filtered out one line into discovery and never appeared anywhere.
 * Widening it is what makes a tvOS or watchOS device schedulable at all.
 *
 * What it does NOT do is make every workload applicable to every Apple device.
 * A handler that wants iPhones asks for `platform === "ios"` and gets them; the
 * watch that now appears is a `watchos` target and is selected only by a job
 * that asked for one. The old behaviour survives as the narrower query it
 * always should have been.
 *
 * Two fields, and neither is the obvious one.
 *
 * `transport` separates hardware from simulators. devicectl lists SIMULATORS
 * as devices with no `isSimulated` flag: this Mac reports 26 "devices", of
 * which two are real. A simulator runs here and is always `sameMachine`.
 *
 * `tunnelState` is NOT a reachability test, which is the trap. A wired iPhone
 * sitting on this desk reports `tunnelState: disconnected` and yet answers
 * `devicectl device info details` immediately with a tunnel IP -- devicectl
 * brings the tunnel up on demand. Gating on it rejected a working phone.
 *
 * So: cabled hardware is reachable, full stop. A device reached over the local
 * network is only reachable while it is actually on the network, and there
 * tunnelState is the best signal available.
 */
export function physicalApple(all: IosDeviceInfo[]): IosDeviceInfo[] {
  return all.filter((d) => {
    if (applePlatform(d.platform) === null) return false;
    if (d.transport === undefined || d.transport === "sameMachine") return false;
    if (d.pairingState !== undefined && d.pairingState !== "paired") return false;
    // Plugged in is plugged in.
    if (d.transport === "wired") return true;
    return d.tunnelState === "connected";
  });
}

/**
 * Why the fleet is ignoring an attached-looking Apple device, and what to do.
 *
 * The first version of this said "is paired but not reachable -- unlock it,
 * trust this Mac" for every case. That was actively misleading when the device
 * was `unpaired`: pairing is per-Mac and does not move with the phone, so
 * after the executor moved hosts the advice told you to unlock a phone that
 * was already unlocked, while the actual fix -- plug it in and tap Trust on
 * the NEW machine -- went unmentioned.
 *
 * Returns null when the device is fine and needs no explanation.
 */
export function appleNotReadyReason(d: IosDeviceInfo): string | null {
  if (applePlatform(d.platform) === null) return null;
  if (d.transport === undefined || d.transport === "sameMachine") return null;
  if (physicalApple([d]).length > 0) return null; // it is in

  const name = d.marketingName ?? d.name ?? d.identifier;
  if (d.pairingState !== undefined && d.pairingState !== "paired") {
    return `${name} is not paired with this Mac (pairingState=${d.pairingState}) -- ` +
      "plug it in, unlock it, and tap Trust. Pairing is per-Mac and does not move with the phone";
  }
  // Paired, so it is a reachability problem rather than a trust one. Only
  // network-attached devices get here: a wired device is always accepted.
  return `${name} is paired but not reachable (transport=${d.transport}, tunnel=${d.tunnelState}) -- ` +
    "it is not on the network, or is asleep";
}

/**
 * Should a failing `adb devices` be reported, or is it simply absent?
 *
 * ENOENT is the iOS-only host: no Android SDK, no Android devices, nothing
 * worth saying every 60 seconds. Anything else means adb IS installed and is
 * failing -- a version-mismatched daemon, a dead server -- and staying quiet
 * about that empties the entire Android shelf silently. Every cabled phone
 * reads offline and jobs fail with "no android targets matched this job",
 * which sends you looking at match expressions instead of at adb.
 */
export function adbFailureIsWorthReporting(code: string | undefined): boolean {
  return code !== "ENOENT";
}
