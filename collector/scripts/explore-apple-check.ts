/**
 * Drive one Apple simulator through the explore actuator, end to end, and say
 * what happened and how long it took.
 *
 *   npx tsx scripts/explore-apple-check.ts <udid> [--app <bundleId>] [--out <dir>] [--presses <n>] [--dump]
 *        [--reset] [--file <path.app>]
 *
 * It boots nothing and creates nothing: hand it a simulator that is already
 * booted (and, on a shared Mac, one you acquired through Load Warden). The
 * platform comes from the simulator's runtime, so the same command checks an
 * iPhone and an Apple TV.
 *
 * What it does:
 *
 *   iOS   launch the app (Settings by default), look, tap the first labelled
 *         cell, look, scroll down and up, tap the search field and type into
 *         it, hide the keyboard, press home, and read crashes twice.
 *   tvOS  launch the app (TV Settings by default), look, press down a few
 *         times reading the focus line after each, select, Menu back out,
 *         scroll by D-pad, press home, and read crashes twice.
 *
 * Every observe and act is timed, and the script ends with the medians, which
 * are the numbers an exploration budget is planned from. Two screenshots are
 * written to --out (default: a temp dir), first and last.
 *
 * It exists because the actuator's only real test is a device: the pure parts
 * are in src/workloads/explore/actuators/apple.test.ts, and everything else --
 * the build, the runner coming up, XCUITest actually doing what was asked --
 * is only ever proven by running it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../src/fleet-client.js";
import { AppleActuator } from "../src/workloads/explore/actuators/apple.js";
import type { Action, Observation } from "../src/workloads/explore/types.js";
import type { Target } from "../src/workloads/types.js";

const argv = process.argv.slice(2);
const udid = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!udid) {
  console.error("usage: explore-apple-check.ts <udid> [--app <bundleId>] [--out <dir>] [--presses <n>] [--dump] [--reset] [--file <path.app>]");
  process.exit(2);
}

/** iOS or tvOS, from the simulator's runtime identifier. */
async function platformOf(id: string): Promise<"ios" | "tvos"> {
  const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "--json"], { maxBuffer: 16 * 1024 * 1024 });
  const all = JSON.parse(stdout) as { devices: Record<string, { udid: string; state: string }[]> };
  for (const [runtime, devs] of Object.entries(all.devices)) {
    const d = devs.find((x) => x.udid === id);
    if (!d) continue;
    if (d.state !== "Booted") throw new Error(`${id} is ${d.state}; boot it first (this script boots nothing)`);
    if (/tvOS/.test(runtime)) return "tvos";
    if (/iOS/.test(runtime)) return "ios";
    throw new Error(`${id} runs ${runtime}, which this actuator does not drive`);
  }
  throw new Error(`no simulator ${id}`);
}

