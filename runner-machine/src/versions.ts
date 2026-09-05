/**
 * Version strings out of four tools that agree on nothing.
 *
 * `xcodebuild -version` prints two lines, `adb version` prints three, `gradle
 * --version` prints a banner with blank lines and box drawing in it, and
 * `node -v` prints `v22.14.0`. The parsing is pure so the shapes can be
 * asserted against real captured output without those tools installed — which
 * is the point, because a Linux box has no xcodebuild and a Mac in CI may have
 * no adb, and the self-check has to be right about both.
 *
 * A tool that is not installed is not a parse failure and not a check failure:
 * it is a skipped check. Only a tool that IS there and cannot be understood
 * returns null here, which the caller reports as a failed check, because a
 * `gradle` on PATH that prints nothing recognisable is a broken install.
 */

/**
 * `xcodebuild -version`:
 *   Xcode 16.2
 *   Build version 16C5032a
 * Both halves are kept: two machines on "Xcode 16.2" with different build
 * versions are two different compilers, and a build that reproduces on one and
 * not the other is exactly when somebody goes looking for this string.
 */
export function parseXcodebuildVersion(text: string | null): string | null {
  if (!text) return null;
  const ver = /Xcode\s+([0-9][0-9.]*)/i.exec(text)?.[1];
  if (!ver) return null;
  const build = /Build version\s+(\S+)/i.exec(text)?.[1];
  return build ? `${ver} (${build})` : ver;
}

/**
 * `adb version`:
 *   Android Debug Bridge version 1.0.41
 *   Version 35.0.2-12147458
 *   Installed as /path/to/adb
 * The platform-tools version on the second line is the one that matters —
 * `1.0.41` has been the protocol version for years and distinguishes nothing.
 */
export function parseAdbVersion(text: string | null): string | null {
  if (!text) return null;
  const tools = /^Version\s+(\S+)/im.exec(text)?.[1];
  if (tools) return tools;
  return /Android Debug Bridge version\s+(\S+)/i.exec(text)?.[1] ?? null;
}

/**
 * `gradle --version`, whose banner is mostly rules and blank lines:
 *   ------------------------------------------------------------
 *   Gradle 8.7
 *   ------------------------------------------------------------
 * The same shape comes back from `./gradlew --version`, which is what a repo
 * with a wrapper is actually built with.
 */
export function parseGradleVersion(text: string | null): string | null {
  if (!text) return null;
  return /^Gradle\s+([0-9][0-9.]*(?:-\S+)?)/im.exec(text)?.[1] ?? null;
}

/** `node -v` prints `v22.14.0`; the `v` is not part of the version. */
export function parseNodeVersion(text: string | null): string | null {
  if (!text) return null;
  return /v?([0-9]+\.[0-9]+\.[0-9]+(?:-\S+)?)/.exec(text.trim())?.[1] ?? null;
}

/**
 * `launchctl list <label>` prints a plist when the job is loaded and exits
 * non-zero with "Could not find service" when it is not. Loaded is not the
 * same as running: a job that crash-loops is listed with a PID of `-` and a
 * non-zero last exit status, and reporting that as healthy would make the
 * check useless for the one failure it exists to catch.
 */
export function parseLaunchctlList(text: string | null): { loaded: boolean; pid: number | null; lastExit: number | null } {
  if (!text) return { loaded: false, pid: null, lastExit: null };
  const pidRaw = /"PID"\s*=\s*(\d+)/.exec(text)?.[1];
  const exitRaw = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(text)?.[1];
  return {
    loaded: true,
    pid: pidRaw ? Number(pidRaw) : null,
    lastExit: exitRaw ? Number(exitRaw) : null,
  };
}

/**
 * `systemctl --user is-active <unit>` answers one word: `active`, `inactive`,
 * `failed`, `activating`, or `unknown` for a unit that does not exist. Only
 * `active` is loaded-and-running; `activating` is counted as healthy because a
 * unit restarting after a `RestartSec=10` backoff is the agent doing exactly
 * what its unit file says.
 */
export function parseSystemctlIsActive(text: string | null): { loaded: boolean; state: string | null } {
  const state = text?.trim().split(/\s+/)[0] ?? null;
  if (!state || state === "unknown") return { loaded: false, state };
  return { loaded: state === "active" || state === "activating", state };
}
