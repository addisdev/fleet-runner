/**
 * Reading the lock screen from `dumpsys window`, with no device.
 *
 * The locked sample is the Galaxy S8+ on fleet-host (Android 9) on 2026-10-18,
 * after `input keyevent KEYCODE_WAKEUP` and `wm dismiss-keyguard`: its PIN pad
 * kept focus. Run from scripts/smoke.ts like the other decision checks.
 */
import { screenLocked } from "./device.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const S8_PIN = [
  "    mShowingDream=false mDreamingLockscreen=true mDreamingSleepToken=null",
  "    mStatusBar=Window{a9c474 u0 StatusBar} isStatusBarKeyguard=true",
  "  mCurrentFocus=Window{7f53de3 u0 Bouncer}",
].join("\n");

const UNLOCKED = [
  "    mShowingDream=false mDreamingLockscreen=false mDreamingSleepToken=null",
  "    mStatusBar=Window{a9c474 u0 StatusBar} isStatusBarKeyguard=false",
  "  mCurrentFocus=Window{1b2c3d4 u0 dev.fleetrunner.buggarden/dev.fleetrunner.buggarden.MainActivity}",
].join("\n");

// The notification shade pulled down on an unlocked phone also focuses the
// status bar; that is not a lock.
const SHADE = [
  "    mShowingDream=false mDreamingLockscreen=false mDreamingSleepToken=null",
  "    isStatusBarKeyguard=false",
  "  mCurrentFocus=Window{a9c474 u0 StatusBar}",
].join("\n");

export function runDeviceChecks(check: Check) {
  check("lock screen: the S8+ with a PIN reads as locked", screenLocked(S8_PIN));
  check("lock screen: an app in front reads as unlocked", !screenLocked(UNLOCKED));
  check("lock screen: the notification shade is not a lock", !screenLocked(SHADE));
  check("lock screen: a keyguard window in focus alone is enough", screenLocked("  mCurrentFocus=Window{9 u0 Keyguard}"));
  check("lock screen: AOSP's showing flag alone is enough", screenLocked("    mShowingLockscreen=true mShowingDream=false"));
  check("lock screen: nothing to go on reads as unlocked (an emulator, or another dump format)", !screenLocked(""));
}
