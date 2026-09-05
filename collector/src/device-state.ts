/**
 * Device settings a job changes and must put back: locale, and the display
 * settings an accessibility pass runs under.
 *
 * This is network-shape.ts's discipline applied to a second class of state, and
 * it exists for the same reason. A phone left in Arabic by a job that never
 * reached its restore is not obviously broken -- it stays online, it answers
 * adb, it runs the next job -- so nothing anywhere reports it, and the next
 * screenshot suite quietly produces a set of baselines in the wrong language.
 * A phone left at 2x font scale in dark mode is the same failure with a
 * different symptom. Somebody eventually fixes it by hand, having first spent
 * an afternoon not knowing what happened.
 *
 * So the two rules from network-shape hold here without exception:
 *
 *   - the intent is journalled to disk BEFORE the device is touched, so a crash
 *     between the two is still recoverable;
 *   - `restoreAttachedState` runs at executor startup, before any job is
 *     claimed, and a restore that cannot be verified KEEPS its journal entry so
 *     the next startup tries again instead of forgetting.
 *
 * And one rule of its own. Every setting this module can write is a member of a
 * CLOSED vocabulary, with its reader and its writer defined right here. The
 * obvious shortcut -- journalling the argv needed to undo a change and running
 * it back at startup -- turns a file in the home directory into something the
 * executor executes at boot, which is a worse thing to own than the problem it
 * solves.
 *
 * What is NOT reachable, and is refused rather than faked:
 *
 *   a physical iPhone -- nothing in devicectl sets a language, a text size, an
 *     appearance or a bold-text preference, and no supported tool writes to
 *     another device's preference domain. The reachable path is per-launch:
 *     an XCUITest passing `-AppleLanguages` in `launchArguments`, which lives in
 *     the iOS runner's test bundle, not here. Callers get an error naming that,
 *     because the alternative -- running every locale against one unchanged
 *     device -- produces a full set of screenshots that are all the same
 *     language and all labelled differently.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, log } from "./fleet-client.js";

/** Same default and env var as the executor's; this module is used alongside it. */
const ADB = process.env.ADB_BIN ?? "adb";

/** Same home as the shaping journal, and for the same reason: it has to outlive a reboot. */
const STATE_DIR = process.env.FLEET_STATE_DIR ?? path.join(os.homedir(), ".fleet");
const JOURNAL = path.join(STATE_DIR, "device-state.json");

/** The subset of a Target this module needs; structurally the executor's. */
export type StateTarget = { id: string; platform: "android" | "ios"; kind?: "device" | "simulator" };

/** Which group of settings an entry belongs to, so two jobs can journal independently. */
export type Domain = "locale" | "display";
export const DOMAINS: Domain[] = ["locale", "display"];

/**
 * Every setting this module knows how to read, write and undo.
 *
 * Adding one means adding its reader and its writer below, which is the point:
 * a name with no writer cannot be journalled, so nothing can be left applied
 * that this module does not know how to take back.
 */
export const SETTINGS = [
  "android:system.system_locales",
  "android:system.font_scale",
  "android:secure.font_weight_adjustment",
  "android:uimode.night",
  "ios:defaults.AppleLanguages",
  "ios:defaults.AppleLocale",
  "ios:ui.appearance",
  "ios:ui.content_size",
] as const;
export type SettingName = (typeof SETTINGS)[number];

