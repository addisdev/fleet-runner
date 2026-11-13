/**
 * The device plumbing more than one workload needs.
 *
 * These used to be private functions in executor.ts, which is why they could
 * only be used by handlers that also lived in executor.ts. They are here, and
 * not in a workload's own directory, for exactly one reason: something other
 * than that workload calls them. Anything a single workload uses belongs in
 * that workload's directory instead, where its blast radius is one job type.
 *
 * executor.ts imports them back, so the handlers still waiting to move keep
 * calling the same functions they always did. There is one definition of "is
 * this app installed", and it answers the same on both sides of the move.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../fleet-client.js";
import type { Target } from "./types.js";

/**
 * adb, or wherever this host keeps it. A LaunchAgent's PATH is not a login
 * shell's, so the fleet's Android SDK hosts set ADB_BIN rather than hoping.
 */
export const ADB = process.env.ADB_BIN ?? "adb";

/**
 * Is `appId` installed on this target?
 *
 * False on any failure, including "no adb on this host", because every caller
 * uses it to decide whether to skip a device rather than whether to fail the
 * job — and a skipped device with a stated reason is a better answer than a
 * job that died asking.
 */
export async function hasApp(target: Target, appId: string): Promise<boolean> {
  try {
    if (target.platform === "android") {
      await exec(ADB, ["-s", target.id, "shell", "pm", "path", appId], { timeout: 15_000 });
    } else if (target.kind === "device") {
      const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "apps.json");
      await exec("xcrun", ["devicectl", "device", "info", "apps", "--device", target.id, "--json-output", out], { timeout: 30_000 });
      const parsed = JSON.parse(readFileSync(out, "utf8")) as { result?: { apps?: { bundleIdentifier: string }[] } };
      return (parsed.result?.apps ?? []).some((a) => a.bundleIdentifier === appId);
    } else {
      await exec("xcrun", ["simctl", "get_app_container", target.id, appId], { timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the lock screen still up, judging by `dumpsys window`?
 *
 * Read after waking the screen and asking the keyguard to go away, so "still
 * up" means it would not go: a PIN, pattern or password. The signals differ
 * across Android versions and vendors, so any one of them counts: the keyguard
 * owning the status bar (AOSP, Samsung), the lock screen showing or dreaming,
 * or the focused window being the keyguard or its PIN pad (Samsung calls it
 * "Bouncer"). Not a focused StatusBar alone: that is also the notification
 * shade pulled down on an unlocked phone.
 */
export function screenLocked(dumpsysWindow: string): boolean {
  return /isStatusBarKeyguard=true/.test(dumpsysWindow) ||
    /mShowingLockscreen=true/.test(dumpsysWindow) ||
    /mDreamingLockscreen=true/.test(dumpsysWindow) ||
    /mCurrentFocus=Window\{[^}]*\b(Bouncer|Keyguard)\b/i.test(dumpsysWindow);
}

/**
 * Wake an Android device and dismiss a lock screen that has no PIN, before a
 * host workload drives its screen. Returns null when the device is ready, or
 * the reason it is not, which the caller posts as a skip.
 *
 * A phone on the shelf sleeps between jobs. Maestro does not wake it, so a
 * flow ran against a dark lock screen and failed on its first assertion --
 * the Galaxy S8+'s nightly smoke said `"Fleet Runner" is visible` was false
 * every night for a week, which read as the app being broken. A PIN is the one
 * thing this cannot get past, and saying so is better than a red run that
 * blames the app. Emulators have no lock screen and pass straight through.
 */
export async function ensureAwake(target: Target): Promise<string | null> {
  if (target.platform !== "android") return null;
  const adb = (...args: string[]) => exec(ADB, ["-s", target.id, "shell", ...args], { timeout: 15_000 });
  try {
    await adb("input", "keyevent", "KEYCODE_WAKEUP");
    await adb("wm", "dismiss-keyguard");
    await new Promise((r) => setTimeout(r, 1_500));
    const { stdout } = await adb("dumpsys", "window");
    if (screenLocked(stdout)) {
      return "skipped: the screen is locked with a PIN, pattern or password, which nothing here can get past; " +
        "remove the screen lock (Settings > Lock screen > None or Swipe) on this test device";
    }
    return null;
  } catch {
    // A device adb cannot reach this way is left to the steps after this one,
    // which say why in their own terms; waking it was a courtesy.
    return null;
  }
}

/**
 * What every launch the fleet makes itself passes, so the app knows it is in
 * the lab and not in a person's hand.
 *
 * Apps on the Taylab SDK read these (`TaylabTelemetry.isLabLaunch` on both
 * platforms, SDK 1.16+): their envelopes then carry `lab: true` (and, from
 * 1.19, `harness: lab`), and the first-week funnel leaves the install out.
 * Without it a night of exploring is a stream of new users who all tried,
 * most of whom stayed. An app that does not read them never sees a difference:
 * an unknown intent extra or `-Key Value` pair is ignored.
 *
 * Android takes `key=value` (a string extra, `--es`); Apple platforms take
 * process arguments. Roku and the web have neither, so get nothing. A Maestro
 * flow launches the app itself and needs its own
 * `arguments: { taylab_lab: true }` on each `launchApp`.
 */
export function labLaunchArgs(platform: string): string[] {
  if (platform === "android") return ["taylab_lab=true"];
  if (["ios", "tvos", "watchos", "visionos", "macos"].includes(platform)) return ["-TaylabLab", "YES"];
  return [];
}

/** `key=value` launch arguments as `am start` string extras. */
export const asExtras = (args: string[]): string[] =>
  args.flatMap((a) => {
    const i = a.indexOf("=");
    return i > 0 ? ["--es", a.slice(0, i), a.slice(i + 1)] : [];
  });

/**
 * Launch the app, three ways, because three platforms.
 *
 * `args` reach a simulator or a real iPhone as process arguments, which is how
 * a launch argument like -AppleLanguages reaches an app without touching the
 * device's own language at all. Android has no equivalent -- `am start` extras
 * are not read as preferences -- so the Android path ignores them rather than
 * pretending otherwise. Every platform gets `labLaunchArgs` first.
 */
export async function launchApp(target: Target, appId: string, args: string[] = []) {
  const lab = labLaunchArgs(target.platform);
  if (target.platform === "ios" && target.kind === "device") {
    await exec("xcrun", ["devicectl", "device", "process", "launch", "--device", target.id, appId, ...lab, ...args], { timeout: 60_000 });
    return;
  }
  if (target.platform === "android") {
    // Resolve the real launcher activity; monkey is a fallback because some
    // images (ATD) resolve but throttle monkey events.
    try {
      const { stdout } = await exec(
        ADB, ["-s", target.id, "shell", "cmd", "package", "resolve-activity", "--brief", appId],
        { timeout: 15_000 },
      );
      const component = stdout.trim().split("\n").pop()?.trim();
      if (!component || !component.includes("/")) throw new Error(`unresolvable: ${stdout}`);
      await exec(ADB, ["-s", target.id, "shell", "am", "start", "-n", component, ...asExtras(lab)], { timeout: 30_000 });
    } catch {
      // monkey carries no extras: a launch this way is not marked as the lab's.
      await exec(ADB, ["-s", target.id, "shell", "monkey", "-p", appId, "-c",
        "android.intent.category.LAUNCHER", "1"], { timeout: 30_000 });
    }
  } else {
    await exec("xcrun", ["simctl", "launch", target.id, appId, ...lab, ...args], { timeout: 60_000 });
  }
}

export async function processAlive(target: Target, appId: string): Promise<boolean> {
  try {
    if (target.platform === "android") {
      const { stdout } = await exec(ADB, ["-s", target.id, "shell", "pidof", appId], { timeout: 15_000 });
      return stdout.trim().length > 0;
    }
    const { stdout } = await exec("xcrun", ["simctl", "spawn", target.id, "launchctl", "list"], { timeout: 15_000 });
    return stdout.includes(appId);
  } catch {
    return false;
  }
}

export async function batteryPct(target: Target): Promise<number | null> {
  try {
    if (target.platform === "android") {
      const { stdout } = await exec(ADB, ["-s", target.id, "shell", "dumpsys", "battery"], { timeout: 15_000 });
      const m = /level:\s*(\d+)/.exec(stdout);
      return m ? Number(m[1]) : null;
    }
    if (target.kind === "device") {
      // devicectl exposes battery via device info; the fleet runner's beacon
      // is the primary source on real iPhones — this is the host-side cross-check.
      const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "info.json");
      await exec("xcrun", ["devicectl", "device", "info", "details", "--device", target.id, "--json-output", out], { timeout: 30_000 });
      const txt = readFileSync(out, "utf8");
      const m = /"batteryLevel"\s*:\s*([0-9.]+)/.exec(txt);
      return m ? Math.round(Number(m[1]) * (Number(m[1]) <= 1 ? 100 : 1)) : null;
    }
    return null; // simulators have no battery
  } catch {
    return null;
  }
}
