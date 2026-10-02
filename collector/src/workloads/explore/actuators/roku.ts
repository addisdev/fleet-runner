/**
 * Reaching a Roku -- a real one, or tvloop's fake -- through tvloop.
 *
 * tvloop already knows how to talk to a Roku: ECP for keys and launches, the
 * developer web server (behind digest auth) for sideloads and screenshots, the
 * debug console for logs, and an optional in-app agent for the SceneGraph
 * tree and focus chain. The fleet does not re-implement any of that. This file
 * loads tvloop's own adapter from a checkout on the host and puts the explore
 * contract (types.ts) on top of it.
 *
 * ## Why the adapter, and not `openDevice`
 *
 * tvloop's README offers `openDevice()` for embedding, and it would work --
 * except for the password. `openDevice` starts an in-process daemon that reads
 * the developer password from `process.env.TVLOOP_PASSWORD`, so using it means
 * putting the Roku password in the executor's own environment, where every
 * adb, xcodebuild and npx the executor spawns afterwards inherits it. The
 * adapter one layer down (`RokuPlatform.connect(ref, { password })`) takes the
 * password as an argument and nothing else sees it. Same code underneath:
 * `openDevice` is the daemon wrapped around exactly this session.
 *
 * ## Why a dynamic import from a checkout
 *
 * tvloop is not on npm yet and is not a dependency of the collector. The
 * fleet's tvloop workload already runs it from a built checkout on the host
 * (`FLEET_TVLOOP_DIR`, default `~/tvloop`), so this uses the same one, loaded
 * at run time. A host without it fails here with the command that builds it,
 * and nothing else in the collector notices tvloop exists.
 *
 * ## What a Roku cannot do, said rather than faked
 *
 *   - No touch. Taps, swipes, scrolls and long presses throw, so a model
 *     offered the wrong tool hears about it instead of thinking it pressed
 *     something.
 *   - No "clear data". A channel's registry survives a sideload, and ECP has
 *     no `pm clear`. `reset` re-sideloads and starts from Roku Home, which is
 *     as clean as a Roku gets without the channel's own cooperation.
 *   - No tree without the in-app agent. A channel that does not bundle
 *     tvloop's BrightScript agent gives pictures only; `caps.tree` says so.
 *   - Screenshots are JPEG. The contract says PNG, so each one is decoded and
 *     re-encoded with tvloop's own image code (a few tens of milliseconds at
 *     720p, more at 1080p).
 *
 * The pure helpers sit at the top and are exported, so the parts that decide
 * which key is which, what the focus line says and what counts as a crash can
 * be tested without a television.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { A11yNode } from "../../../a11y-tree.js";
import type { Target } from "../../types.js";
import { ALL_KEYS, type Action, type Actuator, type ActuatorCaps, type CrashReport, type Key, type Observation } from "../types.js";

// ---------------------------------------------------------------------------
// The slice of tvloop this file uses
// ---------------------------------------------------------------------------
//
// Written out structurally rather than imported, because importing tvloop's
// types would make it a compile-time dependency of the collector, which is the
// thing the dynamic import exists to avoid. These mirror @tvloop/core's
// `Session`, `NodeTree`, `Frame` and `LogEvent`; if tvloop changes them,
// scripts/explore-tv-check.ts, which drives tvloop's real modules against its
// fake Roku, is where it shows.

/** tvloop's key names (core/src/keys.ts). */
export type TvloopKey =
  | "up" | "down" | "left" | "right" | "select" | "back" | "home"
  | "play" | "pause" | "playpause" | "rewind" | "forward" | "replay"
  | "info" | "options" | "backspace" | "enter" | "search"
  | "volumeup" | "volumedown" | "mute" | "power";

export type TvFrame = { data: Uint8Array; format: "jpeg" | "png"; width: number; height: number };

export type TvNode = {
  id?: string;
  type: string;
  visible?: boolean;
  focused?: boolean;
  focusable?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  fields?: Record<string, unknown>;
  children?: TvNode[];
};

export type TvTree = { root: TvNode; focusChain: string[]; capturedAt?: string; agentVersion?: string };

export type TvStackFrame = { file: string; line: number; function?: string; mapped?: boolean };

