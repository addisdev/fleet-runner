/**
 * The explore workload's decisions, without a phone or a model.
 *
 * Two halves. The first pins the pure pieces: coordinate conversion from the
 * model's 0-1000 grid, escaping for `input text`, what counts as in front,
 * snapping and the leash, screen identity, fingerprints, the Maestro file.
 * The second runs a whole mission against a fake device and a fake model
 * server that answers with scripted tool calls, so the loop's own logic -- a
 * crash found and the app relaunched, a dead control noticed on its second
 * tap, a dangerous control refused, a candidate replayed and reproduced --
 * is exercised end to end with nothing plugged in.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import type { A11yNode } from "../../a11y-tree.js";
import { escapeInputText, focusLine, launchExtras, parseAnrEvents, parseForeground, parseImeShown, pngSize } from "./actuators/android.js";
import { parseConditions } from "./conditions.js";
import { dhash, hamming, isBlank, shrinkForModel } from "./image.js";
import { fileable, gatewayKey, missingFlowVars, modelConfigs, paramsProblem, pickCandidates } from "./index.js";
import { parseJsonLoose, visualIssuesFrom } from "./judge.js";
import { leash, leftApp, snap } from "./leash.js";
import { benchCheck, confirm, fingerprint, normalizeMessage, runMission, type LoopDeps } from "./loop.js";
import { changedWords, orderMissions } from "./missions.js";
import { convertCall, elementHints, parseInlineCalls, parseToolCalls } from "./model.js";
import { toMaestro, type Executed } from "./replay.js";
import { ScreenMap, jaccard, screenTokens } from "./screenmap.js";
import type { Action, Actuator, ActuatorCaps, CrashReport, Mission, Observation } from "./types.js";
import type { Target } from "../types.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const node = (o: Partial<A11yNode>): A11yNode => ({
  cls: "android.widget.Button", text: "", label: "", id: "", value: "", tappable: true, enabled: true,
  bounds: { x: 0, y: 0, w: 100, h: 50 }, depth: 2, ...o,
});

/** A solid PNG with an optional darker band, so screens hash differently. */
function png(w: number, h: number, shade: number, band = -1): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBand = band >= 0 && y >= band && y < band + h / 6;
      const v = inBand ? 30 : shade + ((x * 7 + y * 3) % 40);
      p.data[i] = v; p.data[i + 1] = v; p.data[i + 2] = v; p.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(p);
}

const TOUCH: ActuatorCaps = { surface: "touch", keys: ["back", "home", "enter"], tree: true, foreground: true };
const DPAD: ActuatorCaps = { surface: "dpad", keys: ["up", "down", "left", "right", "select", "back", "home"], tree: true, foreground: true };

