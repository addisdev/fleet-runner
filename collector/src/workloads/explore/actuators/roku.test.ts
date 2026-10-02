/**
 * The Roku actuator's decisions, without a Roku.
 *
 * Nothing here opens a socket to a device or runs tvloop. The pure helpers
 * are checked against shapes taken from tvloop itself (the fake Roku's agent
 * tree, the console parser's crash event, `tvloop replay --json`), and the
 * actuator is driven through its one seam -- the tvloop modules it is handed
 * -- with a session that records what it was asked to do. That covers what
 * this file is responsible for: which key is which, what the model is told
 * about focus, what counts as a crash and when, what a Roku refuses, and what
 * a replay file says.
 *
 * Talking to a real tvloop, against its fake Roku, is
 * scripts/explore-tv-check.ts.
 */
import { ALL_KEYS, type Action } from "../types.js";
import { parseReplayOutput, tvloopFlow, tvloopFlowFile } from "../replay-tvloop.js";
import {
  RokuActuator, TVLOOP_KEYS, crashReportFromEvents, launchParams, nodesFromTree, parseActiveApp, parseLogNdjson,
  rokuFocusLine, type TvLogEvent, type TvSession, type TvTree, type TvloopKey,
} from "./roku.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

/** The fake Roku's agent tree after two presses of Right (fakeroku/src/agent.ts). */
const TREE: TvTree = {
  capturedAt: "2026-10-02T00:00:00.000Z",
  agentVersion: "0.1.0",
  focusChain: ["MainScene", "HomeGrid", "Tile2"],
  root: {
    id: "MainScene", type: "Scene", visible: true,
    children: [
      {
        id: "HomeGrid", type: "RowList", visible: true, focusable: true,
        bounds: { x: 40, y: 240, w: 1200, h: 180 },
        children: [0, 1, 2, 3, 4].map((i) => ({
          id: `Tile${i}`, type: "Poster", visible: true, focusable: true, focused: i === 2,
          bounds: { x: 40 + i * 233, y: 240, w: 213, h: 180 },
          ...(i === 2 ? { fields: { title: "Rain on the porch" } } : {}),
        })),
      },
      { id: "PlayButton", type: "Button", visible: false, focusable: true },
    ],
  },
};

/** A crash, as tvloop's console parser emits it: one event, frames attached. */
const CRASH: TvLogEvent = {
  v: 1, ts: "2026-10-02T18:04:11.482Z", seq: 41, kind: "crash", level: "error",
  message: "Invalid value for left-hand side of operator",
  frames: [{ file: "pkg:/components/DetailPage.brs", line: 84, function: "onKeyEvent", mapped: false }],
  raw: "Current Function:\n084:      ' <- error here\nInvalid value for left-hand side of operator (runtime error &he4) in pkg:/components/DetailPage.brs(84)\n\nBacktrace:\n#0  Function onKeyEvent() As Void\n   file/line: pkg:/components/DetailPage.brs(84)",
};
const PRINT: TvLogEvent = {
  v: 1, ts: "2026-10-02T18:04:10.000Z", seq: 40, kind: "print", level: "info", message: "Channel started", raw: "Channel started",
};

/** A 24-byte PNG header saying 1280x720: all `observe` reads from the image. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A tvloop session that records presses and lets the test feed its console. */
function fakeSession(opts: { agent?: boolean; ui?: { width: number; height: number } } = {}) {
  const pressed: string[] = [];
  const typed: string[] = [];
  const launches: (Record<string, string> | undefined)[] = [];
  let feed: ((e: TvLogEvent) => void) | null = null;
  const queue: TvLogEvent[] = [];
  let closed = false;
  const session: TvSession = {
    capabilities: { has: (c) => c === "inspect" && opts.agent !== false },
    info: async () => ({ resolution: opts.ui ?? { width: 1280, height: 720 }, model: "4800X", firmware: "14.5.4" }),
    install: async () => ({ installed: true, durationMs: 1 }),
    launch: async (d) => { launches.push(d); },
    press: async (keys) => { pressed.push(...keys); },
    type: async (t) => { typed.push(t); },
    screenshot: async () => ({ data: new Uint8Array([0xff, 0xd8]), format: "jpeg", width: 1280, height: 720 }),
    inspect: async () => TREE,
    async *logs() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { feed = (e) => { queue.push(e); feed = null; r(); }; });
      }
    },
    close: async () => { closed = true; feed?.({ ...PRINT, seq: -1 }); },
  };
  return { session, pressed, typed, launches, emit: (e: TvLogEvent) => (feed ? feed(e) : queue.push(e)) };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