export function isSettingName(s: string): s is SettingName {
  return (SETTINGS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Pure read-back parsers
// ---------------------------------------------------------------------------

/**
 * `adb shell settings get <ns> <key>`.
 *
 * The literal four characters `null` are how the settings provider says "unset",
 * and they arrive as ordinary stdout. Reading them as the STRING "null" and
 * journalling that is how a restore later writes the word null into a device's
 * locale, which is worse than the state it was repairing.
 */
export function parseAndroidSettingValue(out: string): string | null {
  const v = out.replace(/\r/g, "").trim();
  return v === "" || v === "null" ? null : v;
}

/** `adb shell cmd uimode night` -> `Night mode: no`. */
export function parseUiModeNight(out: string): string | null {
  const m = /Night mode:\s*(\S+)/i.exec(out.replace(/\r/g, ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * `defaults read -g AppleLanguages`, whose answer is an old-style plist array:
 *
 *     (
 *         "en-US",
 *         fr
 *     )
 *
 * Quoting is optional and inconsistent -- a tag with a hyphen is quoted, a bare
 * two-letter one usually is not -- so both forms are accepted. The domain being
 * absent is not a parse failure but the ordinary state of a fresh simulator, and
 * it answers with a sentence rather than an array; null is the honest reading,
 * and it is what makes a restore DELETE the key rather than write an empty list.
 */
export function parseDefaultsArray(out: string): string[] | null {
  const text = out.replace(/\r/g, "");
  if (/does not exist/i.test(text)) return null;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const items = text.slice(open + 1, close)
    .split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1").trim())
    .filter((s) => s !== "");
  return items.length > 0 ? items : null;
}

/** `defaults read -g AppleLocale` -> a bare scalar, or absent. */
export function parseDefaultsString(out: string): string | null {
  const text = out.replace(/\r/g, "").trim();
  if (text === "" || /does not exist/i.test(text)) return null;
  return text.replace(/^"(.*)"$/, "$1");
}

/**
 * `xcrun simctl ui <udid> appearance` / `content_size`, which print the current
 * value when given no new one.
 *
 * An Xcode too old for the option answers on stdout with a usage message and
 * still exits zero on some versions, so anything that does not look like a value
 * is null rather than being handed back as one. A run that "verified" its
 * appearance change against the string "Usage: simctl ui" is a run that
 * screenshotted light mode and filed it as dark.
 */
export function parseSimctlUiValue(out: string): string | null {
  const ls = out.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  // The whole output is checked for a complaint before any of it is read as a
  // value. Scanning backwards for the first value-shaped line finds one inside
  // a usage message -- simctl's own help lists `content_size` and `appearance`
  // one per line -- and hands back an option NAME as if it were the device's
  // current setting.
  if (ls.some((l) => /^(usage|error|invalid|unknown|unrecognized|no devices)\b/i.test(l))) return null;
  for (let i = ls.length - 1; i >= 0; i--) {
    const m = /^(?:[\w_]+:\s*)?([A-Za-z][\w-]*)$/.exec(ls[i]);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export type StateEntry = {
  domain: Domain;
  platform: "android" | "ios";
  kind?: "device" | "simulator";
  applied_at: string;
  /** What each setting was BEFORE we touched it. null means it was unset. */
  prior: Partial<Record<SettingName, string | null>>;
  /** What we set it to. Kept for the log, never used to decide a restore. */
  wanted?: Partial<Record<SettingName, string>>;
};

type Journal = { schema: 1; entries: Record<string, StateEntry> };

const keyOf = (domain: Domain, id: string) => `${domain}:${id}`;

function readJournal(): Journal {
  try {
    const j = JSON.parse(readFileSync(JOURNAL, "utf8")) as Journal;
    if (j && typeof j === "object" && j.entries) return { schema: 1, entries: j.entries };
  } catch {
    // No journal, or an unreadable one. Either way there is nothing to recover.
  }
  return { schema: 1, entries: {} };
}

function writeJournal(j: Journal) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(JOURNAL, JSON.stringify(j, null, 2) + "\n");
}

function journalPut(domain: Domain, id: string, e: StateEntry) {
  const j = readJournal();
  j.entries[keyOf(domain, id)] = e;
  writeJournal(j);
}

function journalDrop(domain: Domain, id: string) {
  const j = readJournal();
  const k = keyOf(domain, id);
  if (!(k in j.entries)) return;
  delete j.entries[k];
  writeJournal(j);
}

function journalGet(domain: Domain, id: string): StateEntry | undefined {
  return readJournal().entries[keyOf(domain, id)];
}

// ---------------------------------------------------------------------------
// Readers and writers, one pair per setting name
// ---------------------------------------------------------------------------

function androidNamespace(name: SettingName): { ns: string; key: string } | null {
  const m = /^android:(system|secure|global)\.(.+)$/.exec(name);
  return m ? { ns: m[1], key: m[2] } : null;
}

/** Why this target cannot hold managed state at all, or null when it can. */
export function unmanageableReason(t: StateTarget): string | null {
  if (t.platform === "android") return null;
  if (t.kind === "simulator") return null;
  return (
    `${t.id} is a physical iPhone: nothing in devicectl sets its language, text size, appearance or ` +
    "bold-text preference, and no supported tool writes to another device's preference domain. " +
    "The reachable path is per-launch -- an XCUITest setting launchArguments (-AppleLanguages, " +
    "-UIPreferredContentSizeCategoryName) on XCUIApplication -- which lives in the iOS runner's test " +
    "bundle, not in this executor"
  );
}

async function readSetting(t: StateTarget, name: SettingName): Promise<string | null> {
  const android = androidNamespace(name);
  if (android) {
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "settings", "get", android.ns, android.key], { timeout: 15_000 });
    return parseAndroidSettingValue(stdout);
  }
  if (name === "android:uimode.night") {
    const { stdout } = await exec(ADB, ["-s", t.id, "shell", "cmd", "uimode", "night"], { timeout: 15_000 });
    return parseUiModeNight(stdout);
  }
  if (name === "ios:defaults.AppleLanguages") {
    const out = await simctlDefaults(t, ["read", "-g", "AppleLanguages"]);
    const arr = parseDefaultsArray(out);
    return arr ? arr.join(",") : null;
  }
  if (name === "ios:defaults.AppleLocale") {
    return parseDefaultsString(await simctlDefaults(t, ["read", "-g", "AppleLocale"]));
  }
  // simctl ui: appearance / content_size
  const opt = name === "ios:ui.appearance" ? "appearance" : "content_size";
  const { stdout } = await exec("xcrun", ["simctl", "ui", t.id, opt], { timeout: 20_000 });
  return parseSimctlUiValue(stdout);
}

/** `defaults` inside the simulator, tolerating the "does not exist" exit status. */
async function simctlDefaults(t: StateTarget, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("xcrun", ["simctl", "spawn", t.id, "defaults", ...args], { timeout: 30_000 });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    // An absent key is an ordinary answer with a non-zero status, and it is the
    // one a fresh simulator always gives.
    if (/does not exist/i.test(text)) return "does not exist";
    throw new Error(`simctl spawn defaults ${args.join(" ")} failed: ${(err.stderr ?? err.message ?? "").trim().slice(0, 200)}`);
  }
}

async function writeSetting(t: StateTarget, name: SettingName, value: string | null): Promise<void> {
  const android = androidNamespace(name);
  if (android) {
    if (value === null) {
      await exec(ADB, ["-s", t.id, "shell", "settings", "delete", android.ns, android.key], { timeout: 20_000 });
    } else {
      await exec(ADB, ["-s", t.id, "shell", "settings", "put", android.ns, android.key, value], { timeout: 20_000 });
    }
    return;
  }
  if (name === "android:uimode.night") {
    // There is no "unset" for night mode; `no` is the platform default and the
    // state every device in the fleet is expected to sit in.
    await exec(ADB, ["-s", t.id, "shell", "cmd", "uimode", "night", value ?? "no"], { timeout: 20_000 });
    return;
  }
  if (name === "ios:defaults.AppleLanguages") {
    if (value === null) await simctlDefaults(t, ["delete", "-g", "AppleLanguages"]);
    else await simctlDefaults(t, ["write", "-g", "AppleLanguages", "-array", ...value.split(",")]);
    return;
  }
  if (name === "ios:defaults.AppleLocale") {
    if (value === null) await simctlDefaults(t, ["delete", "-g", "AppleLocale"]);
    else await simctlDefaults(t, ["write", "-g", "AppleLocale", "-string", value]);
    return;
  }
  const opt = name === "ios:ui.appearance" ? "appearance" : "content_size";
  // simctl ui has no "unset" either; the caller journals the value it read, and
  // that value is what goes back.
  if (value === null) return;
  await exec("xcrun", ["simctl", "ui", t.id, opt, value], { timeout: 20_000 });
}

/** Two values are the same setting when they normalise the same way. */
function sameValue(a: string | null, b: string | null): boolean {
  const n = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/_/g, "-");
  return n(a) === n(b);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Apply a group of settings to one target, journalling first and verifying
 * after.
 *
 * The verification is not ceremony. `settings put` exits 0 on a device whose
 * shell may not write that namespace, `simctl ui` exits 0 on an Xcode that does
 * not know the option, and both leave the device exactly as it was. A
 * screenshot taken after either one is a screenshot of the wrong thing, filed
 * under the right name -- which is the failure this whole module exists to
 * prevent, so a setting that did not take throws after putting back whatever
 * did.
 *
 * One caveat is stated here because it cannot be checked here: read-back proves
 * the SETTING changed, not that anything consumed it.
 * `secure font_weight_adjustment` is writable on every Android, and only
 * Android 12 and later reads it. The caller has to gate on the platform
 * version; see `androidSupports` in the executor.
 */
export async function applyState(
  t: StateTarget,
  domain: Domain,
  wanted: Partial<Record<SettingName, string>>,
): Promise<void> {
  const why = unmanageableReason(t);
  if (why) throw new Error(why);

  const names = Object.keys(wanted) as SettingName[];
  if (names.length === 0) return;
  for (const n of names) if (!isSettingName(n)) throw new Error(`unknown device setting ${n}`);

  const prior: Partial<Record<SettingName, string | null>> = {};
  for (const n of names) {
    try {
      prior[n] = await readSetting(t, n);
    } catch (e) {
      throw new Error(`cannot read ${n} on ${t.id}, so it cannot be safely changed: ${(e as Error).message.slice(0, 200)}`);
    }
    // `simctl ui` has no way to unset a value, so the prior IS the only way
    // back. A null prior means simctl answered with something that is not a
    // value -- a usage message from an Xcode that does not know the option --
    // and applying anyway would journal an entry no restore could ever satisfy:
    // the device would stay changed and every startup sweep would fail on it
    // forever.
    if (prior[n] === null && (n === "ios:ui.appearance" || n === "ios:ui.content_size")) {
      throw new Error(
        `simctl could not report the current ${n.split(".")[1]} on ${t.id}, and there is no way to unset one, ` +
        "so setting it could not be undone -- refusing rather than changing a simulator permanently",
      );
    }
  }

  // Before the device is touched. A crash between these two lines still leaves
  // a record that this device needs repair.
  journalPut(domain, t.id, {
    domain, platform: t.platform, kind: t.kind,
    applied_at: new Date().toISOString(),
    prior, wanted,
  });

  for (const n of names) {
    try {
      await writeSetting(t, n, wanted[n]!);
    } catch (e) {
      await restoreState(t, domain).catch(() => {});
      throw new Error(`could not set ${n} on ${t.id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // Read back every one of them. A partial application is the worst outcome:
  // half the intended condition, reported as all of it.
  for (const n of names) {
    let got: string | null = null;
    try {
      got = await readSetting(t, n);
    } catch (e) {
      await restoreState(t, domain).catch(() => {});
      throw new Error(`could not verify ${n} on ${t.id}: ${(e as Error).message.slice(0, 200)}`);
    }
    if (!sameValue(got, wanted[n]!)) {
      await restoreState(t, domain).catch(() => {});
      throw new Error(
        `${n} did not take on ${t.id}: asked for ${wanted[n]}, the device still reports ` +
        `${got ?? "nothing"} -- refusing to run as if it had`,
      );
    }
  }
}

/**
 * Put one domain's settings back on one target, verified.
 *
 * Safe to call on a target that was never changed: no journal entry, no work,
 * false. A restore that cannot be verified throws with the entry LEFT IN PLACE,
 * so the next startup sweep tries again rather than forgetting that this device
 * was left in Arabic.
 *
 * Returns true when the device actually needed repair.
 */
export async function restoreState(t: StateTarget, domain: Domain): Promise<boolean> {
  const entry = journalGet(domain, t.id);
  if (!entry) return false;
  if (unmanageableReason(t)) {
    // Should not happen -- applyState refuses these -- but a journal outlives
    // the code that wrote it, and dropping the entry silently would be worse.
    throw new Error(`${t.id} has journalled ${domain} state but cannot be written to`);
  }

  const names = Object.keys(entry.prior) as SettingName[];
  let changed = false;
  const problems: string[] = [];

  for (const n of names) {
    const want = entry.prior[n] ?? null;
    let now: string | null = null;
    try {
      now = await readSetting(t, n);
    } catch (e) {
      problems.push(`${n} unreadable (${(e as Error).message.slice(0, 120)})`);
      continue;
    }
    if (sameValue(now, want)) continue;
    changed = true;
    try {
      await writeSetting(t, n, want);
      const after = await readSetting(t, n);
      if (!sameValue(after, want)) problems.push(`${n} is still ${after ?? "unset"}, wanted ${want ?? "unset"}`);
    } catch (e) {
      problems.push(`${n} could not be written (${(e as Error).message.slice(0, 120)})`);
    }
  }

  if (problems.length > 0) {
    // Keep the entry. The next sweep must try again.
    throw new Error(`${t.id} is not fully restored (${domain}): ${problems.join("; ")}`);
  }
  journalDrop(domain, t.id);
  return changed;
}

/**
 * Run `fn` with `wanted` applied to this target, and put the device back
 * whatever happens inside.
 *
 * The finally is the entire point of the wrapper existing, exactly as it is in
 * withNetwork: every path that changes a device must restore it, including the
 * ones that throw, and including the ones that throw inside a loop over several
 * locales.
 */
export async function withState<T>(
  t: StateTarget,
  domain: Domain,
  wanted: Partial<Record<SettingName, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  await applyState(t, domain, wanted);
  try {
    return await fn();
  } finally {
    await restoreState(t, domain).catch((e) =>
      log(`device-state: restoring ${domain} on ${t.id} failed: ${(e as Error).message}`));
  }
}

/**
 * Startup repair: put every attached device back before this executor claims
 * anything.
 *
 * The same sweep network-shape does, for the same reason and with the same
 * caveat about devices that are not here: an entry for a phone that is
 * currently unplugged STAYS, because that phone is still in Arabic wherever it
 * is, and forgetting is how it becomes somebody's afternoon.
 */
export async function restoreAttachedState(targets: StateTarget[]): Promise<string[]> {
  const repaired: string[] = [];
  const entries = readJournal().entries;
  const journalledIds = new Set(Object.entries(entries).map(([k, e]) => k.slice(e.domain.length + 1)));

  for (const t of targets) {
    for (const domain of DOMAINS) {
      try {
        if (await restoreState(t, domain)) {
          if (!repaired.includes(t.id)) repaired.push(t.id);
          log(`device-state: ${t.id} was left with ${domain} settings changed by an earlier run; put back`);
        }
      } catch (e) {
        log(`device-state: ${t.id} needs manual repair (${domain}): ${(e as Error).message}`);
      }
    }
  }

  const absent = [...journalledIds].filter((id) => !targets.some((t) => t.id === id));
  if (absent.length > 0) {
    log(
      `device-state: ${absent.length} device(s) changed by an earlier run are not attached now and stay ` +
      `journalled until they are: ${absent.join(", ")}`,
    );
  }
  return repaired;
}