export async function runExploreChecks(check: Check): Promise<void> {
  // --- android parsers ----------------------------------------------------
  const p1 = png(200, 400, 120);
  check("explore: pngSize reads IHDR", JSON.stringify(pngSize(p1)) === '{"width":200,"height":400}');
  const esc = escapeInputText("a b&c's");
  check("explore: input text escapes spaces and shell characters", esc.ok && esc.arg === "a%sb\\&c\\'s", JSON.stringify(esc));
  check("explore: input text refuses non-ASCII rather than dropping letters", !escapeInputText("Café").ok);
  check("explore: foreground from mFocusedApp",
    parseForeground("  mFocusedApp=ActivityRecord{1a2b u0 com.taylab.greenfolio.debug/com.taylab.MainActivity t12}\n") === "com.taylab.greenfolio.debug");
  check("explore: foreground falls back to mCurrentFocus",
    parseForeground("mCurrentFocus=Window{9f u0 com.android.settings/com.android.settings.Settings}") === "com.android.settings");
  check("explore: ime shown", parseImeShown("mInputShown=true") === true && parseImeShown("nothing") === null);
  check("explore: ANRs for the package only",
    parseAnrEvents("10-02 am_anr: [0,123,com.x,1,Input dispatching timed out]\n10-02 am_anr: [0,9,com.y,1,x]", "com.x").length === 1);
  check("explore: launch args become string extras", launchExtras(["garden_defects=false"]).join(" ") === "--es garden_defects false");
  let threw = false;
  try { launchExtras(["-uiTestSignedOut"]); } catch { threw = true; }
  check("explore: iOS-style launch args are refused on Android", threw);
  const tvNodes = [
    node({ cls: "android.widget.FrameLayout", label: "Home", depth: 0, tappable: false, bounds: { x: 0, y: 0, w: 1920, h: 1080 } }),
    node({ cls: "android.widget.LinearLayout", label: "Calm row", depth: 1, tappable: false, bounds: { x: 0, y: 300, w: 1920, h: 300 } }),
    node({ text: "Rain on the porch", depth: 2, focused: true, bounds: { x: 100, y: 320, w: 300, h: 200 } }),
  ];
  const fl = focusLine(tvNodes) ?? "";
  check("explore: focus line names the focused tile inside its containers", fl.startsWith("Home > Calm row > 'Rain on the porch' (focused"), fl);

  // --- model calls to actions ---------------------------------------------
  const [tap] = convertCall({ id: "1", name: "mobile_click", args: { element: "Add", x: 500, y: 1000 } }, 1081, 2401, TOUCH);
  check("explore: 0-1000 maps to screenshot pixels",
    tap.kind === "action" && tap.action.kind === "tap" && tap.action.x === 540 && tap.action.y === 2400, JSON.stringify(tap));
  const [write] = convertCall({ id: "2", name: "mobile_write", args: { element: "Name", text: "Fern", x: 100, y: 100, overwrite: true } }, 1001, 1001, TOUCH);
  check("explore: mobile_write taps and types, enter by default",
    write.kind === "action" && write.action.kind === "type" && write.action.text === "Fern" && write.action.enter === true && write.action.overwrite === true);
  const presses = convertCall({ id: "3", name: "tv_press", args: { key: "right", times: 3 } }, 1920, 1080, DPAD);
  check("explore: tv_press times=3 is three key actions", presses.length === 3 && presses.every((c) => c.kind === "action" && c.action.kind === "key"));
  const bad = convertCall({ id: "4", name: "tv_press", args: { key: "menu" } }, 1920, 1080, DPAD);
  check("explore: a key the device lacks is invalid", bad[0].kind === "invalid");
  check("explore: missing coordinates are invalid, not a tap at 0,0",
    convertCall({ id: "5", name: "mobile_click", args: { element: "x" } }, 100, 100, TOUCH)[0].kind === "invalid");
  const native = parseToolCalls([{ id: "c1", type: "function", function: { name: "mobile_click", arguments: '{"element":"a","x":1,"y":2}' } }]);
  check("explore: native tool calls parse", native.length === 1 && native[0].args.y === 2);
  const inline = parseInlineCalls('Sure.\n<tool_call>{"name":"mobile_go_back","arguments":{}}</tool_call>');
  check("explore: tool calls written as text are accepted", inline.length === 1 && inline[0].name === "mobile_go_back");
  check("explore: element hints list tappables in 0-1000",
    elementHints([node({ text: "Save", bounds: { x: 0, y: 0, w: 200, h: 100 } })], 1000, 1000).includes('[tap] Button "Save" at 100,50'));

  // --- snap and leash -----------------------------------------------------
  const screen = { w: 1080, h: 2400 };
  const add = node({ text: "Add plant", bounds: { x: 100, y: 1000, w: 300, h: 120 } });
  const del = node({ text: "Delete account", bounds: { x: 100, y: 2000, w: 400, h: 120 } });
  const nodes = [add, del];
  const near = snap({ kind: "tap", x: 420, y: 1060 }, nodes, screen);
  check("explore: a tap just outside a button snaps to its centre", near.node === add && !near.miss && near.moved > 0 && (near.action as { x: number }).x === 250);
  const far = snap({ kind: "tap", x: 900, y: 400 }, nodes, screen);
  check("explore: a tap near nothing is the agent's miss", far.miss && far.node === null);
  check("explore: the leash refuses delete account", !leash({ kind: "tap", x: 300, y: 2060 }, del, nodes, []).ok);
  check("explore: a mission may allow delete", leash({ kind: "tap", x: 300, y: 2060 }, del, nodes, ["delete"]).ok);
  const pw = node({ cls: "android.widget.EditText", text: "", label: "Password", bounds: { x: 0, y: 0, w: 500, h: 100 } });
  check("explore: nothing is typed into a password field", !leash({ kind: "type", text: "x", x: 10, y: 10 }, pw, [pw], []).ok);
  check("explore: an upgrade button is a purchase", !leash({ kind: "tap", x: 1, y: 1 }, node({ text: "Upgrade to Pro" }), null, []).ok);
  check("explore: the permission dialog is not leaving the app", !leftApp("com.android.permissioncontroller", "com.x") && leftApp("com.android.chrome", "com.x"));

  // --- accessibility on Compose trees ---------------------------------------
  const { a11yFindings } = await import("../../a11y-tree.js");
  const compose = [
    node({ cls: "android.view.View", id: "plant_row", depth: 3, bounds: { x: 0, y: 600, w: 1080, h: 210 } }),
    node({ cls: "android.widget.TextView", text: "Fern", tappable: false, depth: 4, bounds: { x: 40, y: 620, w: 300, h: 60 } }),
    node({ cls: "android.view.View", id: "button_search", depth: 3, bounds: { x: 700, y: 75, w: 126, h: 126 } }),
    node({ cls: "android.view.View", label: "Search", tappable: false, depth: 4, bounds: { x: 720, y: 95, w: 80, h: 80 } }),
    node({ cls: "android.view.View", id: "button_clear", depth: 3, bounds: { x: 900, y: 75, w: 53, h: 53 } }),
  ];
  const a11y = a11yFindings(compose, { unit: "unknown" }, { step: "home" }).filter((f) => f.check === "a11y-label");
  check("explore: a control labelled by its children is not unlabelled; one with no label anywhere is",
    a11y.length === 1 && a11y[0].detail.includes("button_clear"), JSON.stringify(a11y));

  const { geometryOf, a11yKey } = await import("./loop.js");
  const tiny = [node({ cls: "android.widget.Button", label: "Clear search", depth: 3, bounds: { x: 900, y: 75, w: 53, h: 53 } })];
  const sized = a11yFindings(tiny, geometryOf({ densityDpi: 420 } as Observation), { step: "search" }).filter((f) => f.check === "a11y-target-size");
  check("explore: with the density, a 53px control at 420dpi is an undersized (20dp) target",
    sized.length === 1 && a11yKey(sized[0].detail) === "Clear search is undersized, under the 44pt minimum", JSON.stringify(sized));
  check("explore: without a density, sizes are not judged", geometryOf({} as Observation).unit === "unknown");

  // --- screen identity ----------------------------------------------------
  const listA = [node({ id: "com.x:id/title", text: "My plants" }), node({ text: "Fern 3" }), node({ text: "Add plant" })];
  const listB = [node({ id: "com.x:id/title", text: "My plants" }), node({ text: "Basil 12" }), node({ text: "Add plant" })];
  check("explore: numbers do not make a new screen", jaccard(screenTokens(listA), screenTokens(listB)) === 1);
  const map = new ScreenMap("test", mkdtempSync(path.join(os.tmpdir(), "explore-map-")));
  const a1 = map.identify(listA, dhash(p1), 2400, "n1");
  const a2 = map.identify(listB, dhash(p1), 2400, "n1");
  check("explore: the screen map recognises a revisit", a1.newEver && !a2.newEver && a1.entry.id === a2.entry.id && a1.entry.name === "My plants", a1.entry.name);

  // --- pixels ---------------------------------------------------------------
  const flat = new PNG({ width: 100, height: 200 });
  flat.data.fill(255);
  check("explore: a flat screen is blank", isBlank(PNG.sync.write(flat)).blank);
  check("explore: a textured screen is not blank", !isBlank(png(100, 200, 100, 50)).blank);
  check("explore: dhash separates different screens", hamming(dhash(png(90, 160, 200)), dhash(png(90, 160, 200, 40))) > 4);
  const shrunk = shrinkForModel(png(1080, 2400, 100), 1_000_000);
  check("explore: a phone screenshot is shrunk under the pixel budget", shrunk.width * shrunk.height <= 1_000_000 && shrunk.width < 1080);

  // --- fingerprints, bench, missions ------------------------------------------
  check("explore: messages normalise ids and numbers",
    normalizeMessage("java.lang.NullPointerException at line 42 (0xdeadbeef) 'Fern'") === normalizeMessage("java.lang.NullPointerException at line 7 (0x1) 'Basil'"));
  check("explore: a crash is one finding whatever screen reached it",
    fingerprint("g", "touch", "s1", "crash", "NPE") === fingerprint("g", "touch", "s2", "crash", "NPE")
    && fingerprint("g", "touch", "s1", "visual", "x") !== fingerprint("g", "touch", "s2", "visual", "x"));
  check("explore: bench check finds the text", benchCheck({ text: ["basil"] }, [node({ text: "Basil x3" })], "Home").passed);
  check("explore: bench check reports what is missing", !benchCheck({ text: ["mint"] }, [node({ text: "Basil" })], "Home").passed);
  check("explore: absent_text fails while the text is still there",
    !benchCheck({ text: ["8 plants"], absent_text: ["aloe vera"] }, [node({ text: "8 plants" }), node({ text: "Aloe Vera" })], "Home").passed
    && benchCheck({ text: ["8 plants"], absent_text: ["aloe vera"] }, [node({ text: "8 plants" })], "Home").passed);
  check("explore: bench text matches a content-desc", benchCheck({ text: ["ajustes"] }, [node({ label: "Ajustes" })], "Home").passed);
  check("explore: changed files name screens",
    JSON.stringify(changedWords(["app/src/main/java/x/PlantDetailScreen.kt", "ios/CareReminderView.swift"])) === '["plant","detail","care","reminder"]');
  const cards: Mission[] = [
    { id: "m1", app: "g", title: "Settings", persona: "p", goal: "change settings" },
    { id: "m2", app: "g", title: "Plants", persona: "p", goal: "add a plant", screens: ["PlantDetail"] },
    { id: "bench-1", app: "g", title: "Bench", persona: "p", goal: "x" },
  ];
  const ordered = orderMissions(cards, { surface: "touch", words: ["plantdetail"] });
  check("explore: today's changes order the cards, bench cards stay out", ordered.map((m) => m.id).join() === "m2,m1");
  check("explore: bench mode runs only bench cards", orderMissions(cards, { surface: "touch", bench: true }).map((m) => m.id).join() === "bench-1");

  check("explore: a sign-in flow that needs a password is skipped without one; one with its own account is not",
    missingFlowVars("greenfolio/sign-in.yaml", {}).join() === "GREENFOLIO_TEST_EMAIL,GREENFOLIO_TEST_PASSWORD"
    && missingFlowVars("greenfolio/sign-in.yaml", { GREENFOLIO_TEST_EMAIL: "a", GREENFOLIO_TEST_PASSWORD: "b" }).length === 0
    && missingFlowVars("bug-garden/sign-in.yaml", {}).length === 0);

  // --- params ---------------------------------------------------------------
  check("explore: app_id is required", paramsProblem({}) !== null && paramsProblem({ app_id: "com.x" }) === null);
  const cfg = modelConfigs({ app_id: "x" }, {});
  check("explore: defaults are ultra's pilot and vision", cfg.model.model === "pilot" && cfg.judge?.model === "vision" && cfg.model.baseUrl.includes("ultra"));
  check("explore: the night queue's gateway is used when nothing else names one",
    modelConfigs({ app_id: "x" }, { HARNESS_GATEWAY: "http://127.0.0.1:4000" }).model.baseUrl === "http://127.0.0.1:4000");
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "explore-key-"));
  writeFileSync(path.join(keyDir, "fleet.key"), "sk-file\n");
  check("explore: the key comes from the night queue, then the harness's file",
    (await gatewayKey({ HARNESS_KEY: "sk-night" })) === "sk-night"
    && (await gatewayKey({ FLEET_EXPLORE_API_KEY_FILE: path.join(keyDir, "fleet.key") })) === "sk-file");
  check("explore: bench mode has no judge", modelConfigs({ app_id: "x", bench: true }, {}).judge === null);
  let condThrew = false;
  try { parseConditions(["dark", "sideways"]); } catch { condThrew = true; }
  check("explore: an unknown condition is refused", condThrew);
  check("explore: judge output keeps only named, enabled classes",
    visualIssuesFrom(parseJsonLoose('```json\n{"issues":[{"class":"overlap","description":"a over b"},{"class":"vibes","description":"meh"},{"class":"clipped","description":"x"}]}\n```'), ["clipped"]).length === 1);

  // --- maestro ----------------------------------------------------------------
  const ex: Executed[] = [
    { step: 1, kind: "action", action: { kind: "tap", x: 540, y: 1200 }, settleMs: 900 },
    { step: 2, kind: "action", action: { kind: "type", text: "Fern", x: 540, y: 600, enter: true }, settleMs: 500 },
    { step: 3, kind: "relaunch" },
    { step: 4, kind: "action", action: { kind: "key", key: "down" }, settleMs: 450 },
  ];
  const yaml = toMaestro({ appId: "com.x", executed: ex, screen: { w: 1080, h: 2400 }, setupFlow: "bug-garden/sign-in.yaml", launchArgs: ["garden_defects=false"] });
  check("explore: the Maestro file taps in percentages, types, relaunches and presses D-pad keys",
    yaml.includes('point: "50%,50%"') && yaml.includes('inputText: "Fern"') && yaml.includes("- launchApp\n")
    && yaml.includes("Remote Dpad Down") && yaml.includes("garden_defects: \"false\"") && yaml.includes("clearState: true"), yaml);

  // --- candidates ---------------------------------------------------------------
  const scr = { id: "s", name: "S", tokens: [], hash: null, firstSeen: "", lastSeen: "", visits: 1, nights: [] };
  const cands = [
    { check: "visual" as const, severity: "medium" as const, title: "", detail: "", step: 1, screen: scr, upTo: 1, key: "overlap", source: "judge" as const, shot: "" },
    { check: "crash" as const, severity: "high" as const, title: "", detail: "", step: 5, screen: scr, upTo: 4, key: "NPE", source: "oracle" as const, shot: "" },
    { check: "crash" as const, severity: "high" as const, title: "", detail: "", step: 9, screen: scr, upTo: 8, key: "NPE", source: "oracle" as const, shot: "" },
  ];
  const picked = pickCandidates(cands, "g", "touch", 5);
  check("explore: candidates are replayed worst first, one per fingerprint", picked.length === 2 && picked[0].c.check === "crash");
  check("explore: a crash is filed on its log; a visual needs a replay",
    fileable({ ...cands[1], attempts: 2, reproduced: 0, replayNotes: [] }) && !fileable({ ...cands[0], attempts: 2, reproduced: 0, replayNotes: [] }));

  // --- a whole mission against a fake device and a fake model -----------------
  await missionChecks(check);
}