/** One structured log event, as `tvloop logs --json` prints it, one per line. */
export type TvLogEvent = {
  v: number;
  ts: string;
  seq: number;
  kind: string;
  level: string;
  message: string;
  frames?: TvStackFrame[];
  run?: number;
  raw: string;
};

export type TvSession = {
  capabilities: { has(cap: string): boolean };
  info(): Promise<{ resolution: { width: number; height: number }; model: string; firmware: string }>;
  install(pkg: { path: string; bytes: number; hash: string; files: string[] }, opts?: { skipIfUnchanged?: boolean }): Promise<{ installed: boolean; durationMs: number }>;
  launch(deeplink?: Record<string, string>): Promise<void>;
  press(keys: TvloopKey[], opts?: { gapMs?: number }): Promise<void>;
  type(text: string): Promise<void>;
  screenshot(): Promise<TvFrame>;
  inspect(): Promise<TvTree>;
  logs(filter?: Record<string, unknown>): AsyncIterable<TvLogEvent>;
  close(): Promise<void>;
};

/** What `loadTvloop` hands back: the adapter and tvloop's image helpers. */
export type TvloopModules = {
  connectRoku(
    ref: { id: string; platform: "roku"; host: string; transport?: Record<string, unknown> },
    opts: { password?: string },
  ): Promise<TvSession>;
  /** JPEG or PNG bytes in, PNG bytes out. */
  toPng(data: Uint8Array): Buffer;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The explore contract's keys as tvloop names them. tvloop maps those onto
 * ECP (`Select`, `Rev`, `Fwd`, `Info`...), so this table is one hop, not two.
 *
 * `menu` is the remote's `*` button, which ECP calls Info and Roku's own
 * guidelines call the options key: it is what "menu" does on a Roku.
 * `play_pause` is ECP `Play`, which toggles; Roku remotes have no separate
 * pause. Every key the contract names exists on a Roku, so caps.keys is all
 * of them -- whether `home` (which leaves the channel) may be pressed is the
 * leash's decision, not this file's.
 */
export const TVLOOP_KEYS: Record<Key, TvloopKey> = {
  up: "up", down: "down", left: "left", right: "right", select: "select",
  back: "back", home: "home", menu: "options",
  play_pause: "playpause", rewind: "rewind", fast_forward: "forward",
  enter: "enter", search: "search",
};

/**
 * The checkout tvloop is loaded from: the job's own `dir` if it named one,
 * then FLEET_TVLOOP_DIR, then ~/tvloop -- the same precedence the tvloop
 * workload uses, so both find the same build.
 */
export function tvloopCheckout(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit || env.FLEET_TVLOOP_DIR || path.join(os.homedir(), "tvloop");
}

/** The built files this actuator imports, relative to the checkout. */
export const TVLOOP_MODULES = {
  roku: "packages/adapter-roku/dist/index.js",
  screen: "packages/screen/dist/index.js",
} as const;

/** The app id ECP says is in front, from `query/active-app`, or null for Roku Home. */
export function parseActiveApp(xml: string): string | null {
  // Roku Home answers `<app>Roku</app>` with no id; any channel has one.
  const m = /<app\b[^>]*\bid="([^"]+)"/.exec(xml);
  return m ? m[1] : null;
}

/**
 * Launch arguments to ECP launch parameters.
 *
 * A Roku channel receives its launch parameters as a flat string map in
 * `main(args)`, which is exactly what Android's string extras are, so the rule
 * is the same one android.ts states: `key=value` or a loud refusal. An iOS
 * flag like `-uiTestSignedOut` must not quietly launch a different state.
 */
export function launchParams(args: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = /^([A-Za-z_][\w.]*)=(.*)$/.exec(a);
    if (!m) throw new Error(`launch argument ${JSON.stringify(a)} is not key=value; a Roku launch takes string parameters only`);
    out[m[1]] = m[2];
  }
  return out;
}