const out = opt("out") ?? mkdtempSync(path.join(os.tmpdir(), "explore-apple-"));
mkdirSync(out, { recursive: true });
const observeMs: number[] = [];
const actMs: number[] = [];
const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main() {
  const platform = await platformOf(udid!);
  const target: Target = { id: udid!, platform, kind: "simulator", driver: "simctl" };
  const appId = opt("app") ?? (platform === "tvos" ? "com.apple.TVSettings" : "com.apple.Preferences");
  const actuator = new AppleActuator(target, (m) => say(`  actuator: ${m}`));
  say(`${platform} simulator ${udid}, app ${appId}, screenshots to ${out}`);

  const look = async (why: string): Promise<Observation> => {
    const s = Date.now();
    const o = await actuator.observe();
    const ms = Date.now() - s;
    observeMs.push(ms);
    const labelled = (o.nodes ?? []).filter((n) => n.label).length;
    say(
      `observe (${why}): ${ms} ms, ${o.width}x${o.height} px, ${o.nodes?.length ?? "no"} nodes (${labelled} labelled), ` +
      `foreground ${o.foreground}, keyboard ${o.keyboard}` + (o.focus !== null ? `, focus: ${o.focus}` : ""),
    );
    return o;
  };
  const act = async (a: Action, why = "") => {
    const s = Date.now();
    await actuator.act(a);
    const ms = Date.now() - s;
    if (a.kind !== "wait") actMs.push(ms);
    say(`act ${JSON.stringify(a)}${why ? ` (${why})` : ""}: ${ms} ms`);
  };

  try {
    let s = Date.now();
    await actuator.start();
    say(`driver up: ${Date.now() - s} ms (includes any build)`);

    s = Date.now();
    if (argv.includes("--reset") || opt("file")) {
      // The mission path: clean state (and a fresh install with --file), then launch.
      await actuator.reset(appId, { file: opt("file") });
      say(`reset + launch ${appId}: ${Date.now() - s} ms`);
    } else {
      await actuator.launch(appId);
      say(`launch ${appId}: ${Date.now() - s} ms`);
    }
    await actuator.crashes(appId);

    const first = await look("after launch");
    writeFileSync(path.join(out, `${platform}-1-launch.png`), first.png);
    if (argv.includes("--dump")) writeFileSync(path.join(out, `${platform}-1-launch.json`), JSON.stringify(first.nodes, null, 1));

    if (platform === "ios") {
      // "General" in Settings, else a labelled cell in the top half. Never the
      // Apple Account row: it opens a sign-in sheet with no back button.
      const candidates = (first.nodes ?? []).filter((n) =>
        (n.cls === "Cell" || n.cls === "Button") && n.label && !/Apple Account|Sign in/i.test(n.label) &&
        n.bounds && n.bounds.w > 0 && n.bounds.y > first.height * 0.12 && n.bounds.y < first.height * 0.8);
      const cell = candidates.find((n) => n.label === "General") ?? candidates[0];
      if (cell?.bounds) {
        await act({ kind: "tap", x: cell.bounds.x + cell.bounds.w / 2, y: cell.bounds.y + cell.bounds.h / 2 }, `"${cell.label}"`);
        await act({ kind: "wait", ms: 800 });
        await look(`after tapping "${cell.label}"`);
        await act({ kind: "scroll", direction: "down" });
        await look("after scrolling down");
        await act({ kind: "scroll", direction: "up" });
        const inner = await look("after scrolling up");
        // The navigation bar's back button: a Button in the top-left corner.
        const backButton = (inner.nodes ?? []).find((n) => n.cls === "Button" && n.bounds && n.bounds.w > 0 &&
          n.bounds.y < inner.height * 0.15 && n.bounds.x < inner.width * 0.3);
        if (backButton?.bounds) {
          await act({ kind: "tap", x: backButton.bounds.x + backButton.bounds.w / 2, y: backButton.bounds.y + backButton.bounds.h / 2 },
            `back button "${backButton.label}"`);
        } else {
          // No back button found: the left-edge swipe iOS reads as back.
          await act({ kind: "swipe", x1: 3, y1: first.height / 2, x2: first.width * 0.8, y2: first.height / 2, ms: 250 }, "edge swipe back");
        }
        await act({ kind: "wait", ms: 800 });
      } else {
        say("no labelled cell in the top half to tap; skipping the tap");
      }
      let back = await look("back on the first screen");
      const isField = (n: { cls: string; bounds: unknown }) => (n.cls === "SearchField" || n.cls === "TextField") && !!n.bounds;
      if (!(back.nodes ?? []).some(isField)) {
        // Settings keeps its search field above the first row until pulled down.
        await act({ kind: "scroll", direction: "up", factor: 0.3 }, "pull down for the search field");
        back = await look("after pulling down");
      }
      const field = (back.nodes ?? []).find(isField);
      if (field?.bounds) {
        await act({ kind: "type", text: "General", x: field.bounds.x + field.bounds.w / 2, y: field.bounds.y + field.bounds.h / 2 });
        await act({ kind: "wait", ms: 800 });
        const typed = await look("after typing");
        const shown = (typed.nodes ?? []).find((n) => n.cls === field.cls);
        say(`  the field now holds: ${JSON.stringify(shown?.value ?? null)}`);
        writeFileSync(path.join(out, `${platform}-2-typed.png`), typed.png);
        await act({ kind: "type", text: "Wi", overwrite: true }, "overwrite");
        const over = await look("after overwrite");
        say(`  the field now holds: ${JSON.stringify((over.nodes ?? []).find((n) => n.cls === field.cls)?.value ?? null)}`);
        await act({ kind: "hide_keyboard" });
        const hidden = await look("after hide_keyboard");
        if (hidden.keyboard) say("  the keyboard is still up after hide_keyboard");
      } else {
        say("no search or text field on the first screen; skipping typing");
        writeFileSync(path.join(out, `${platform}-2-typed.png`), back.png);
      }
      await act({ kind: "key", key: "home" });
      await act({ kind: "wait", ms: 1000 });
      await look("after home");
      let refused = "";
      try { await actuator.act({ kind: "key", key: "back" }); } catch (e) { refused = (e as Error).message; }
      say(`key back on iOS refused as it should be: ${refused ? refused.slice(0, 100) : "NOT REFUSED"}`);
    } else {
      const presses = Number(opt("presses") ?? 3);
      for (let i = 0; i < presses; i++) {
        await act({ kind: "key", key: "down" });
        await look(`after down #${i + 1}`);
      }
      await act({ kind: "key", key: "select" });
      await act({ kind: "wait", ms: 800 });
      const inside = await look("after select");
      writeFileSync(path.join(out, `${platform}-2-select.png`), inside.png);
      await act({ kind: "scroll", direction: "down" });
      await look("after D-pad scroll down");
      await act({ kind: "key", key: "back" });
      await act({ kind: "wait", ms: 800 });
      await look("after back (Menu)");
      let refused = "";
      try { await actuator.act({ kind: "tap", x: 10, y: 10 }); } catch (e) { refused = (e as Error).message; }
      say(`tap on tvOS refused as it should be: ${refused ? refused.slice(0, 100) : "NOT REFUSED"}`);
      await act({ kind: "key", key: "home" });
      await act({ kind: "wait", ms: 1000 });
      await look("after home");
    }

    const crashes = await actuator.crashes(appId);
    say(`crashes since launch: ${crashes.count}${crashes.problems.length ? ` (problems: ${crashes.problems.join("; ")})` : ""}`);
  } finally {
    const s = Date.now();
    await actuator.close();
    say(`close: ${Date.now() - s} ms`);
  }

  const summary = {
    platform,
    observe_ms: { n: observeMs.length, median: median(observeMs), min: Math.min(...observeMs), max: Math.max(...observeMs) },
    act_ms: { n: actMs.length, median: median(actMs), min: Math.min(...actMs), max: Math.max(...actMs) },
    screenshots: out,
    driver_log: actuator.logFile,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