/**
 * The fake app: a home screen with four buttons. "Add plant" opens a form,
 * "Water" does nothing (a dead control), "Delete account" is dangerous, and
 * "Sync" crashes the app.
 */
class FakeApp implements Actuator {
  readonly target: Target = { id: "fake-1", platform: "android", kind: "device", driver: "adb" };
  readonly caps = TOUCH;
  screen: "home" | "form" = "home";
  crashed = 0;
  private reported = 0;
  taps: string[] = [];
  resets = 0;
  private shots = { home: png(108, 240, 140), form: png(108, 240, 140, 60) };
  private nodes(): A11yNode[] {
    return this.screen === "home"
      ? [
        node({ id: "app:id/title", text: "Garden", cls: "android.widget.TextView", tappable: false, bounds: { x: 10, y: 10, w: 80, h: 20 } }),
        node({ text: "Add plant", bounds: { x: 0, y: 60, w: 108, h: 20 } }),
        node({ text: "Water", bounds: { x: 0, y: 100, w: 108, h: 20 } }),
        node({ text: "Delete account", bounds: { x: 0, y: 140, w: 108, h: 20 } }),
        node({ text: "Sync", bounds: { x: 0, y: 180, w: 108, h: 20 } }),
      ]
      : [
        node({ id: "app:id/title", text: "New plant", cls: "android.widget.TextView", tappable: false, bounds: { x: 10, y: 10, w: 80, h: 20 } }),
        node({ cls: "android.widget.EditText", label: "Name", bounds: { x: 0, y: 60, w: 108, h: 20 } }),
        node({ text: "Save", bounds: { x: 0, y: 200, w: 108, h: 20 } }),
      ];
  }
  async reset() { this.screen = "home"; this.resets++; }
  async launch() { this.screen = "home"; }
  async observe(): Promise<Observation> {
    return { png: this.shots[this.screen], width: 108, height: 240, nodes: this.nodes(), treeSource: "fake", foreground: "com.fake", focus: null, keyboard: false };
  }
  async act(a: Action) {
    if (a.kind !== "tap") { if (a.kind === "key" && a.key === "back") this.screen = "home"; return; }
    const hit = this.nodes().find((n) => n.tappable && n.bounds && a.x >= n.bounds.x && a.x <= n.bounds.x + n.bounds.w && a.y >= n.bounds.y && a.y <= n.bounds.y + n.bounds.h);
    const name = hit?.text || hit?.label || "nothing";
    this.taps.push(name);
    if (name === "Add plant") this.screen = "form";
    else if (name === "Save") this.screen = "home";
    else if (name === "Sync") { this.crashed++; this.screen = "home"; }
  }
  async crashes(): Promise<CrashReport> {
    const fresh = this.crashed - this.reported;
    this.reported = this.crashed;
    return { count: fresh, signatures: Array(fresh).fill("java.lang.IllegalStateException: sync 42"), excerpt: "FATAL EXCEPTION", problems: [] };
  }
  async close() {}
}

