/**
 * A driver is a way of reaching devices. Discovery is a list of them.
 *
 * Before this existed, `listTargets()` in executor.ts called three functions by
 * name, hard-coded the platform each one produced, and concatenated the
 * results. That shape has one cost and it only shows up when you try to add a
 * platform: every new way of reaching a device — a TV over adb is fine, but a
 * browser tab, a machine over ssh, a WebDriver session — is an edit to a
 * function in the middle of a 3,000-line file that also runs the fleet.
 *
 * So discovery is a registry, and a driver is a file. Adding one is adding a
 * module and one line to `DRIVERS`; nothing else in the executor learns about
 * it. Which is the same bargain `workloads/registry.ts` already made for the
 * handlers, for the same reason.
 *
 * ## The two rules a driver obeys
 *
 * **`list()` never throws.** A host with no Xcode has no simctl, and a host
 * with no Android SDK has no adb; both are ordinary and neither is an error.
 * A driver that cannot see anything returns `[]`. This is not defensive
 * padding — it is what lets one executor binary run on a Mac with everything
 * installed and on a Linux box with nothing, without either configuring or
 * apologising.
 *
 * The exception, and it is deliberate: a tool that IS present and IS failing
 * must be noticed. `adb` returning ENOENT is an iOS-only host; `adb` returning
 * anything else means a broken daemon, and reporting `[]` for that empties the
 * Android shelf silently. The adb driver keeps the complaint that already
 * existed for exactly this.
 *
 * **A driver names the platform it found, and does not invent one.** The old
 * code labelled every booted simulator `ios` and every devicectl device `ios`,
 * because at the time both were true. Both tools have always reported the real
 * platform; nobody was reading it. A driver that cannot tell should return
 * nothing rather than guess, because a guess here becomes a row in a
 * comparison table.
 */
import type { Target } from "../workloads/types.js";

export type Driver = {
  /** How a Target refers to this driver, and how a log line names it. */
  name: string;
  /**
   * One line for the startup log: what this driver reaches. Read by a person
   * wondering why their phone is not showing up.
   */
  describes: string;
  /**
   * Everything this driver can see right now. Never throws; returns [] when
   * the underlying tool is absent.
   */
  list(): Promise<Target[]>;
  /**
   * Put a build on a target. Absent on a driver that cannot install, which is
   * a real case rather than an oversight — a driver may exist only to make a
   * device visible and schedulable.
   *
   * `file` is a path on this host: an APK, or an unpacked .app bundle.
   */
  install?(target: Target, file: string): Promise<void>;
  /**
   * Point an already-installed runner at a collector, without anybody typing.
   *
   * The enrolment screen has always said the hard part is typing an address on
   * a touch keyboard without a typo. A QR code solves that for a phone, because
   * a phone has a camera. It solves nothing for a television, which has neither
   * a camera nor a keyboard worth using, and a Roku remote has no text entry
   * beyond an on-screen grid.
   *
   * So the brain reaches the device instead. Every platform already has a way
   * to hand a launching app a parameter -- an intent extra, an environment
   * variable, a URL scheme, a query string -- and this is that, per driver.
   *
   * Absent on a driver that has no such mechanism, which is a real case rather
   * than an oversight. `enrol` reports "this driver cannot" as a result row per
   * device, which is the honest answer and tells the operator to use the QR
   * code instead.
   */
  enrol?(target: Target, opts: { url: string; deviceId?: string }): Promise<void>;
};
