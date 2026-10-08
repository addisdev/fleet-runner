/**
 * Turning what the explorer did into something that does it again.
 *
 * Every finding is replayed on a clean install before it is believed (T1),
 * and every finding ships with a file a person can run to see it for
 * themselves. Those are two different needs, met two ways:
 *
 *   - the FILE is a Maestro flow (touch screens and Android TVs) -- portable,
 *     readable, and the format the fleet's ui-test workload already runs, so a
 *     fixed bug's flow can join the scripted suite as a permanent test (T8).
 *     Points are written as percentages, so the flow survives a different
 *     screen size as well as it can.
 *   - the REPLAY runs the recorded actions back through the same actuator
 *     that made them. It is exact (same coordinates, same keys, same pauses),
 *     works on every surface including the ones Maestro cannot reach (a Roku,
 *     a physical iPhone), and does not depend on a second tool behaving.
 *
 * On Android the replay can also go through the Maestro file itself
 * (`via: "maestro"`), which proves the file works -- the integration check
 * that matters when the file is what gets attached to an issue.
 */
import type { Action, Actuator, Key } from "./types.js";

/** One executed step: an action, or a harness event the replay must repeat. */
export type Executed =
  | { step: number; kind: "action"; action: Action; settleMs: number }
  /** The app was brought back after a crash, an exit, or a home press. */
  | { step: number; kind: "relaunch" }
  /** The home key, then the app relaunched without a reset (background and return). */
  | { step: number; kind: "home" };

const MAESTRO_KEYS: Partial<Record<Key, string>> = {
  up: "Remote Dpad Up", down: "Remote Dpad Down", left: "Remote Dpad Left", right: "Remote Dpad Right",
  select: "Remote Dpad Center", back: "Back", home: "Home", enter: "Enter",
  play_pause: "Remote Media Play Pause", rewind: "Remote Media Rewind", fast_forward: "Remote Media Fast Forward",
};

const pct = (v: number, of: number) => `${Math.min(100, Math.max(0, Math.round((v / Math.max(1, of)) * 100)))}%`;
const yamlString = (s: string) => JSON.stringify(s);

/**
 * A Maestro flow for the first `upTo` executed steps.
 *
 * `setupFlow` is the sign-in flow the mission started with, referenced by
 * path; `launchArgs` become launchApp arguments (string extras on Android).
 * Waits are kept, because a step that only failed after a two-second spinner
 * does not fail without the two seconds.
 */
export function toMaestro(opts: {
  appId: string; executed: Executed[]; upTo?: number; screen: { w: number; h: number };
  setupFlow?: string | null; launchArgs?: string[]; title?: string;
}): string {
  const { w, h } = opts.screen;
  const lines: string[] = [`appId: ${opts.appId}`];
  if (opts.title) lines.push(`name: ${yamlString(opts.title)}`);
  lines.push("---");
  const args = (opts.launchArgs ?? []).map((a) => /^([A-Za-z_][\w.]*)=(.*)$/.exec(a)).filter(Boolean) as RegExpExecArray[];
  const launch = () => {
    lines.push("- launchApp:");
    lines.push("    clearState: true");
    if (args.length) {
      lines.push("    arguments:");
      for (const m of args) lines.push(`      ${m[1]}: ${yamlString(m[2])}`);
    }
  };
  launch();
  if (opts.setupFlow) lines.push(`- runFlow: ${yamlString(opts.setupFlow)}`);
  const steps = opts.executed.slice(0, opts.upTo ?? opts.executed.length);
  let lastStep = -1;
  for (const e of steps) {
    if (e.step !== lastStep) { lines.push(`# step ${e.step}`); lastStep = e.step; }
    if (e.kind === "relaunch") { lines.push("- launchApp"); continue; }
    if (e.kind === "home") { lines.push("- pressKey: Home", "- launchApp"); continue; }
    const a = e.action;
    switch (a.kind) {
      case "tap":
        lines.push("- tapOn:", `    point: "${pct(a.x, w)},${pct(a.y, h)}"`);
        break;
      case "long_press":
        lines.push("- longPressOn:", `    point: "${pct(a.x, w)},${pct(a.y, h)}"`);
        break;
      case "type":
        if (a.x !== undefined && a.y !== undefined) lines.push("- tapOn:", `    point: "${pct(a.x, w)},${pct(a.y, h)}"`);
        if (a.overwrite) lines.push("- eraseText: 80");
        if (a.text) lines.push(`- inputText: ${yamlString(a.text)}`);
        if (a.enter) lines.push("- pressKey: Enter");
        break;
      case "swipe":
        lines.push("- swipe:", `    start: "${pct(a.x1, w)},${pct(a.y1, h)}"`, `    end: "${pct(a.x2, w)},${pct(a.y2, h)}"`, `    duration: ${Math.round(a.ms ?? 300)}`);
        break;
      case "scroll": {
        const f = Math.min(0.9, Math.max(0.1, a.factor ?? 0.5)) * 50;
        const [s, t] = a.direction === "down" ? [[50, 50 + f], [50, 50 - f]]
          : a.direction === "up" ? [[50, 50 - f], [50, 50 + f]]
          : a.direction === "right" ? [[50 + f, 50], [50 - f, 50]]
          : [[50 - f, 50], [50 + f, 50]];
        lines.push("- swipe:", `    start: "${Math.round(s[0])}%,${Math.round(s[1])}%"`, `    end: "${Math.round(t[0])}%,${Math.round(t[1])}%"`, "    duration: 350");
        break;
      }
      case "key": {
        const k = MAESTRO_KEYS[a.key];
        lines.push(k ? `- pressKey: ${k}` : `# key ${a.key} has no Maestro equivalent`);
        break;
      }
      case "hide_keyboard":
        lines.push("- hideKeyboard");
        break;
      case "wait":
        lines.push(`- waitForAnimationToEnd:`, `    timeout: ${Math.round(a.ms)}`);
        break;
    }
    if (e.settleMs > 0 && a.kind !== "wait") lines.push("- waitForAnimationToEnd:", `    timeout: ${Math.max(500, Math.round(e.settleMs))}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Run the first `upTo` executed steps again through the actuator, from a
 * clean install. The caller resets the app (and signs in) first; this only
 * repeats what the explorer did after that.
 */
export async function replayThrough(
  actuator: Actuator, appId: string, executed: Executed[], upTo: number, launchArgs: string[] = [],
): Promise<void> {
  for (const e of executed.slice(0, upTo)) {
    if (e.kind === "relaunch") { await actuator.launch(appId, launchArgs); continue; }
    if (e.kind === "home") {
      await actuator.act({ kind: "key", key: "home" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      await actuator.launch(appId, launchArgs);
      continue;
    }
    await actuator.act(e.action);
    if (e.settleMs > 0) await new Promise((r) => setTimeout(r, e.settleMs));
  }
}