export async function runRokuActuatorChecks(check: Check): Promise<void> {
  // --- keys -----------------------------------------------------------------
  check("roku: every contract key has a tvloop key", ALL_KEYS.every((k) => typeof TVLOOP_KEYS[k] === "string"));
  check("roku: no two contract keys press the same button",
    new Set(Object.values(TVLOOP_KEYS)).size === ALL_KEYS.length);
  check("roku: menu is the * (options) button, play_pause the toggling Play, fast_forward is forward",
    TVLOOP_KEYS.menu === "options" && TVLOOP_KEYS.play_pause === "playpause" && TVLOOP_KEYS.fast_forward === "forward");

  // --- tree and focus --------------------------------------------------------
  const nodes = nodesFromTree(TREE);
  check("roku: the tree flattens preorder with depth, invisible nodes left out",
    nodes.map((n) => `${n.depth}:${n.id}`).join(",") === "0:MainScene,1:HomeGrid,2:Tile0,2:Tile1,2:Tile2,2:Tile3,2:Tile4",
    nodes.map((n) => `${n.depth}:${n.id}`).join(","));
  check("roku: exactly the agent's focused node is focused, and nothing on a Roku is tappable",
    nodes.filter((n) => n.focused).map((n) => n.id).join() === "Tile2" && nodes.every((n) => !n.tappable));
  check("roku: a node's title field becomes its text and label", nodes[4].text === "Rain on the porch" && nodes[4].label === "Rain on the porch");
  const scaled = nodesFromTree(TREE, { x: 1.5, y: 1.5 });
  check("roku: bounds scale into screenshot pixels (720p tree, 1080p picture)",
    JSON.stringify(scaled[4].bounds) === JSON.stringify({ x: 759, y: 360, w: 320, h: 270 }), JSON.stringify(scaled[4].bounds));
  const line = rokuFocusLine(TREE, nodes);
  check("roku: the focus line is the chain, ending in the focused node with its text and place",
    line === `MainScene > HomeGrid > 'Tile2 "Rain on the porch"' (focused at 506,240 213x180)`, String(line));
  check("roku: an empty chain says nothing has focus", rokuFocusLine({ ...TREE, focusChain: [] }, nodes) === "nothing has focus");
  check("roku: no tree, no focus line", rokuFocusLine(null, null) === null);

  // --- ECP and launch parameters --------------------------------------------
  check("roku: the dev channel in front",
    parseActiveApp('<active-app><app id="dev" type="appl" version="1.0.0">tvloop sample</app></active-app>') === "dev");
  check("roku: Roku Home is no app at all", parseActiveApp("<active-app><app>Roku</app></active-app>") === null);
  check("roku: launch arguments are key=value parameters",
    JSON.stringify(launchParams(["contentId=42", "mediaType=movie"])) === '{"contentId":"42","mediaType":"movie"}');
  let refused = "";
  try {
    launchParams(["-uiTestSignedOut"]);
  } catch (e) {
    refused = (e as Error).message;
  }
  check("roku: an iOS-style flag is refused by name", refused.includes("-uiTestSignedOut"), refused);

  // --- crashes ----------------------------------------------------------------
  const report = crashReportFromEvents([PRINT, CRASH]);
  check("roku: one crash event is one crash, prints are not",
    report.count === 1 && report.signatures[0] === "Invalid value for left-hand side of operator at onKeyEvent (pkg:/components/DetailPage.brs:84)",
    JSON.stringify(report.signatures));
  check("roku: the excerpt is the crash block itself", report.excerpt.startsWith("Current Function:") && report.excerpt.includes("Backtrace:"));
  const nd = parseLogNdjson(`${JSON.stringify(PRINT)}\n${JSON.stringify(CRASH)}\nnot json\n\n`);
  check("roku: tvloop logs --json parses line by line", nd.events.length === 2 && crashReportFromEvents(nd.events).count === 1);
  check("roku: a garbled line is counted as a problem, not dropped quietly",
    nd.problems.length === 1 && nd.problems[0].startsWith("1 line"), JSON.stringify(nd.problems));

  // --- the actuator, through its seam ----------------------------------------
  {
    const f = fakeSession({ ui: { width: 1280, height: 720 } });
    const target = { id: "roku-FAKE0000001", platform: "roku", driver: "roku" };
    const toPng = () => pngHeader(1920, 1080);
    const a = await RokuActuator.open(target, {
      host: "127.0.0.1", password: "rokudev", ports: { ecp: 9 }, modules: { connectRoku: async () => f.session, toPng },
    });
    check("roku: with the agent, a Roku is a D-pad surface with a tree and every key",
      a.caps.surface === "dpad" && a.caps.tree && a.caps.keys.length === ALL_KEYS.length);

    await a.act({ kind: "key", key: "right" });
    await a.act({ kind: "key", key: "menu" });
    check("roku: keys go to tvloop by its names", f.pressed.join(",") === "right,options", f.pressed.join(","));

    for (const act of [
      { kind: "tap", x: 1, y: 1 }, { kind: "swipe", x1: 0, y1: 0, x2: 1, y2: 1 }, { kind: "scroll", direction: "down" },
      { kind: "long_press", x: 1, y: 1 }, { kind: "type", text: "x", x: 5, y: 5 },
    ] as Action[]) {
      let msg = "";
      try {
        await a.act(act);
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`roku: a ${act.kind}${act.kind === "type" ? " at a position" : ""} is refused, not ignored`, /no touch input/.test(msg), msg);
    }
    f.pressed.length = 0;
    await a.act({ kind: "type", text: "rain", overwrite: true, enter: true });
    check("roku: typing over a field is backspaces, the text, then enter",
      f.pressed.filter((k) => k === "backspace").length === 40 && f.typed.join() === "rain" && f.pressed.at(-1) === "enter");

    const o = await a.observe();
    check("roku: observe reports the picture's own size", o.width === 1920 && o.height === 1080);
    check("roku: ...the tree scaled to it", JSON.stringify(o.nodes?.find((n) => n.focused)?.bounds) === JSON.stringify({ x: 759, y: 360, w: 320, h: 270 }));
    check("roku: ...and a focus line", (o.focus ?? "").startsWith("MainScene > HomeGrid > 'Tile2"), String(o.focus));
    check("roku: an unreachable ECP is an unknown foreground, not a failed step", o.foreground === null);

    f.emit(CRASH);
    await tick();
    const first = await a.crashes("dev");
    check("roku: the first crashes() call is the baseline, whatever came before", first.count === 0);
    f.emit(PRINT);
    f.emit({ ...CRASH, seq: 99 });
    await tick();
    const second = await a.crashes("dev");
    check("roku: a crash after the baseline is reported once", second.count === 1 && (await a.crashes("dev")).count === 0);
    check("roku: another channel's crashes are said to be invisible",
      (await a.crashes("12")).problems.some((p) => p.includes("sideloaded channel only")));
    await a.close();
  }
  {
    const f = fakeSession({ agent: false });
    const a = await RokuActuator.open({ id: "roku-x", platform: "roku" }, {
      host: "127.0.0.1", password: "rokudev", ports: { ecp: 9 },
      modules: { connectRoku: async () => f.session, toPng: () => pngHeader(1280, 720) },
    });
    const o = await a.observe();
    check("roku: without the agent there is no tree, and the focus line says to look at the picture",
      !a.caps.tree && o.nodes === null && /no tvloop agent/.test(o.focus ?? ""), String(o.focus));
    await a.close();
  }
  {
    let msg = "";
    try {
      await RokuActuator.open({ id: "roku-x", platform: "roku" }, { host: "h", password: "", modules: {} as never });
    } catch (e) {
      msg = (e as Error).message;
    }
    check("roku: no password is refused up front, with the command that adds one", /add-generic-password/.test(msg), msg);
  }

  // --- replay files ------------------------------------------------------------
  const keys: Action[] = [
    { kind: "key", key: "right" }, { kind: "key", key: "right" }, { kind: "wait", ms: 1200 },
    { kind: "key", key: "select" }, { kind: "key", key: "play_pause" },
  ];
  const doc = tvloopFlow(keys, { name: "details-of-third", settleMs: 500, focus: "PlayButton" });
  check("roku: a replay starts with a launch and a wait for the first scene",
    doc.steps[0] === "launch" && JSON.stringify(doc.steps[1]) === '{"wait":"3000ms"}');
  check("roku: each press is followed by a settle, unless the trajectory waited itself",
    JSON.stringify(doc.steps.slice(2, 9)) ===
      '[{"press":["right"]},{"wait":"500ms"},{"press":["right"]},{"wait":"1200ms"},{"press":["select"]},{"wait":"500ms"},{"press":["playpause"]}]',
    JSON.stringify(doc.steps.slice(2, 9)));
  check("roku: it ends asserting focus, then no errors, one per step",
    JSON.stringify(doc.steps.slice(-2)) === '[{"assert":{"focus":"PlayButton"}},{"assert":{"noErrors":true}}]');
  check("roku: launch parameters become a deeplink launch",
    JSON.stringify(tvloopFlow([], { name: "x", launch: { contentId: "42" } }).steps[0]) === '{"launch":{"deeplink":{"contentId":"42"}}}');
  const file = tvloopFlowFile(doc);
  check("roku: the file is JSON tvloop reads by its extension, device any",
    JSON.parse(file).name === "details-of-third" && JSON.parse(file).device === "any" && file.endsWith("\n"));
  let tapRefused = "";
  try {
    tvloopFlow([{ kind: "key", key: "down" }, { kind: "tap", x: 3, y: 4 }], { name: "x" });
  } catch (e) {
    tapRefused = (e as Error).message;
  }
  check("roku: a trajectory with a tap cannot become a TV replay, and says which action", /action 2 is a tap/.test(tapRefused), tapRefused);
  check("roku: every replay key is one tvloop knows",
    doc.steps.flatMap((s) => (typeof s === "object" && "press" in s ? s.press : [])).every((k: TvloopKey) => Object.values(TVLOOP_KEYS).includes(k) || k === "backspace"));

  // --- replay results -----------------------------------------------------------
  const passed = parseReplayOutput(JSON.stringify({ results: [{ flow: "x", status: "passed", durationMs: 1585, steps: [] }] }, null, 2), 0);
  check("roku: a passing replay", passed.status === "passed" && passed.durationMs === 1585);
  const failed = parseReplayOutput(`warning: something\n${JSON.stringify({
    results: [{
      flow: "crash", status: "failed", durationMs: 4000,
      steps: [{ label: "launch", status: "passed" }, { label: "assert no errors", status: "failed", message: "1 error logged during this flow. First: Divide by zero" }],
    }],
  })}`, 1);
  check("roku: a failed replay names the step and tvloop's message, past a stray line",
    failed.status === "failed" && failed.failedStep === "assert no errors" && /Divide by zero/.test(failed.message ?? ""), JSON.stringify(failed));
  const broken = parseReplayOutput("✗ No device configured and none given on the command line", 1);
  check("roku: no result at all is an error, with what tvloop said", broken.status === "error" && /No device configured/.test(broken.message ?? ""));
}
