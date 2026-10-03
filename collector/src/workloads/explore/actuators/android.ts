/**
 * Reaching an Android device over adb: phones and tablets by touch, Fire TV
 * and Android TV by D-pad.
 *
 * One class for both, because the tool is the same and only the way in
 * differs. A TV gets `surface: "dpad"`, which changes what the loop offers the
 * model (keys, no taps) and makes `observe` describe where focus is; every
 * shell-out underneath is identical.
 *
 * Screenshot pixels and device pixels are the same thing here -- screencap
 * captures the display at its own resolution, and uiautomator reports bounds
 * in the same pixels -- so nothing is converted. That is not true on iOS, and
 * it is the reason types.ts states the coordinate rule once for everybody.
 *
 * The parsers are exported and pure, and live at the top of the file, so the
 * part of this that decides what a crash is, what is in front, and how text is
 * escaped for `input text` can be tested without a phone.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exec } from "../../../fleet-client.js";
import { parseAndroidDensity, parseUiautomatorDump, type A11yNode } from "../../../a11y-tree.js";
import { parseCrashLogcat } from "../../../soak-samples.js";
import { ADB } from "../../device.js";
import type { Target } from "../../types.js";
import type { Action, Actuator, ActuatorCaps, CrashReport, Key, Observation } from "../types.js";

/** execFile with Buffer output. The promisified string form corrupts binary stdout. */
const execBuf = promisify(execFile) as unknown as (
  cmd: string, args: string[], opts: { timeout: number; maxBuffer: number; encoding: "buffer" },
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Android keycodes for the cross-platform key names. */
export const ANDROID_KEYCODES: Record<Key, number> = {
  up: 19, down: 20, left: 21, right: 22, select: 23,
  back: 4, home: 3, menu: 82, play_pause: 85, rewind: 89, fast_forward: 90,
  enter: 66, search: 84,
};

/** A PNG's width and height from its IHDR chunk, or null if it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Text for `adb shell input text`, which goes through the device's shell and
 * then through `input`'s own parser.
 *
 * `input text` turns `%s` into a space and nothing else into anything, so a
 * space has to become `%s`; and the device shell sees the argument, so every
 * character the shell treats specially is backslash-escaped. Non-ASCII cannot
 * be typed this way at all (`input` sends key events from the device's key
 * character map, which is ASCII), and is reported rather than silently
 * dropped: an explorer that types "Café" and gets "Caf" would file the
 * missing letter as the app's bug.
 */
export function escapeInputText(text: string): { ok: true; arg: string } | { ok: false; reason: string } {
  if (/[^\x20-\x7e]/.test(text)) {
    return { ok: false, reason: "adb's `input text` can only type printable ASCII; this text has other characters" };
  }
  const arg = text
    .replace(/[\\'"`$&|;<>()*?!#~^[\]{}]/g, (c) => `\\${c}`)
    .replace(/ /g, "%s");
  return { ok: true, arg };
}

/**
 * The package in front, from `dumpsys window`.
 *
 * mCurrentFocus names the focused WINDOW, which is a dialog or the keyboard as
 * often as an activity; mFocusedApp names the activity whose task is in front,
 * which is the question being asked. Both are read, app first.
 */
export function parseForeground(dumpsysWindow: string): string | null {
  // `dumpsys window` OPENS with the "LAST ANR" section, a frozen copy of the
  // window state at the last ANR -- mFocusedApp included. Read first, it names
  // whatever was in front minutes ago: on the dozehound-tv AVD it reported
  // Dozehound while the Google TV launcher was in front, after an ANR. So that
  // section is cut out before anything is matched. The snapshot carries its
  // own "DISPLAY CONTENTS" header, so it runs to the POLICY STATE section that
  // always follows it, not to the next header of any kind.
  const raw = dumpsysWindow.replace(/\r/g, "");
  const text = raw.includes("\nWINDOW MANAGER POLICY STATE")
    ? raw.replace(/WINDOW MANAGER LAST ANR[\s\S]*?(?=\nWINDOW MANAGER POLICY STATE)/, "")
    : raw.replace(/WINDOW MANAGER LAST ANR[\s\S]*?(?=\nWINDOW MANAGER |$)/, "");
  const app = /mFocusedApp=.*?\s([\w.]+)\/[\w.$]+/.exec(text);
  if (app) return app[1];
  const focus = /mCurrentFocus=Window\{[^}]*\s([\w.]+)\/[\w.$]+/.exec(text);
  if (focus) return focus[1];
  return null;
}

/** Whether the soft keyboard is showing, from `dumpsys input_method`. */
export function parseImeShown(dumpsysIme: string): boolean | null {
  const m = /mInputShown=(true|false)/.exec(dumpsysIme) ?? /isInputViewShown=(true|false)/.exec(dumpsysIme);
  return m ? m[1] === "true" : null;
}

/**
 * ANRs for one package in the events buffer: `am_anr` lines name the process.
 * A frozen app that never reaches the ANR dialog is the frozen-screen check's
 * job, not this one's.
 */
export function parseAnrEvents(events: string, pkg: string): string[] {
  const out: string[] = [];
  for (const l of events.replace(/\r/g, "").split("\n")) {
    if (!/\bam_anr\b/.test(l) || !l.includes(pkg)) continue;
    const reason = /,([^,\]]+)\]\s*$/.exec(l)?.[1]?.trim() ?? "Application Not Responding";
    out.push(`ANR: ${reason}`.slice(0, 160));
  }
  return out;
}

/**
 * Where focus is, as one line a model can read.
 *
 * The focused node, plus the labels of the containers it sits in (the nearest
 * shallower nodes whose bounds hold it), outermost first. A TV model that
 * knows "Home > Featured row > 'Rain on the porch'" is focused can decide
 * which arrow to press; a model shown only the picture has to find a 2-pixel
 * highlight ring, which is where click-trained models fail (TVWorld, 2026).
 */
export function focusLine(nodes: A11yNode[] | null): string | null {
  if (!nodes) return null;
  const i = nodes.findIndex((n) => n.focused);
  if (i < 0) return "nothing has focus";
  const name = (n: A11yNode) => (focusedText(nodes) || n.id.split("/").pop() || n.cls.split(".").pop() || "?").trim();
  const f = nodes[i];
  const chain: string[] = [];
  let depth = f.depth;
  for (let j = i - 1; j >= 0 && depth > 0; j--) {
    const n = nodes[j];
    if (n.depth >= depth) continue;
    depth = n.depth;
    const label = n.label || n.text;
    if (label && f.bounds && n.bounds && contains(n.bounds, f.bounds)) chain.unshift(label.trim());
  }
  const where = f.bounds ? ` at ${f.bounds.x},${f.bounds.y} ${f.bounds.w}x${f.bounds.h}` : "";
  return [...chain, `'${name(f)}' (focused${where})`].join(" > ");
}

/**
 * What the focused element says, as a person would read it off the screen.
 *
 * Its own label or text when it has one. Compose usually gives it neither: a
 * `Modifier.focusable()` tile is an unlabelled View whose words are in the
 * Text children nested inside it (Dozehound's channel tiles are exactly this:
 * the focused node is a bare View, "Meadow" is its child). So the fallback is
 * the text of the nodes after it in the dump that are deeper and inside its
 * bounds -- its descendants -- joined, the title first. Without this the
 * focus line on a Compose TV app reads `'View' (focused ...)` on every
 * screen, and a model is back to finding a highlight ring in the picture.
 */
export function focusedText(nodes: A11yNode[] | null): string {
  if (!nodes) return "";
  const i = nodes.findIndex((n) => n.focused);
  if (i < 0) return "";
  const f = nodes[i];
  const own = (f.label || f.text || "").trim();
  if (own) return own;
  // A focused node the size of the whole window is the app's root holding
  // focus (Dozehound's player does, whenever its bar is closed). Everything on
  // screen is "inside" it, so borrowing its children's text would name the
  // focus after a banner. It stays unnamed.
  const screen = nodes[0]?.bounds;
  if (screen && f.bounds && f.bounds.w >= screen.w && f.bounds.h >= screen.h) return "";
  const parts: string[] = [];
  for (let j = i + 1; j < nodes.length && nodes[j].depth > f.depth; j++) {
    const n = nodes[j];
    const t = (n.label || n.text || "").trim();
    if (t && (!f.bounds || !n.bounds || contains(f.bounds, n.bounds))) parts.push(t);
  }
  const joined = parts.join(" / ");
  return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined;
}

const contains = (o: NonNullable<A11yNode["bounds"]>, i: NonNullable<A11yNode["bounds"]>) =>
  i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;

/**
 * Launch arguments to `am start` extras.
 *
 * Android has no process arguments, so a mission's `launch_args` arrive as
 * `key=value` strings and become string extras (`--es key value`). Anything
 * else is refused by name, so a mission written for iOS (-uiTestSignedOut)
 * fails loudly on Android instead of launching a different app state quietly.
 */
export function launchExtras(args: string[] = []): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = /^([A-Za-z_][\w.]*)=(.*)$/.exec(a);
    if (!m) throw new Error(`launch argument ${JSON.stringify(a)} is not key=value; Android launches take string extras only`);
    out.push("--es", m[1], m[2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The actuator
// ---------------------------------------------------------------------------

export type AndroidActuatorOptions = {
  /** "dpad" for a TV. Default: decided from the device (leanback feature). */
  surface?: "touch" | "dpad";
  log?: (msg: string) => void;
};

export class AndroidActuator implements Actuator {
  readonly target: Target;
  caps: ActuatorCaps;
  private log: (m: string) => void;
  private crashBaseline: number | null = null;
  private anrBaseline: number | null = null;
  private appId: string | null = null;

  constructor(target: Target, opts: AndroidActuatorOptions = {}) {
    this.target = target;
    this.log = opts.log ?? (() => {});
    this.caps = AndroidActuator.capsFor(opts.surface ?? "touch");
  }

  static capsFor(surface: "touch" | "dpad"): ActuatorCaps {
    return surface === "dpad"
      ? { surface, keys: ["up", "down", "left", "right", "select", "back", "home", "menu", "play_pause", "rewind", "fast_forward", "search"], tree: true, foreground: true }
      : { surface, keys: ["back", "home", "enter"], tree: true, foreground: true };
  }

  /**
   * Is this a TV? Android TV and Fire TV both declare leanback; a phone never
   * does. Asked once, by the caller, when the mission did not say.
   */
  static async isTv(target: Target): Promise<boolean> {
    try {
      const { stdout } = await exec(ADB, ["-s", target.id, "shell", "pm", "list", "features"], { timeout: 15_000 });
      return /android\.software\.leanback\b|android\.hardware\.type\.television\b/.test(stdout);
    } catch {
      return false;
    }
  }

  private shell(args: string[], timeout = 20_000) {
    return exec(ADB, ["-s", this.target.id, "shell", ...args], { timeout, maxBuffer: 32 * 1024 * 1024 });
  }

  async reset(appId: string, opts: { file?: string; launchArgs?: string[] } = {}): Promise<void> {
    this.appId = appId;
    await this.shell(["am", "force-stop", appId]).catch(() => {});
    if (opts.file) {
      // -g grants every runtime permission the manifest asks for, so the
      // explorer starts where a returning user is rather than spending its
      // first steps on dialogs it will see every night.
      await exec(ADB, ["-s", this.target.id, "install", "-r", "-g", opts.file], { timeout: 180_000 });
    }
    await this.shell(["pm", "clear", appId], 30_000);
    // Clearing data also clears the crash baseline's meaning: whatever the
    // buffer holds now is history.
    this.crashBaseline = null;
    this.anrBaseline = null;
    await this.crashes(appId);
    await this.shell(["input", "keyevent", "3"]).catch(() => {});
    await this.launch(appId, opts.launchArgs);
  }

  async launch(appId: string, launchArgs: string[] = []): Promise<void> {
    this.appId = appId;
    const extras = launchExtras(launchArgs);
    let component = "";
    try {
      const { stdout } = await this.shell(["cmd", "package", "resolve-activity", "--brief", appId]);
      component = stdout.replace(/\r/g, "").trim().split("\n").pop()?.trim() ?? "";
    } catch { /* fall through to the leanback query and then monkey */ }
    if (!component.includes("/")) {
      // A TV app's launcher activity is in the LEANBACK_LAUNCHER category,
      // which resolve-activity's default (LAUNCHER) does not find.
      try {
        const { stdout } = await this.shell(["cmd", "package", "resolve-activity", "--brief",
          "-c", "android.intent.category.LEANBACK_LAUNCHER", appId]);
        component = stdout.replace(/\r/g, "").trim().split("\n").pop()?.trim() ?? "";
      } catch { /* monkey below */ }
    }
    if (component.includes("/")) {
      await this.shell(["am", "start", "-n", component, ...extras], 30_000);
    } else {
      if (extras.length) throw new Error(`cannot resolve ${appId}'s launcher activity, and monkey cannot pass extras`);
      await this.shell(["monkey", "-p", appId, "-c", "android.intent.category.LAUNCHER", "1"], 30_000);
    }
    await sleep(1500);
  }

  async observe(): Promise<Observation> {
    // The picture and the tree are taken at once, not one after the other.
    // On a 1080p Android TV emulator playing video, screencap takes ~1.7 s and
    // uiautomator ~3.4 s; in sequence that is over five seconds a step, and
    // Dozehound's channel bar hides itself after six seconds without a key --
    // so an explorer that looked in sequence never saw the bar it had opened.
    const [shot, treeResult] = await Promise.all([
      execBuf(ADB, ["-s", this.target.id, "exec-out", "screencap", "-p"],
        { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }),
      this.tree().then((n) => ({ nodes: n, error: null }), (e: Error) => ({ nodes: null, error: e })),
    ]);
    const png = shot.stdout;
    const size = pngSize(png);
    if (!size) throw new Error(`screencap returned ${png.length} bytes that are not a PNG`);

    const nodes: A11yNode[] | null = treeResult.nodes;
    const treeSource: string | null = nodes ? "uiautomator dump" : null;
    if (treeResult.error) this.log(`tree unavailable this step: ${treeResult.error.message.slice(0, 160)}`);

    const [win, ime] = await Promise.all([
      this.shell(["dumpsys", "window"]).then((r) => r.stdout, () => ""),
      this.caps.surface === "touch"
        ? this.shell(["dumpsys", "input_method"]).then((r) => r.stdout, () => "")
        : Promise.resolve(""),
    ]);

    return {
      png,
      width: size.width,
      height: size.height,
      nodes,
      treeSource,
      foreground: parseForeground(win),
      focus: this.caps.surface === "dpad" ? focusLine(nodes) : null,
      keyboard: this.caps.surface === "touch" ? parseImeShown(ime) : null,
      densityDpi: await this.density(),
    };
  }

  /**
   * The tree, through /dev/tty first.
   *
   * `uiautomator dump /dev/tty` prints the XML on stdout and saves a write and
   * a read of a file on the device's storage per step. Some images refuse it;
   * the file route is the fallback. Either way, a screen that never goes idle
   * (an animation, a video) makes uiautomator give up, and that is a step
   * without a tree, not a failed mission.
   */
  private async tree(): Promise<A11yNode[]> {
    let xml = "";
    try {
      xml = (await exec(ADB, ["-s", this.target.id, "exec-out", "uiautomator", "dump", "/dev/tty"],
        { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
    } catch { /* file route below */ }
    if (!/<hierarchy\b/.test(xml)) {
      const remote = "/sdcard/fleet-explore.xml";
      await this.shell(["uiautomator", "dump", remote], 30_000);
      xml = (await this.shell(["cat", remote])).stdout;
    }
    // The tty form appends the receipt after the XML.
    const end = xml.lastIndexOf("</hierarchy>");
    if (end >= 0) xml = xml.slice(0, end + "</hierarchy>".length);
    const parsed = parseUiautomatorDump(xml);
    if (parsed.problem) throw new Error(parsed.problem);
    return parsed.nodes;
  }

  async act(a: Action): Promise<void> {
    const r = (n: number) => String(Math.round(n));
    switch (a.kind) {
      case "tap":
        await this.shell(["input", "tap", r(a.x), r(a.y)]);
        return;
      case "long_press":
        await this.shell(["input", "swipe", r(a.x), r(a.y), r(a.x), r(a.y), r(a.ms ?? 700)]);
        return;
      case "swipe":
        await this.shell(["input", "swipe", r(a.x1), r(a.y1), r(a.x2), r(a.y2), r(a.ms ?? 300)]);
        return;
      case "scroll": {
        const { width, height } = await this.screenSize();
        const f = Math.min(0.9, Math.max(0.1, a.factor ?? 0.5));
        const cx = width / 2, cy = height / 2;
        const dy = (height * f) / 2, dx = (width * f) / 2;
        // The direction is the content's: "down" reveals what is below, so the
        // finger travels up.
        const [x1, y1, x2, y2] =
          a.direction === "down" ? [cx, cy + dy, cx, cy - dy]
          : a.direction === "up" ? [cx, cy - dy, cx, cy + dy]
          : a.direction === "right" ? [cx + dx, cy, cx - dx, cy]
          : [cx - dx, cy, cx + dx, cy];
        await this.shell(["input", "swipe", r(x1), r(y1), r(x2), r(y2), "350"]);
        return;
      }
      case "type": {
        const esc = escapeInputText(a.text);
        if (!esc.ok) throw new Error(esc.reason);
        if (a.x !== undefined && a.y !== undefined) {
          await this.shell(["input", "tap", r(a.x), r(a.y)]);
          await sleep(400);
        }
        if (a.overwrite) {
          // Ctrl+A then delete where the platform has keycombination (API 31+);
          // older images get end-of-line and a run of deletes, which clears
          // anything a test would type into a single field.
          const ok = await this.shell(["input", "keycombination", "113", "29"]).then(() => true, () => false);
          if (ok) await this.shell(["input", "keyevent", "67"]);
          else await this.shell(["input", "keyevent", "123", ...Array(60).fill("67")], 30_000);
        }
        // adb joins its arguments into one command line for the device's
        // shell, which is why escapeInputText backslash-escapes rather than
        // quotes: the escapes survive that join, quotes would need nesting.
        if (esc.arg.length) await this.shell(["input", "text", esc.arg], 30_000);
        if (a.enter) await this.shell(["input", "keyevent", "66"]);
        return;
      }
      case "key":
        await this.shell(["input", "keyevent", String(ANDROID_KEYCODES[a.key])]);
        return;
      case "hide_keyboard": {
        // Back closes the keyboard when one is up, and navigates when one is
        // not -- so it is only pressed after asking.
        const ime = await this.shell(["dumpsys", "input_method"]).then((x) => x.stdout, () => "");
        if (parseImeShown(ime)) await this.shell(["input", "keyevent", "4"]);
        return;
      }
      case "wait":
        await sleep(Math.min(10_000, Math.max(0, a.ms)));
        return;
    }
  }

  private densityCache: number | null | undefined = undefined;
  /** `wm density` once per actuator: the override when one is set, else the physical density. */
  private async density(): Promise<number | null> {
    if (this.densityCache !== undefined) return this.densityCache;
    try {
      this.densityCache = parseAndroidDensity((await this.shell(["wm", "density"])).stdout);
    } catch {
      this.densityCache = null;
    }
    return this.densityCache;
  }

  private sizeCache: { width: number; height: number } | null = null;
  private async screenSize() {
    if (this.sizeCache) return this.sizeCache;
    const { stdout } = await this.shell(["wm", "size"]);
    const m = /Override size:\s*(\d+)x(\d+)/.exec(stdout) ?? /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
    this.sizeCache = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 1920 };
    return this.sizeCache;
  }

  /**
   * Crashes and ANRs since the previous call.
   *
   * The crash buffer is device-wide and survives `pm clear`, so this keeps a
   * running total and reports the difference, exactly as app-soak does --
   * parseCrashLogcat already filters to the package.
   */
  async crashes(appId: string): Promise<CrashReport> {
    const problems: string[] = [];
    let count = 0;
    const signatures: string[] = [];
    let excerpt = "";
    try {
      const { stdout } = await exec(ADB, ["-s", this.target.id, "logcat", "-b", "crash", "-d", "-t", "4000"],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      const c = parseCrashLogcat(stdout, appId);
      if (c.problem) problems.push(c.problem);
      else {
        const fresh = this.crashBaseline === null ? 0 : Math.max(0, c.count - this.crashBaseline);
        this.crashBaseline = c.count;
        if (fresh > 0) {
          count += fresh;
          signatures.push(...c.signatures.slice(-fresh));
          excerpt = crashExcerpt(stdout, appId);
        }
      }
    } catch (e) {
      problems.push(`logcat -b crash failed: ${(e as Error).message.slice(0, 120)}`);
    }
    try {
      const { stdout } = await exec(ADB, ["-s", this.target.id, "logcat", "-b", "events", "-d", "-t", "4000"],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      const anrs = parseAnrEvents(stdout, appId);
      const fresh = this.anrBaseline === null ? 0 : Math.max(0, anrs.length - this.anrBaseline);
      this.anrBaseline = anrs.length;
      if (fresh > 0) {
        count += fresh;
        signatures.push(...anrs.slice(-fresh));
      }
    } catch (e) {
      problems.push(`logcat -b events failed: ${(e as Error).message.slice(0, 120)}`);
    }
    return { count, signatures, excerpt, problems };
  }

  async close(): Promise<void> {
    // Nothing started, nothing to stop. The app is left as the mission left
    // it; the next reset clears it.
  }
}

/** The last crash block for `pkg`, up to 40 lines, for the report. */
export function crashExcerpt(log: string, pkg: string): string {
  const ls = log.replace(/\r/g, "").split("\n");
  let start = -1;
  for (let i = ls.length - 1; i >= 0; i--) {
    if (ls[i].includes(`Process: ${pkg}`) || ls[i].includes(`>>> ${pkg} <<<`)) { start = Math.max(0, i - 2); break; }
  }
  return start < 0 ? "" : ls.slice(start, start + 40).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