/** A chat-completions endpoint that answers each request with the next scripted call. */
function fakeModel(script: { name: string; args: Record<string, unknown> }[]): Promise<{ server: Server; url: string; requests: number[] }> {
  const requests: number[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        requests.push(body.length);
        const next = script.shift() ?? { name: "answer", args: { content: "done" } };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }],
          usage: { prompt_tokens: 1000 + requests.length, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 500 } },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`, requests });
    });
  });
}

async function missionChecks(check: Check) {
  // Coordinates in 0-1000 of a 108x240 screen: buttons sit at y = 70, 110, 150, 190 px.
  const y = (px: number) => Math.round((px / 239) * 1000);
  const { server, url, requests } = await fakeModel([
    { name: "mobile_click", args: { element: "Water", x: 500, y: y(110) } },
    { name: "mobile_click", args: { element: "Water again", x: 500, y: y(110) } },
    { name: "mobile_click", args: { element: "Delete account", x: 500, y: y(150) } },
    { name: "mobile_click", args: { element: "Add plant", x: 500, y: y(70) } },
    { name: "mobile_click", args: { element: "Save", x: 500, y: y(210) } },
    { name: "mobile_click", args: { element: "Sync", x: 500, y: y(190) } },
    { name: "report_issue", args: { kind: "visual", description: "title overlaps" } },
    { name: "answer", args: { content: "Explored the garden." } },
  ]);
  try {
    const app = new FakeApp();
    const dir = mkdtempSync(path.join(os.tmpdir(), "explore-run-"));
    const deps: LoopDeps = {
      actuator: app, appId: "com.fake", appName: "Garden", appFile: null,
      model: { baseUrl: url, model: "fake" }, judge: null,
      map: new ScreenMap("fake", path.join(dir, "map")), runDir: dir, night: "n1",
      log: () => {}, canRunFlows: false, deadline: Date.now() + 60_000,
    };
    const m: Mission = { id: "m", app: "fake", title: "Look around", persona: "a new user", goal: "try everything", budget: { steps: 12 } };
    const r = await runMission(m, deps);
    check("explore(loop): the mission ends on the model's answer", r.stats.endedBy === "answer" && r.answer === "Explored the garden.", JSON.stringify(r.stats));
    check("explore(loop): the dead control is a candidate after its second tap", r.candidates.some((c) => c.check === "dead_control" && c.title.includes("Water")),
      JSON.stringify(r.candidates.map((c) => c.check)));
    check("explore(loop): delete account was refused and never tapped", r.stats.refused === 1 && !app.taps.includes("Delete account"), app.taps.join(","));
    const crash = r.candidates.find((c) => c.check === "crash");
    check("explore(loop): the crash is a candidate with its signature", !!crash && crash.key.startsWith("java.lang.IllegalStateException"));
    check("explore(loop): the agent's own report is a lead, marked as such", r.candidates.some((c) => c.source === "agent" && c.check === "visual"));
    check("explore(loop): the model saw one request per step", requests.length === r.stats.steps, `${requests.length} vs ${r.stats.steps}`);
    check("explore(loop): screenshots stay bounded in the conversation", requests[requests.length - 1] < requests[2] * 4, requests.join(","));

    const resetsBefore = app.resets;
    const c = await confirm(crash!, r, deps, 2);
    check("explore(loop): a crash replays from a clean install and reproduces twice", c.reproduced === 2 && app.resets === resetsBefore + 2, c.replayNotes.join("; "));
    const dead = r.candidates.find((x) => x.check === "dead_control")!;
    const cd = await confirm(dead, r, deps, 1);
    check("explore(loop): the dead control reproduces on replay", cd.reproduced === 1, cd.replayNotes.join("; "));
    const agentVisual = r.candidates.find((x) => x.source === "agent")!;
    const cv = await confirm(agentVisual, r, deps, 1);
    check("explore(loop): without a judge an agent's visual report never reproduces", cv.reproduced === 0 && !fileable(cv));
  } finally {
    server.close();
  }
}
