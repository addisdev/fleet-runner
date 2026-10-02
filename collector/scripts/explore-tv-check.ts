// Drive a TV through the explore actuators, for real, and say how long it took.
//
//   npx tsx scripts/explore-tv-check.ts --fake-roku
//   npx tsx scripts/explore-tv-check.ts --roku 127.0.0.1 --ecp-port 61421 --dev-port 61423 \
//       --console-port 61424 --agent-port 61425            (a fakeroku you started yourself)
//   npx tsx scripts/explore-tv-check.ts --android emulator-5554 --app com.taylab.dozehound.debug \
//       [--apk path/to/app-debug.apk]
//   ... --missions      also run each mission's known answer and check its `check` block
//   ... --out DIR       where screenshots go (default: a temp dir, printed)
//
// Not a unit test: it needs tvloop built at FLEET_TVLOOP_DIR (or ~/tvloop), a
// device or emulator, and minutes. It is the "does this actually work" half of
// roku.test.ts, and the thing to run when tvloop or an actuator changes.
//
// What it does, per device:
//
//   1. open the actuator, launch the app, observe (screenshot 1), print the
//      focus line and the timings;
//   2. press keys and observe after each, checking that focus MOVED;
//   3. a second screenshot from a different screen;
//   4. Roku: crash detection (with --fake-roku a crash is injected) and a
//      tvloop replay of the keys just pressed, through the real tvloop CLI;
//      Android TV: tvloop doctor and a tvloop replay against the same device
//      through a generated androidtv config -- the path the tvloop workload's
//      Fire TV support uses;
//   5. with --missions: each mission under examples/missions/<app>/ that has a
//      `check` is played with its known key sequence from a fresh start, and
//      the check is evaluated on the final observation.
//
// A Roku password: --fake-roku uses the fake's ("rokudev"). For a real Roku
// it is read from the Keychain item the fleet uses (fleet-roku-dev), never
// from the command line.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AndroidActuator, focusedText } from "../src/workloads/explore/actuators/android.js";
import { RokuActuator, tvloopCheckout } from "../src/workloads/explore/actuators/roku.js";
import { runTvloopFlow, tvloopFlow, tvloopFlowFile } from "../src/workloads/explore/replay-tvloop.js";
import type { Action, Actuator, Key, Mission, Observation } from "../src/workloads/explore/types.js";
import { CLI, deviceToml, TV_ALIAS, type TvloopDevice } from "../src/workloads/tvloop/index.js";
import { rokuDevPassword } from "../src/drivers/roku.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const OUT = arg("out") ?? mkdtempSync(path.join(os.tmpdir(), "explore-tv-check-"));
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};
const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  try {
    return await f();
  } finally {
    console.log(`  ${String(Date.now() - t0).padStart(6)} ms  ${label}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (name: string, o: Observation) => {
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, o.png);
  console.log(`           shot  ${file} (${o.width}x${o.height})`);
  return file;
};

// ---------------------------------------------------------------------------
// Mission checks
// ---------------------------------------------------------------------------

/**
 * The fake Roku's screen, from what an actuator can see: the sample channel's
 * details screen is the one where PlayButton holds focus; its home row is the
 * one where a Tile does; and with no channel in front it is Roku Home.
 */
function fakeRokuScreen(o: Observation): string | null {
  if (o.foreground === null) return "roku-home";
  const f = o.nodes?.find((n) => n.focused);
  if (!f) return null;
  if (f.id === "PlayButton") return "details";
  if (/^Tile\d+$/.test(f.id)) return "home";
  return null;
}

/**
 * The names the focused element answers to: its own label or text, the title
 * of what is nested inside it (Compose), and its id's last part (SceneGraph,
 * whose nodes are named by id and carry no text from the agent).
 */
function focusedLabels(o: Observation): string[] {
  const f = o.nodes?.find((n) => n.focused);
  if (!f) return [];
  const nested = focusedText(o.nodes).split(" / ")[0];
  return [f.label, f.text, nested, f.id.split("/").pop() ?? ""].map((s) => s.trim()).filter(Boolean);
}

function evaluate(m: Mission, o: Observation, screenOf: (o: Observation) => string | null): { ok: boolean; why: string } {
  const c = m.check!;
  const why: string[] = [];
  if (c.screen) {
    const s = screenOf(o);
    if (s !== c.screen) why.push(`screen is ${s ?? "unknown"}, wanted ${c.screen}`);
  }
  if (c.focused_label) {
    const ls = focusedLabels(o);
    if (!ls.includes(c.focused_label)) why.push(`focus is on ${JSON.stringify(ls[0] ?? null)}, wanted ${JSON.stringify(c.focused_label)}`);
  }
  for (const t of c.text ?? []) {
    if (!(o.nodes ?? []).some((n) => n.text.includes(t) || n.label.includes(t))) why.push(`no ${JSON.stringify(t)} on screen`);
  }
  return { ok: why.length === 0, why: why.join("; ") };
}

/** Each checked mission's known answer: the keys a person would press. */
const ANSWERS: Record<string, Record<string, Key[]>> = {
  fakeroku: {
    "bench-third-tile": ["right", "right"],
    "bench-last-tile": ["right", "right", "right", "right"],
    "bench-past-the-end": ["right", "right", "right", "right", "right", "right"],
    "bench-left-at-start": ["left"],
    "bench-first-details": ["select"],
    "bench-last-details": ["right", "right", "right", "right", "select"],
    "bench-third-details-and-back": ["right", "right", "select", "back"],
    "bench-second-details-and-back": ["right", "select", "back"],
    "bench-there-and-back": ["right", "right", "right", "left", "left", "left"],
    "bench-exit-to-roku-home": ["home"],
  },
  "dozehound-tv": {
    "bench-open-bar": ["down"],
    "bench-focus-meadow": ["down", "right"],
    "bench-focus-window-seat": ["down", "right", "right"],
    "bench-focus-leaving-home": ["down", "down"],
    "bench-browse-and-return": ["down", "right", "right", "left", "left"],
    "bench-up-from-leaving-home": ["down", "down", "up"],
    "bench-leaving-home": ["down", "down", "select"],
    "bench-pause": ["play_pause"],
    "bench-meadow-then-leaving-home": ["down", "right", "select", "down", "select"],
    "bench-pause-then-leaving-home": ["play_pause", "down", "down", "select"],
  },
};

function loadMissions(app: string): Mission[] {
  const dir = path.join(ROOT, "examples", "missions", app);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Mission);
}

async function runMissions(app: string, a: Actuator, appId: string, screenOf: (o: Observation) => string | null, gapMs: number) {
  console.log(`\n-- missions for ${app}: each from a fresh start, its known keys, then its check`);
  const missions = loadMissions(app).filter((m) => m.check);
  for (const m of missions) {
    const keys = ANSWERS[app]?.[m.id];
    if (!keys) {
      check(`${m.id}: has a known answer`, false, "add one to ANSWERS");
      continue;
    }
    await a.reset(appId);
    await sleep(app === "fakeroku" ? 200 : 6000);
    const t0 = Date.now();
    for (const k of keys) {
      await a.act({ kind: "key", key: k });
      await sleep(gapMs);
    }
    const o = await a.observe();
    const r = evaluate(m, o, screenOf);
    check(`${m.id}: ${keys.join(" ")}`, r.ok, r.ok ? `${Date.now() - t0} ms` : r.why);
  }
}

// ---------------------------------------------------------------------------
// tvloop CLI, for doctor
// ---------------------------------------------------------------------------

function tvloopCli(args: string[], device: TvloopDevice, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "explore-tv-check-cli-"));
  writeFileSync(path.join(cwd, "tvloop.toml"), deviceToml(device));
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, [path.join(tvloopCheckout(), CLI), ...args, "--cwd", cwd, "--device", TV_ALIAS, "--no-daemon"],
      { cwd, env: { ...process.env, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

// ---------------------------------------------------------------------------
// (a) Roku, real or fake
// ---------------------------------------------------------------------------

async function rokuCheck() {
  type Fake = { start(): Promise<{ host: string; ecpPort: number; devPort: number; consolePort: number; agentPort: number }>; stop(): Promise<void>; emitCrash(spec: unknown): void };
  let fake: Fake | null = null;
  let host = arg("roku") ?? "";
  let ports: { ecp?: number; dev?: number; console?: number; agent?: number } = {
    ecp: Number(arg("ecp-port")) || undefined, dev: Number(arg("dev-port")) || undefined,
    console: Number(arg("console-port")) || undefined, agent: Number(arg("agent-port")) || undefined,
  };
  let password: string;
  if (flag("fake-roku")) {
    // In-process, from the checkout, so a crash can be injected; the same
    // server `npx @tvloop/fakeroku --agent` runs.
    const mod = await import(pathToFileURL(path.join(tvloopCheckout(), "packages/fakeroku/dist/index.js")).href) as
      { FakeRoku: new (o: { agent: boolean }) => Fake };
    fake = new mod.FakeRoku({ agent: true });
    const addr = await fake.start();
    host = addr.host;
    ports = { ecp: addr.ecpPort, dev: addr.devPort, console: addr.consolePort, agent: addr.agentPort };
    password = "rokudev";
    console.log(`\n== fake Roku at ${host} (ecp ${ports.ecp}, dev ${ports.dev}, console ${ports.console}, agent ${ports.agent})`);
  } else {
    const pw = await rokuDevPassword();
    if (!pw.ok) throw new Error(`no Roku developer password in the Keychain (${pw.reason}): see WB-101`);
    password = pw.password;
    console.log(`\n== Roku at ${host}`);
  }

  const target = { id: fake ? "roku-FAKE0000001" : `roku-ip-${host.replace(/\./g, "-")}`, platform: "roku", driver: "roku" };
  const a = await timed("open (connect, device-info, agent probe)", () => RokuActuator.open(target, { host, password, ports }));
  console.log(`           caps  surface=${a.caps.surface} tree=${a.caps.tree} keys=${a.caps.keys.length}`);
  try {
    await timed("launch dev", () => a.launch("dev"));
    await a.crashes("dev");
    const o1 = await timed("observe", () => a.observe());
    console.log(`           focus ${o1.focus}`);
    shot("roku-1-home", o1);
    check("roku: the dev channel is in front", o1.foreground === "dev", String(o1.foreground));
    const pressed: Action[] = [];
    let before = o1.focus;
    for (const key of ["right", "right"] as Key[]) {
      await timed(`press ${key}`, () => a.act({ kind: "key", key }));
      pressed.push({ kind: "key", key });
      const o = await timed("observe", () => a.observe());
      console.log(`           focus ${o.focus}`);
      check(`roku: ${key} moved focus`, o.focus !== before, `${before} -> ${o.focus}`);
      before = o.focus;
    }
    await timed("press select", () => a.act({ kind: "key", key: "select" }));
    pressed.push({ kind: "key", key: "select" });
    const o2 = await timed("observe", () => a.observe());
    console.log(`           focus ${o2.focus}`);
    shot("roku-2-details", o2);
    check("roku: select opened details (PlayButton focused)", (o2.focus ?? "").includes("PlayButton"), String(o2.focus));
    check("roku: the two screenshots differ", !o1.png.equals(o2.png));

    // The keys just pressed, as a tvloop replay through the real CLI.
    const file = path.join(OUT, "roku-replay.json");
    writeFileSync(file, tvloopFlowFile(tvloopFlow(pressed, { name: "explore-tv-check", settleMs: 400, launchSettleMs: 1500, focus: "PlayButton" })));
    const r = await timed("tvloop replay (CLI, generated config)", () =>
      runTvloopFlow(file, { device: { platform: "roku", host, ports }, password }));
    check("roku: the replay passes", r.status === "passed", `${r.status} ${r.failedStep ?? ""} ${r.message ?? ""}`.trim());

    if (fake) {
      fake.emitCrash({ message: "Invalid value for left-hand side of operator", errorCode: "&he4",
        frames: [{ func: "onKeyEvent", file: "pkg:/components/DetailPage.brs", line: 84 }] });
      await sleep(800); // tvloop closes a crash block after 300 ms of console quiet
      const c = await a.crashes("dev");
      check("roku: an injected crash is reported once", c.count === 1, c.signatures.join(" | "));
      // The same replay again, AFTER the crash. Nothing crashes during it, but
      // the console hands a new client its recent backlog, and tvloop's
      // noErrors counts from the flow's start, not the app run's -- so a
      // replay that follows a crash can "reproduce" it. Printed, not checked:
      // it is a hazard to know about, not a property of this code.
      const again = await timed("the same replay, after the crash", () =>
        runTvloopFlow(file, { device: { platform: "roku", host, ports }, password }));
      console.log(`           note  replay after a crash: ${again.status}${again.message ? ` (${again.message})` : ""}`);
    }

    if (flag("missions") && fake) {
      await runMissions("fakeroku", a, "dev", fakeRokuScreen, 150);
    }
  } finally {
    await a.close();
    await fake?.stop();
  }
}

// ---------------------------------------------------------------------------
// (b) Android TV / Fire TV over adb
// ---------------------------------------------------------------------------

async function androidCheck() {
  const serial = arg("android")!;
  const appId = arg("app") ?? "com.taylab.dozehound.debug";
  const apk = arg("apk");
  console.log(`\n== Android TV ${serial}, app ${appId}`);
  const target = { id: serial, platform: "android", driver: "adb" };
  const tv = await timed("isTv (pm list features)", () => AndroidActuator.isTv(target));
  check("android: the device declares leanback", tv);
  const a = new AndroidActuator(target, { surface: "dpad", log: (m) => console.log(`           log   ${m}`) });
  await timed(`reset${apk ? " (install, clear, launch)" : " (clear, launch)"}`, () => a.reset(appId, apk ? { file: apk } : {}));
  // The app opens straight into playback; give the first frame and the
  // channel guide a moment, as a person would.
  await sleep(6000);
  const o1 = await timed("observe (screencap + uiautomator dump, in parallel)", () => a.observe());
  console.log(`           focus ${o1.focus}`);
  shot("android-1-player", o1);
  check("android: the app is in front", o1.foreground === appId, String(o1.foreground));
  check("android: the focus line is a sentence, not null", typeof o1.focus === "string" && o1.focus.length > 0, String(o1.focus));

  // Keys, quickly, then one look: Dozehound's bar hides itself six seconds
  // after the last key, and on a loaded host one observe can take longer
  // than that -- so each focus is read straight after its own key.
  const seen: string[] = [];
  let o2: Observation | null = null;
  for (const key of ["down", "right", "right", "left"] as Key[]) {
    await timed(`press ${key}`, () => a.act({ kind: "key", key }));
    await sleep(700);
    const o = await timed("observe", () => a.observe());
    const name = focusedText(o.nodes);
    console.log(`           focus ${o.focus}`);
    seen.push(name.split(" / ")[0] || "(player)");
    if (key === "right" && !o2) o2 = o;
  }
  if (o2) shot("android-2-bar", o2);
  console.log(`           focus went: ${seen.join(" -> ")}`);
  check("android: down opened the bar onto a channel tile", seen[0] !== "(player)", seen[0]);
  check("android: focus moved between tiles", new Set(seen).size >= 2, seen.join(" -> "));
  await timed("press select (on the focused tile)", () => a.act({ kind: "key", key: "select" }));
  const crashes = await a.crashes(appId);
  check("android: no crash so far", crashes.count === 0 && crashes.problems.length === 0, JSON.stringify(crashes));

  // tvloop's own view of the same device, through the generated config the
  // tvloop workload writes for a Fire TV.
  const device: TvloopDevice = { platform: "androidtv", serial, package: appId };
  const doc = await timed("tvloop doctor (androidtv config)", () => tvloopCli(["doctor", "--json"], device));
  let doctorSays = doc.out.trim().slice(-200);
  try {
    const j = JSON.parse(doc.out.slice(doc.out.indexOf("{"))) as { checks?: { name: string; status: string }[] };
    if (j.checks) doctorSays = j.checks.map((c) => `${c.name}:${c.status}`).join(" ");
  } catch { /* the raw tail above */ }
  check("android: tvloop doctor passes on the generated config", doc.code === 0, doctorSays);
  // Launched by the actuator and not by the flow: tvloop's Android launch is
  // `monkey -p <pkg> 1`, whose one event is random (see replay-tvloop.ts).
  const file = path.join(OUT, "android-replay.json");
  writeFileSync(file, tvloopFlowFile(tvloopFlow(
    [{ kind: "key", key: "down" }, { kind: "key", key: "down" }, { kind: "key", key: "select" }],
    { name: "leaving-home", settleMs: 900, launch: false },
  )));
  await timed("reset (clear, launch) before the replay", () => a.reset(appId));
  await sleep(6000);
  const r = await timed("tvloop replay (androidtv, generated config)", () => runTvloopFlow(file, { device }));
  check("android: a tvloop replay runs on the TV", r.status === "passed", `${r.status} ${r.failedStep ?? ""} ${r.message ?? ""}`.trim());
  check("android: ...and says its noErrors could not have failed there", r.errorsWatched === false);
  const after = await a.observe();
  shot("android-3-after-replay", after);
  check("android: ...and left the app where the keys lead (Leaving Home banner)",
    (after.nodes ?? []).some((n) => n.text.startsWith("Leaving Home —")), focusedText(after.nodes));

  if (flag("missions")) await runMissions("dozehound-tv", a, appId, () => null, 700);
  await a.close();
}

// ---------------------------------------------------------------------------

if (!flag("fake-roku") && !arg("roku") && !arg("android")) {
  console.error("say what to drive: --fake-roku, --roku <host> [ports], and/or --android <serial> --app <id>");
  process.exit(2);
}
console.log(`screenshots in ${OUT}; load average ${os.loadavg().map((x) => x.toFixed(0)).join(" ")} on ${os.cpus().length} cores`);
if (flag("fake-roku") || arg("roku")) await rokuCheck();
if (arg("android")) await androidCheck();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