/** A label a model can read off a SceneGraph node: its text if the agent sent any, else nothing. */
function nodeText(n: TvNode): string {
  const f = n.fields ?? {};
  for (const k of ["text", "title", "description", "label"]) {
    const v = f[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * The agent's tree as the fleet's A11yNode list, bounds scaled into
 * screenshot pixels.
 *
 * Preorder, with depth, which is the order and shape uiautomator's dump gives
 * and focusLine-style walkers expect. Invisible subtrees are left out: a
 * hidden PlayButton is not on the screen, and listing it would invite the
 * model to aim for something it cannot reach -- the commonest cause of "focus
 * went nowhere" on a Roku (tvloop's flow runner says the same).
 *
 * `scale` is screenshot pixels per tree unit. The agent reports
 * `boundingRect()` in the UI's own resolution; the screenshot is captured at
 * the output resolution; on the fake both are 1280x720.
 *
 * Two things about the REAL agent (brightscript/tvloop-agent in the tvloop
 * repo), read from its source and not yet seen on hardware: it sends no node
 * text at all -- type, id, visibility, focus and bounds only -- so `text` is
 * empty on a real channel and the model reads ids; and it calls
 * `boundingRect()`, which SceneGraph documents as relative to the node's
 * parent, where `sceneBoundingRect()` would be in scene coordinates. Until
 * that changes, nested nodes' bounds on a real Roku are offsets, not places.
 */
export function nodesFromTree(tree: TvTree, scale: { x: number; y: number } = { x: 1, y: 1 }): A11yNode[] {
  const out: A11yNode[] = [];
  const walk = (n: TvNode, depth: number) => {
    if (n.visible === false) return;
    const text = nodeText(n);
    out.push({
      cls: n.type,
      text,
      // SceneGraph has no accessibility label separate from its text, so the
      // two are the same. The node id stays in `id`: it is what a developer
      // wrote down, and what tvloop's focus chain is made of.
      label: text,
      id: n.id ?? "",
      value: "",
      tappable: false,
      enabled: true,
      bounds: n.bounds
        ? {
            x: Math.round(n.bounds.x * scale.x), y: Math.round(n.bounds.y * scale.y),
            w: Math.round(n.bounds.w * scale.x), h: Math.round(n.bounds.h * scale.y),
          }
        : null,
      depth,
      focused: n.focused === true,
    });
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(tree.root, 0);
  return out;
}

/**
 * Where focus is, as one line a model can read.
 *
 * tvloop's focus chain is already the answer -- the path from the scene down
 * `focusedChild` to the node holding focus -- so this is that chain, with the
 * focused node's text and position added when the tree has them:
 *
 *   MainScene > HomeGrid > 'Tile2' (focused at 506,240 213x180)
 *
 * The same shape as android.ts's focusLine, so a prompt written for one reads
 * the other.
 */
export function rokuFocusLine(tree: TvTree | null, nodes: A11yNode[] | null): string | null {
  if (!tree) return null;
  const chain = tree.focusChain ?? [];
  if (chain.length === 0) return "nothing has focus";
  const last = chain[chain.length - 1];
  const node = nodes?.find((n) => n.focused) ?? nodes?.find((n) => n.id === last);
  const name = node?.text ? `${last} "${node.text}"` : last;
  const where = node?.bounds ? ` at ${node.bounds.x},${node.bounds.y} ${node.bounds.w}x${node.bounds.h}` : "";
  return [...chain.slice(0, -1), `'${name}' (focused${where})`].join(" > ");
}

/**
 * Crash events into the contract's CrashReport.
 *
 * tvloop's console parser already turns a Roku crash -- nine lines of
 * "Current Function", the error, a backtrace, the locals -- into ONE event of
 * kind `crash` with its frames attached, so counting is counting events, not
 * reassembling lines. The signature is the message and the innermost frame,
 * which is what tells two crashes apart and what the finding's fingerprint is
 * built from.
 */
export function crashReportFromEvents(events: TvLogEvent[]): CrashReport {
  const crashes = events.filter((e) => e.kind === "crash");
  const signatures = crashes.map((e) => {
    const f = e.frames?.[0];
    const where = f ? ` at ${f.function ? `${f.function} ` : ""}(${f.file}:${f.line})` : "";
    return `${e.message}${where}`.slice(0, 200);
  });
  const excerpt = crashes.length
    ? crashes.slice(-1)[0].raw.split("\n").slice(0, 40).join("\n")
    : "";
  return { count: crashes.length, signatures, excerpt, problems: [] };
}

/**
 * `tvloop logs --json` output into events: one JSON object per line.
 *
 * A line that is not JSON is counted, not dropped silently -- tvloop's own
 * rule is that a parser which eats a line it does not recognise is worse than
 * none, and a crash report that says "0" because the stream was garbled would
 * be exactly that.
 */
export function parseLogNdjson(text: string): { events: TvLogEvent[]; problems: string[] } {
  const events: TvLogEvent[] = [];
  let bad = 0;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as TvLogEvent;
      if (o && typeof o === "object" && typeof o.kind === "string" && typeof o.message === "string") events.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, problems: bad ? [`${bad} line(s) of tvloop log output were not log events`] : [] };
}

// ---------------------------------------------------------------------------
// Loading tvloop
// ---------------------------------------------------------------------------

/**
 * tvloop's Roku adapter and image code, from a built checkout.
 *
 * Imported by file URL. Node caches ES modules by resolved path, and the
 * adapter's own `@tvloop/core` import resolves (through pnpm's symlinks) to
 * the same file, so there is one copy of tvloop in the process however many
 * actuators are opened.
 */
export async function loadTvloop(dir = tvloopCheckout()): Promise<TvloopModules> {
  const missing = Object.values(TVLOOP_MODULES).filter((m) => !existsSync(path.join(dir, m)));
  if (missing.length) {
    throw new Error(
      `no built tvloop checkout at ${dir} (missing ${missing.join(", ")}): git clone addisdev/tvloop there, then ` +
        "`corepack pnpm install --frozen-lockfile && corepack pnpm build` (or `npx pnpm@10.2.0 ...` on a Node " +
        "without corepack), or set FLEET_TVLOOP_DIR",
    );
  }
  const imp = (rel: string) => import(pathToFileURL(path.join(dir, rel)).href) as Promise<Record<string, unknown>>;
  const [roku, screen] = await Promise.all([imp(TVLOOP_MODULES.roku), imp(TVLOOP_MODULES.screen)]);
  const RokuPlatform = roku.RokuPlatform as new () => { connect(ref: unknown, opts: unknown): Promise<TvSession> };
  const decode = screen.decode as (d: Uint8Array) => { width: number; height: number; data: Uint8Array };
  const encodePng = screen.encodePng as (b: { width: number; height: number; data: Uint8Array }) => Buffer;
  if (typeof RokuPlatform !== "function" || typeof decode !== "function" || typeof encodePng !== "function") {
    throw new Error(`the tvloop checkout at ${dir} does not export RokuPlatform / decode / encodePng; rebuild it`);
  }
  const platform = new RokuPlatform();
  return {
    connectRoku: (ref, opts) => platform.connect(ref, opts),
    toPng: (data) => {
      // Already PNG (a future firmware, or a different adapter): pass through.
      if (data[0] === 0x89 && data[1] === 0x50) return Buffer.from(data);
      return encodePng(decode(data));
    },
  };
}

// ---------------------------------------------------------------------------
// The actuator
// ---------------------------------------------------------------------------

export type RokuActuatorOptions = {
  /** The Roku's address. targetHost() in drivers/roku.ts resolves one from a target. */
  host: string;
  /**
   * The developer password, from `ctx.secrets.rokuDevPassword()`. Needed for
   * screenshots and sideloads (the developer web server is behind digest
   * auth); never logged, never put in an environment.
   */
  password: string;
  /** Port overrides, for the fake. A real Roku uses ECP 8060, dev 80, console 8085, agent 8091. */
  ports?: { ecp?: number; dev?: number; console?: number; agent?: number };
  /** The tvloop checkout. Default: tvloopCheckout(). */
  tvloopDir?: string;
  log?: (msg: string) => void;
  /** Injected in tests; the real one is loadTvloop(). */
  modules?: TvloopModules;
};

export class RokuActuator implements Actuator {
  readonly target: Target;
  caps: ActuatorCaps;
  private session: TvSession;
  private opts: RokuActuatorOptions;
  private log: (m: string) => void;
  private toPng: (d: Uint8Array) => Buffer;
  /** Screenshot pixels per tree unit, from the UI resolution device-info reports. */
  private uiSize: { width: number; height: number };
  /** Every log event since open, until crashes() takes them. */
  private pending: TvLogEvent[] = [];
  private baselineSet = false;
  private consoleProblem: string | null = null;
  private closed = false;

  private constructor(target: Target, session: TvSession, modules: TvloopModules, uiSize: { width: number; height: number }, opts: RokuActuatorOptions) {
    this.target = target;
    this.session = session;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.toPng = modules.toPng;
    this.uiSize = uiSize;
    this.caps = RokuActuator.capsFor(session.capabilities.has("inspect"));
    this.followLogs();
  }

  static capsFor(tree: boolean): ActuatorCaps {
    return { surface: "dpad", keys: ALL_KEYS, tree, foreground: true };
  }

  /**
   * Connect, find out whether the channel carries tvloop's agent (that is what
   * decides `caps.tree`), and start following the debug console.
   *
   * A factory rather than a constructor because all three are network calls,
   * and the loop reads `caps` before it observes anything.
   */
  static async open(target: Target, opts: RokuActuatorOptions): Promise<RokuActuator> {
    if (!opts.password) {
      throw new Error("a Roku needs its developer password for screenshots and sideloads; add it with " +
        "`security add-generic-password -s fleet-roku-dev -a rokudev -w`");
    }
    const modules = opts.modules ?? (await loadTvloop(tvloopCheckout(opts.tvloopDir)));
    const transport: Record<string, unknown> = {};
    if (opts.ports?.ecp) transport.ecpPort = opts.ports.ecp;
    if (opts.ports?.dev) transport.devPort = opts.ports.dev;
    if (opts.ports?.console) transport.consolePort = opts.ports.console;
    if (opts.ports?.agent) transport.agentPort = opts.ports.agent;
    const session = await modules.connectRoku(
      { id: target.id, platform: "roku", host: opts.host, transport },
      { password: opts.password },
    );
    const info = await session.info();
    return new RokuActuator(target, session, modules, info.resolution, opts);
  }

  /**
   * Read the debug console for as long as the actuator is open.
   *
   * The console is a stream, not a buffer you can ask about later, so the
   * events are collected as they arrive and `crashes()` takes what has
   * accumulated. tvloop's client reconnects by itself; if the stream ends
   * anyway, that is said on the next crash report rather than turning into a
   * quiet run of zeroes.
   */
  private followLogs(): void {
    void (async () => {
      try {
        for await (const e of this.session.logs({})) {
          this.pending.push(e);
          // A night of print-heavy output must not grow without bound; crashes
          // are what is kept, and a hundred thousand prints are not.
          if (this.pending.length > 20_000) this.pending = this.pending.filter((x) => x.kind === "crash").slice(-500);
        }
        if (!this.closed) this.consoleProblem = "the Roku debug console closed; crashes after that are not seen";
      } catch (e) {
        if (!this.closed) this.consoleProblem = `the Roku debug console failed: ${(e as Error).message.slice(0, 160)}`;
      }
    })();
  }

  private ecpUrl(p: string): string {
    return `http://${this.opts.host}:${this.opts.ports?.ecp ?? 8060}${p}`;
  }

  private async foreground(): Promise<string | null> {
    const res = await fetch(this.ecpUrl("/query/active-app"), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`ECP query/active-app returned ${res.status}`);
    return parseActiveApp(await res.text());
  }

  async reset(appId: string, opts: { file?: string; launchArgs?: string[] } = {}): Promise<void> {
    if (opts.file) {
      if (appId !== "dev") throw new Error(`a sideloaded channel is always "dev" on a Roku; got app ${JSON.stringify(appId)}`);
      const bytes = readFileSync(opts.file);
      // Always installed, never skipped as unchanged: the Roku's one dev slot
      // may hold something else since tvloop last looked (the tvloop workload
      // passes --force for the same reason).
      const r = await this.session.install({
        path: opts.file,
        bytes: statSync(opts.file).size,
        hash: createHash("sha256").update(bytes).digest("hex"),
        files: [],
      }, { skipIfUnchanged: false });
      this.log(`roku: sideloaded ${path.basename(opts.file)} in ${r.durationMs}ms`);
    }
    // Home first. ECP does not relaunch a channel that is already in front,
    // so without this a "reset" would leave the app exactly where the last
    // mission left it -- the trap drivers/roku.ts's enrol avoids the same way.
    await this.session.press(["home"]);
    await sleep(1500);
    // Whatever the console said before now is history.
    this.baselineSet = false;
    await this.crashes(appId);
    await this.launch(appId, opts.launchArgs);
  }

  async launch(appId: string, launchArgs: string[] = []): Promise<void> {
    const params = launchParams(launchArgs);
    if (appId === "dev") {
      await this.session.launch(Object.keys(params).length ? params : undefined);
    } else {
      // Another installed channel, by its store id. tvloop's session only
      // launches the dev slot, so this one is plain ECP, which needs no auth.
      const q = new URLSearchParams(params).toString();
      const res = await fetch(this.ecpUrl(`/launch/${encodeURIComponent(appId)}${q ? `?${q}` : ""}`),
        { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`ECP launch of ${appId} returned ${res.status}`);
    }
    // A channel's splash screen is not the app. Real Rokus take a second or
    // two to put the first scene up.
    await sleep(1500);
  }

  async observe(): Promise<Observation> {
    // Three different transports (dev server, agent socket, ECP), so asked at
    // once rather than one after another.
    const [frame, tree, fg] = await Promise.all([
      this.session.screenshot(),
      this.caps.tree
        ? this.session.inspect().catch((e: Error) => {
            this.log(`roku: tree unavailable this step: ${e.message.slice(0, 160)}`);
            return null;
          })
        : Promise.resolve(null),
      this.foreground().catch(() => null),
    ]);
    const png = this.toPng(frame.data);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const scale = { x: width / (this.uiSize.width || width), y: height / (this.uiSize.height || height) };
    const nodes = tree ? nodesFromTree(tree, scale) : null;
    return {
      png,
      width,
      height,
      nodes,
      treeSource: tree ? "tvloop agent" : null,
      foreground: fg,
      focus: this.caps.tree
        ? rokuFocusLine(tree, nodes)
        // Without the agent there is no focus to report, and the model has to
        // find the highlight in the picture. Saying so is better than null,
        // which the contract reserves for touch screens.
        : "focus unknown: this channel has no tvloop agent, so find the highlight in the picture",
      keyboard: null,
    };
  }

  async act(a: Action): Promise<void> {
    switch (a.kind) {
      case "key":
        await this.session.press([TVLOOP_KEYS[a.key]]);
        return;
      case "type":
        if (a.x !== undefined || a.y !== undefined) {
          throw new Error("a Roku has no touch input: move focus to the field with the arrow keys, then type");
        }
        if (a.overwrite) {
          // ECP has no select-all. Forty backspaces clears any field a TV
          // keyboard is used for (a search box, a code), quickly enough.
          await this.session.press(Array(40).fill("backspace") as TvloopKey[], { gapMs: 15 });
        }
        // ECP has no "type a string": tvloop sends one Lit_ keypress per
        // character, URL-encoded, which also covers non-ASCII.
        if (a.text) await this.session.type(a.text);
        if (a.enter) await this.session.press(["enter"]);
        return;
      case "wait":
        await sleep(Math.min(10_000, Math.max(0, a.ms)));
        return;
      case "tap":
      case "long_press":
      case "swipe":
      case "scroll":
      case "hide_keyboard":
        throw new Error(`a Roku has no touch input, so "${a.kind}" cannot be done; press a key instead`);
    }
  }

  /**
   * Crash events since the previous call; the first call sets the baseline.
   *
   * The console carries the sideloaded channel's output only, so a crash in
   * any other channel is invisible here, and saying that is part of the report.
   */
  async crashes(appId: string): Promise<CrashReport> {
    const taken = this.pending;
    this.pending = [];
    const problems: string[] = [];
    if (this.consoleProblem) problems.push(this.consoleProblem);
    if (appId !== "dev") problems.push(`the Roku debug console carries the sideloaded channel only; crashes in ${appId} are not seen`);
    if (!this.baselineSet) {
      this.baselineSet = true;
      return { count: 0, signatures: [], excerpt: "", problems };
    }
    const r = crashReportFromEvents(taken);
    return { ...r, problems: [...r.problems, ...problems] };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.session.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
