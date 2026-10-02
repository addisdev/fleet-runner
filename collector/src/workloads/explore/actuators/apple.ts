/**
 * The explore actuator for Apple devices: iPhone, iPad and Apple TV, simulated
 * or real.
 *
 * Until this existed the fleet could not tap, swipe, type or press a remote
 * button on any Apple device, and could not screenshot or read the element
 * tree of a physical iPhone at all. simctl can screenshot a simulator and
 * nothing else; devicectl can install and launch and nothing else. The one
 * process Apple allows to drive the UI is an XCUITest runner, so that is what
 * this uses: the FleetDriver UI test in runner-ios/FleetDriver/ starts an HTTP
 * server inside the runner and turns requests into XCUITest calls, and this
 * file builds it, starts it, and talks to it.
 *
 * The life of one actuator:
 *
 *   1. build    `xcodebuild build-for-testing` into a per-host cache under
 *               ~/.fleet/explore/derived/<platform>-<sim|device>, skipped when
 *               the stamp there matches a hash of the driver's sources. A
 *               build is a minute or two; a cache hit is free.
 *   2. start    `xcodebuild test-without-building -only-testing:...testDrive`
 *               in the background, with TEST_RUNNER_FLEET_DRIVER=1 and a port.
 *               The runner takes 20-90 s to come up the first time on a
 *               simulator, so /health is polled with a generous deadline.
 *   3. drive    observe() and act() over HTTP, one request at a time.
 *   4. close    POST /quit, then the xcodebuild child is stopped if it has
 *               not already gone.
 *
 * Units. The contract (../types.ts) is screenshot PIXELS everywhere; the
 * driver speaks POINTS, because that is what XCUITest speaks. The conversion
 * is one number, `scale` = PNG width / screen width in points, and it is taken
 * from the first screenshot rather than from UIScreen.scale, so it is right by
 * construction for whatever the screenshot actually was.
 *
 * Testable without a device: everything exported below this header that is a
 * plain function (apple.test.ts). The class is testable only by running it,
 * which collector/scripts/explore-apple-check.ts does against simulators.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync, type WriteStream,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTappableType, type A11yNode } from "../../../a11y-tree.js";
import { exec } from "../../../fleet-client.js";
import { parseSimCrashLog } from "../../../soak-samples.js";
import type { Target } from "../../types.js";
import type { Action, Actuator, ActuatorCaps, CrashReport, Key, Observation } from "../types.js";

// ---------------------------------------------------------------------------
// Pure pieces (apple.test.ts pins these)
// ---------------------------------------------------------------------------

/** A TV is driven by focus; everything else Apple makes here is touched. */
export function isTv(target: Pick<Target, "platform">): boolean {
  return target.platform === "tvos";
}

export function isSimulator(target: Pick<Target, "kind">): boolean {
  return target.kind === "simulator";
}

/**
 * The `-destination` xcodebuild needs for this target.
 *
 * xcodebuild will not guess between a simulator and a device with the same
 * platform, and a mismatch fails before any test starts -- so both halves are
 * spelled out, the same way runXcuitest in executor.ts does for iOS.
 */
export function destinationFor(target: Pick<Target, "id" | "platform" | "kind">): string {
  const base = isTv(target) ? "tvOS" : "iOS";
  return `platform=${isSimulator(target) ? `${base} Simulator` : base},id=${target.id}`;
}

/** The destination to BUILD for: generic, so one build serves every simulator of a platform. */
export function buildDestinationFor(target: Pick<Target, "platform" | "kind">): string {
  const base = isTv(target) ? "tvOS" : "iOS";
  return `generic/platform=${isSimulator(target) ? `${base} Simulator` : base}`;
}

/** Scheme and test identifier for the driver on this platform (project.yml defines both). */
export function driverTestFor(target: Pick<Target, "platform">): { scheme: string; onlyTesting: string } {
  return isTv(target)
    ? { scheme: "FleetDriverTV", onlyTesting: "FleetDriverUITestsTV/FleetDriverUITests/testDrive" }
    : { scheme: "FleetDriver", onlyTesting: "FleetDriverUITests/FleetDriverUITests/testDrive" };
}

/**
 * What this actuator can do on this platform.
 *
 * A phone has one hardware key XCUITest can press (home); the rest of its
 * surface is touch. An Apple TV has no touch at all and the remote's buttons
 * are the whole surface: `back` is Menu (what that button does on tvOS), and
 * `menu` is Menu too, for a model that calls it by its printed name.
 */
export function capsFor(target: Pick<Target, "platform">): ActuatorCaps {
  return isTv(target)
    ? {
      surface: "dpad",
      keys: ["up", "down", "left", "right", "select", "back", "menu", "home", "play_pause"],
      tree: true,
      foreground: true,
    }
    : { surface: "touch", keys: ["home"], tree: true, foreground: true };
}

/**
 * A contract Key as the driver's `/press` button name, or an error saying why
 * not. Kept as data rather than a switch so the test can walk every Key and
 * prove the caps and this map agree.
 */
export function pressButtonFor(key: Key, platform: string): { button: string } | { error: string } {
  if (platform === "tvos") {
    const tv: Partial<Record<Key, string>> = {
      up: "up", down: "down", left: "left", right: "right", select: "select",
      back: "menu", menu: "menu", home: "home", play_pause: "play_pause",
    };
    const b = tv[key];
    return b
      ? { button: b }
      : { error: `tvOS: the Siri Remote has no "${key}" button XCUITest can press (it has ${Object.keys(tv).join(", ")})` };
  }
  if (key === "home") return { button: "home" };
  return {
    error: `iOS: "${key}" is not a key on a phone. The only hardware key XCUITest can press is home; ` +
      `"enter" belongs to the keyboard (type with enter: true), and back is a control on the screen`,
  };
}

/**
 * Width and height out of a PNG's IHDR chunk.
 *
 * Read from the bytes rather than decoded: an observe on a 4K TV screenshot
 * would otherwise spend its time inflating eight megapixels to learn two
 * numbers that are at fixed offsets 16 and 20.
 */
export function pngSize(png: Buffer): { width: number; height: number } {
  const sig = "89504e470d0a1a0a";
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== sig || png.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error(`not a PNG (${png.length} bytes, starts ${png.subarray(0, 8).toString("hex")})`);
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Pixels per point, from what was actually captured.
 *
 * The runner reports its screen size in its own orientation, which on a phone
 * is portrait. If the screenshot came back the other way round, the sides are
 * swapped before dividing so a landscape capture does not produce a scale
 * that is off by the aspect ratio. UNVERIFIED for landscape: every screen this
 * was run against was portrait (phone) or landscape-native (TV).
 */
export function pixelsPerPoint(png: { width: number; height: number }, sizePt: { w: number; h: number }): number {
  if (!(sizePt.w > 0 && sizePt.h > 0)) throw new Error(`the driver reported a screen of ${sizePt.w}x${sizePt.h} points`);
  const pngLandscape = png.width > png.height;
  const ptLandscape = sizePt.w > sizePt.h;
  const wPt = pngLandscape === ptLandscape ? sizePt.w : sizePt.h;
  return png.width / wPt;
}

/** Screenshot pixels to points, rounded to a tenth (XCUITest takes fractional points). */
export function pxToPt(px: number, scale: number): number {
  return Math.round((px / scale) * 10) / 10;
}

/** One node as the driver's /tree sends it. */
export type DriverNode = {
  type: string;
  label: string;
  identifier: string;
  value: string;
  placeholder?: string;
  frame: { x: number; y: number; w: number; h: number };
  enabled: boolean;
  hittable: boolean;
  focused: boolean;
  selected: boolean;
  depth: number;
};

/**
 * The driver's tree as contract nodes, with frames scaled into screenshot
 * pixels.
 *
 * Fields line up with parseXcuiDebugDescription's on purpose (text = value,
 * tappable by element type), so a check written against the a11y-audit's
 * reading of a tree reads this one the same way. A zero-sized frame stays
 * zero-sized rather than becoming null: XCUITest reports off-screen and
 * collapsed elements that way, and the a11y checks already skip them.
 */
export function nodesFromDriver(nodes: DriverNode[], scale: number): A11yNode[] {
  const r = (v: number) => Math.round(v * scale);
  return nodes.map((n) => ({
    cls: n.type,
    text: n.value ?? "",
    label: n.label ?? "",
    id: n.identifier ?? "",
    value: n.value ?? "",
    tappable: isTappableType(n.type),
    enabled: n.enabled !== false,
    bounds: n.frame ? { x: r(n.frame.x), y: r(n.frame.y), w: r(n.frame.w), h: r(n.frame.h) } : null,
    depth: n.depth,
    ...(n.focused ? { focused: true } : {}),
    ...(/^(ScrollView|Table|CollectionView)$/.test(n.type) ? { scrollable: true } : {}),
  }));
}

/**
 * Where a TV's focus is, as a line a model can read.
 *
 * The deepest focused node (tvOS marks the focused element; some containers
 * report focus too, and the innermost is the one the remote acts on), named by
 * its type and label, behind the labels of the containers it sits in:
 *
 *     Dozehound > Sounds > Cell 'Rain on the porch' (focused)
 *
 * Ancestors without a label are left out -- a row of unnamed Others says
 * nothing -- and a label repeated by a child (a cell and its own text) is said
 * once. Null for an empty tree; a tree where nothing reports focus says so in
 * words, because "no focus" is a state a model can act on (press a direction)
 * and null would read as "this platform has no focus".
 */
export function focusLine(nodes: A11yNode[] | null): string | null {
  if (!nodes || nodes.length === 0) return null;
  let at = -1;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].focused && (at < 0 || nodes[i].depth >= nodes[at].depth)) at = i;
  }
  if (at < 0) return "(nothing reports focus)";
  const chain: string[] = [];
  let depth = nodes[at].depth;
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    if (nodes[i].depth < depth) {
      depth = nodes[i].depth;
      const l = nodes[i].label.trim();
      if (l && chain[0] !== l) chain.unshift(l);
    }
  }
  const f = nodes[at];
  const name = (f.label || f.value || f.id).trim();
  if (name && chain[chain.length - 1] === name) chain.pop();
  const leaf = name ? `${f.cls} '${name}' (focused)` : `${f.cls} (focused)`;
  return [...chain, leaf].join(" > ");
}

/** Whether a soft keyboard is in the tree. Null when there is no tree to look in. */
export function keyboardShown(nodes: A11yNode[] | null): boolean | null {
  if (!nodes) return null;
  return nodes.some((n) => n.cls === "Keyboard" && (!n.bounds || (n.bounds.w > 0 && n.bounds.h > 0)));
}

/**
 * The foreground app the leash compares against, when XCUITest cannot name it.
 *
 * The driver can only say which of a list of KNOWN bundle ids is in front (see
 * /foreground in DriverCommands.swift). When it is neither the app under test
 * nor the home screen, the truthful answer is "some other app", and null would
 * be wrong: null means "this platform cannot say", which a leash reads as no
 * information. So it is this marker, which is not a bundle id and so never
 * equals the app under test.
 */
export const FOREGROUND_OTHER = "(another app)";

/**
 * The swipe that scrolls content `direction` by `factor` of a screen.
 *
 * The direction is the CONTENT's, the way a person says it: "scroll down"
 * shows what is below, so the finger moves up. The swipe is centred on the
 * screen and never starts within 10% of an edge, where iOS reads a swipe as
 * the system's (Notification Centre from the top, the home indicator at the
 * bottom, back from the left) rather than the app's.
 */
export function scrollSwipe(
  direction: "up" | "down" | "left" | "right",
  factor: number,
  sizePt: { w: number; h: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const f = Math.min(0.8, Math.max(0.05, Number.isFinite(factor) ? factor : 0.5));
  const cx = sizePt.w / 2;
  const cy = sizePt.h / 2;
  const dy = (sizePt.h * f) / 2;
  const dx = (sizePt.w * f) / 2;
  const round = (v: number) => Math.round(v * 10) / 10;
  switch (direction) {
    case "down": return { x1: round(cx), y1: round(cy + dy), x2: round(cx), y2: round(cy - dy) };
    case "up": return { x1: round(cx), y1: round(cy - dy), x2: round(cx), y2: round(cy + dy) };
    case "right": return { x1: round(cx + dx), y1: round(cy), x2: round(cx - dx), y2: round(cy) };
    case "left": return { x1: round(cx - dx), y1: round(cy), x2: round(cx + dx), y2: round(cy) };
  }
}

/**
 * How many D-pad presses a scroll is, on a TV.
 *
 * A remote has no swipe; scrolling a TV list IS moving focus through it. Half a
 * screen is taken as two presses, which on a typical row of tiles moves focus
 * past the visible ones and makes the list scroll.
 */
export function dpadPressesForScroll(factor: number | undefined): number {
  return Math.max(1, Math.min(8, Math.round((factor ?? 0.5) * 4)));
}

/**
 * The CoreDevice tunnel address of a physical device, out of
 * `devicectl device info details --json-output`.
 *
 * On iOS 17 and later the Mac reaches a device over a tunnel (an IPv6 address
 * on a utun interface) that CoreDevice brings up while the device is in use,
 * and every TCP port on the device is reachable at that address -- which is
 * how the driver's port on the phone is reached from here. The field has been
 * `result.connectionProperties.tunnelIPAddress` in every devicectl seen; if it
 * moves, the deep search below still finds it by name.
 *
 * UNVERIFIED against a real device: no iPhone was attached when this was
 * written. The parsing is tested against the documented shape; the route
 * itself has never carried a request.
 */
export function tunnelAddressFromDevicectl(json: unknown): string | null {
  const direct = (json as { result?: { connectionProperties?: { tunnelIPAddress?: unknown } } })
    ?.result?.connectionProperties?.tunnelIPAddress;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // Deep search, bounded, in case the key moved.
  const seen = new Set<unknown>();
  const find = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 8 || seen.has(v)) return null;
    seen.add(v);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "tunnelIPAddress" && typeof x === "string" && x.trim()) return x.trim();
      const got = find(x, depth + 1);
      if (got) return got;
    }
    return null;
  };
  return find(json, 0);
}

/** An address as the host part of a URL: IPv6 in brackets, with a zone id escaped. */
export function urlHost(addr: string): string {
  if (!addr.includes(":")) return addr;
  const bare = addr.replace(/^\[|\]$/g, "");
  // RFC 6874: the % of a zone id is itself percent-encoded inside a URL.
  return `[${bare.replace(/%(?!25)/, "%25")}]`;
}

/**
 * `log show --start` wants local wall-clock time, "YYYY-MM-DD HH:MM:SS". A
 * simulator shares the Mac's clock and time zone, so the Mac's local time is
 * the simulator's.
 */
export function logStartArg(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The files whose content decides whether the cached driver build is stale. */
export function driverSourceFiles(projectPath: string): string[] {
  const root = path.dirname(projectPath);
  const files: string[] = [path.join(projectPath, "project.pbxproj")];
  const schemes = path.join(projectPath, "xcshareddata", "xcschemes");
  for (const s of ["FleetDriver.xcscheme", "FleetDriverTV.xcscheme"]) files.push(path.join(schemes, s));
  const dir = path.join(root, "FleetDriver");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) if (f.endsWith(".swift")) files.push(path.join(dir, f));
  }
  return files;
}

/** One hash over the driver's sources and the toolchain that builds them. */
export function sourceHash(files: { name: string; content: Buffer | string }[], toolchain: string): string {
  const h = createHash("sha256");
  h.update(`toolchain\0${toolchain}\0`);
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${f.name}\0`);
    h.update(f.content);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The actuator
// ---------------------------------------------------------------------------

export type AppleActuatorOptions = {
  /**
   * The driver's TCP port. Default: a free port on this Mac for a simulator
   * (every simulator's runner shares the Mac's network stack, so two drivers
   * on 8123 would collide), and 8123 on a device, which has a stack of its own.
   */
  port?: number;
  /** For `xcodebuild build-for-testing`. Default 30 minutes; a cold build on a busy Mac is slow. */
  buildTimeoutMs?: number;
  /** From starting xcodebuild to /health answering. Default 5 minutes. */
  startTimeoutMs?: number;
  /** Per driver request. Default 60 s; XCUITest waits up to that for an app to go idle. */
  requestTimeoutMs?: number;
  /** The driver stops itself after this long without a request. Default 900. */
  idleS?: number;
  /** FleetRunner.xcodeproj. Default FLEET_IOS_PROJECT, else the one in this repository. */
  projectPath?: string;
  /** Where builds are cached. Default ~/.fleet/explore/derived. */
  derivedRoot?: string;
  /**
   * Apple developer team for signing the runner on a PHYSICAL device. Default
   * FLEET_APPLE_TEAM_ID. Simulators are unsigned and ignore it.
   */
  teamId?: string;
};

type Health = { ok: boolean; platform: string; os: string; scale: number; size: { w: number; h: number } };

/** In-process build dedupe: two actuators for two simulators share one build. */
const builds = new Map<string, Promise<void>>();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT = process.env.FLEET_IOS_PROJECT ??
  path.resolve(HERE, "../../../../../runner-ios/FleetRunner.xcodeproj");

export class AppleActuator implements Actuator {
  readonly caps: ActuatorCaps;
  private readonly opts: Required<Omit<AppleActuatorOptions, "port" | "teamId">> & { port?: number; teamId?: string };
  private readonly token = randomBytes(12).toString("hex");
  private child: ChildProcess | null = null;
  private childExit: string | null = null;
  private childLog: WriteStream | null = null;
  private tail: string[] = [];
  private baseUrl: string | null = null;
  private port = 0;
  private health: Health | null = null;
  /** Pixels per point, from the first screenshot (see pixelsPerPoint). */
  private scale: number | null = null;
  /** The app under test: the last one reset or launched. */
  private appId: string | null = null;
  private lastCrashCheck = new Map<string, Date>();
  /** Where this actuator's xcodebuild output went in full. */
  logFile: string | null = null;

  constructor(
    readonly target: Target,
    private readonly log: (msg: string) => void,
    options: AppleActuatorOptions = {},
  ) {
    if (target.platform !== "ios" && target.platform !== "tvos") {
      throw new Error(`AppleActuator drives iOS and tvOS; ${target.id} is ${target.platform}`);
    }
    this.caps = capsFor(target);
    this.opts = {
      buildTimeoutMs: options.buildTimeoutMs ?? 30 * 60_000,
      startTimeoutMs: options.startTimeoutMs ?? 5 * 60_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      idleS: options.idleS ?? 900,
      projectPath: options.projectPath ?? DEFAULT_PROJECT,
      derivedRoot: options.derivedRoot ?? path.join(os.homedir(), ".fleet", "explore", "derived"),
      port: options.port,
      teamId: options.teamId ?? process.env.FLEET_APPLE_TEAM_ID,
    };
  }

  private get derivedData(): string {
    return path.join(this.opts.derivedRoot, `${this.target.platform}-${isSimulator(this.target) ? "sim" : "device"}`);
  }

  // ---- build and start ----------------------------------------------------

  /**
   * Signing for a physical device. The project is unsigned (simulators need
   * nothing), so a device build overrides it on the command line with
   * automatic signing for the fleet's team; `-allowProvisioningUpdates` lets
   * xcodebuild fetch a profile, which -- as runXcuitest in executor.ts notes
   * -- can REGISTER the device with the team, consuming one of its slots.
   */
  private signingArgs(): string[] {
    if (isSimulator(this.target)) return [];
    if (!this.opts.teamId) {
      throw new Error(
        `${this.target.id} is a physical device, and the FleetDriver runner has to be signed to run on one. ` +
        "Set FLEET_APPLE_TEAM_ID (or pass teamId) to the Apple developer team id",
      );
    }
    return [
      "-allowProvisioningUpdates",
      "CODE_SIGN_STYLE=Automatic", `DEVELOPMENT_TEAM=${this.opts.teamId}`,
      "CODE_SIGNING_REQUIRED=YES", "CODE_SIGN_IDENTITY=Apple Development",
    ];
  }

  /** Build the driver into the cache unless the cache is already this source. */
  async ensureBuilt(): Promise<void> {
    const key = this.derivedData;
    const running = builds.get(key);
    if (running) return running;
    const p = this.build().finally(() => builds.delete(key));
    builds.set(key, p);
    return p;
  }

  private async build(): Promise<void> {
    const project = this.opts.projectPath;
    if (!existsSync(project)) throw new Error(`no Xcode project at ${project} (set FLEET_IOS_PROJECT)`);
    const { stdout: toolchain } = await exec("xcodebuild", ["-version"], { timeout: 60_000 });
    const files = driverSourceFiles(project).filter((f) => existsSync(f))
      .map((f) => ({ name: path.relative(path.dirname(project), f), content: readFileSync(f) }));
    const hash = sourceHash(files, toolchain.trim());
    const stamp = path.join(this.derivedData, ".fleet-driver-source");
    const haveRun = existsSync(path.join(this.derivedData, "Build", "Products")) &&
      readdirSync(path.join(this.derivedData, "Build", "Products")).some((f) => f.endsWith(".xctestrun"));
    if (haveRun && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === hash) {
      this.log(`FleetDriver build for ${path.basename(this.derivedData)} is current (${hash})`);
      return;
    }
    mkdirSync(this.derivedData, { recursive: true });
    const { scheme } = driverTestFor(this.target);
    const started = Date.now();
    this.log(`building FleetDriver (${scheme}, ${buildDestinationFor(this.target)}) into ${this.derivedData}`);
    try {
      await exec("xcodebuild", [
        "build-for-testing", "-project", project, "-scheme", scheme,
        "-destination", buildDestinationFor(this.target),
        "-derivedDataPath", this.derivedData,
        ...this.signingArgs(),
      ], { timeout: this.opts.buildTimeoutMs, maxBuffer: 128 * 1024 * 1024 });
    } catch (e) {
      const out = ((e as { stdout?: string }).stdout ?? "") + ((e as { stderr?: string }).stderr ?? "");
      const errors = out.split("\n").filter((l) => /error:|BUILD FAILED|\*\* .* FAILED \*\*/.test(l)).slice(-12);
      throw new Error(`FleetDriver build failed: ${(errors.join("\n") || out.slice(-2000) || (e as Error).message).trim()}`);
    }
    writeFileSync(stamp, hash + "\n");
    this.log(`FleetDriver built in ${Math.round((Date.now() - started) / 1000)} s`);
  }

  /** Build if needed, start the runner, and wait until it answers. */
  async start(): Promise<void> {
    if (this.child) return;
    await this.ensureBuilt();
    this.port = this.opts.port ?? (isSimulator(this.target) ? await freePort() : 8123);
    const { scheme, onlyTesting } = driverTestFor(this.target);

    const logDir = path.join(path.dirname(this.opts.derivedRoot), "logs");
    mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, `${this.target.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    this.childLog = createWriteStream(this.logFile);

    const args = [
      "test-without-building", "-project", this.opts.projectPath, "-scheme", scheme,
      "-destination", destinationFor(this.target),
      "-derivedDataPath", this.derivedData,
      `-only-testing:${onlyTesting}`,
      ...(isSimulator(this.target) ? [] : ["-allowProvisioningUpdates"]),
    ];
    this.log(`starting FleetDriver on ${this.target.id} (port ${this.port}); log ${this.logFile}`);
    const child = spawn("xcodebuild", args, {
      env: {
        ...process.env,
        // TEST_RUNNER_ is the prefix xcodebuild strips before handing the
        // variable to the test runner, where the driver reads it.
        TEST_RUNNER_FLEET_DRIVER: "1",
        TEST_RUNNER_FLEET_DRIVER_PORT: String(this.port),
        TEST_RUNNER_FLEET_DRIVER_IDLE_S: String(this.opts.idleS),
        TEST_RUNNER_FLEET_DRIVER_TOKEN: this.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.childExit = null;
    const onData = (b: Buffer) => {
      this.childLog?.write(b);
      for (const line of b.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > 80) this.tail.shift();
        if (/FLEET-DRIVER-(READY|IDLE|STOPPED|ISSUE)/.test(line)) this.log(line.trim());
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code, signal) => {
      this.childExit = signal ? `signal ${signal}` : `exit ${code}`;
      this.childLog?.end();
      this.childLog = null;
    });

    const started = Date.now();
    const deadline = started + this.opts.startTimeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      if (this.childExit) {
        throw new Error(
          `xcodebuild exited (${this.childExit}) before FleetDriver answered on ${this.target.id}. ` +
          `Last lines:\n${this.tail.slice(-15).join("\n")}`,
        );
      }
      try {
        if (!this.baseUrl) this.baseUrl = await this.resolveBaseUrl();
        if (this.baseUrl) {
          this.health = (await this.call("GET", "/health", undefined, { timeoutMs: 3000 })) as Health;
          this.log(
            `FleetDriver up on ${this.target.id} in ${Math.round((Date.now() - started) / 1000)} s ` +
            `(${this.health.platform} ${this.health.os}, ${this.health.size.w}x${this.health.size.h} pt @${this.health.scale}x)`,
          );
          return;
        }
      } catch (e) {
        lastErr = (e as Error).message;
        // A device's tunnel address can change while xcodebuild brings the
        // tunnel up; look it up again next time round.
        if (!isSimulator(this.target)) this.baseUrl = null;
      }
      await sleep(1000);
    }
    await this.close();
    throw new Error(
      `FleetDriver did not answer on ${this.target.id} within ${Math.round(this.opts.startTimeoutMs / 1000)} s ` +
      `(last error: ${lastErr || "none"}). Last xcodebuild lines:\n${this.tail.slice(-15).join("\n")}`,
    );
  }

  /** Where the driver is listening, as a URL base, or null if not knowable yet. */
  private async resolveBaseUrl(): Promise<string | null> {
    if (isSimulator(this.target)) return `http://127.0.0.1:${this.port}`;
    const addr = await deviceTunnelAddress(this.target.id);
    return addr ? `http://${urlHost(addr)}:${this.port}` : null;
  }

  // ---- talking to the driver ---------------------------------------------

  private async call(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    o: { timeoutMs?: number; raw?: boolean } = {},
  ): Promise<unknown> {
    if (!this.baseUrl) throw new Error("FleetDriver is not started (call start() first)");
    const res = await fetch(this.baseUrl + route, {
      method,
      headers: {
        "x-fleet-driver-token": this.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs ?? this.opts.requestTimeoutMs),
    });
    if (o.raw && res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* reported below */ }
    if (!res.ok || json.ok === false) {
      throw new Error(`FleetDriver ${method} ${route} -> ${res.status}: ${String(json.error ?? text.slice(0, 300))}`);
    }
    return json;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.child || this.childExit) {
      if (this.childExit) {
        this.log(`FleetDriver on ${this.target.id} had stopped (${this.childExit}); starting it again`);
        this.child = null;
        this.baseUrl = null;
      }
      await this.start();
    }
  }

  private async sizePt(): Promise<{ w: number; h: number }> {
    if (!this.health) this.health = (await this.call("GET", "/health")) as Health;
    return this.health.size;
  }

  /** Pixels per point. Takes a screenshot the first time if none has been taken yet. */
  private async pxScale(): Promise<number> {
    if (this.scale) return this.scale;
    const png = (await this.call("GET", "/screenshot", undefined, { raw: true })) as Buffer;
    this.scale = pixelsPerPoint(pngSize(png), await this.sizePt());
    return this.scale;
  }

  // ---- the contract -------------------------------------------------------

  async launch(appId: string, launchArgs: string[] = []): Promise<void> {
    await this.ensureStarted();
    await this.call("POST", "/launch", { bundleId: appId, args: launchArgs }, { timeoutMs: 120_000 });
    this.appId = appId;
  }

  /**
   * Bring `appId` back to a clean state, then launch it.
   *
   * Simulator, with a file: uninstall and install it. A fresh install also
   * drops any privacy grants, so a caller that pre-grants permissions must
   * grant after this, not before.
   *
   * Simulator, without a file: terminate, then empty the app's data container
   * and app-group containers and delete its preferences through cfprefsd
   * (`defaults delete` inside the simulator -- removing the plist file alone
   * leaves cfprefsd's cached copy, which the app would read straight back).
   * The install, and so its permission grants, stay. What this does NOT clear
   * is the keychain: simctl can only reset the whole simulator's keychain,
   * which would sign every other app out too.
   *
   * Device, with a file: devicectl uninstall and install. Device, without a
   * file: terminate and relaunch only. There is no way from the Mac to clear a
   * device app's data short of reinstalling it, and the installed build cannot
   * be copied off the device to reinstall, so the limit is stated here and
   * logged on every reset that hits it.
   */
  async reset(appId: string, opts: { file?: string; launchArgs?: string[] } = {}): Promise<void> {
    await this.ensureStarted();
    const udid = this.target.id;
    // Through the driver first: XCUITest's terminate is the one that also
    // works on a device, and it tells XCUITest the app is gone.
    await this.call("POST", "/terminate", { bundleId: appId }, { timeoutMs: 30_000 }).catch(() => {});
    if (isSimulator(this.target)) {
      await exec("xcrun", ["simctl", "terminate", udid, appId], { timeout: 30_000 }).catch(() => {});
      if (opts.file) {
        await exec("xcrun", ["simctl", "uninstall", udid, appId], { timeout: 60_000 }).catch(() => {});
        await exec("xcrun", ["simctl", "install", udid, opts.file], { timeout: 180_000 });
        this.log(`reset ${appId} on ${udid}: reinstalled from ${path.basename(opts.file)}`);
      } else {
        const cleared = await clearSimAppData(udid, appId);
        this.log(`reset ${appId} on ${udid}: ${cleared}`);
      }
    } else {
      if (opts.file) {
        await exec("xcrun", ["devicectl", "device", "uninstall", "app", "--device", udid, appId], { timeout: 120_000 })
          .catch(() => {});
        await exec("xcrun", ["devicectl", "device", "install", "app", "--device", udid, opts.file], { timeout: 300_000 });
        this.log(`reset ${appId} on ${udid}: reinstalled from ${path.basename(opts.file)}`);
      } else {
        this.log(
          `reset ${appId} on ${udid}: terminated only -- a physical device's app data cannot be cleared from the Mac ` +
          "without a file to reinstall from",
        );
      }
    }
    await this.launch(appId, opts.launchArgs ?? []);
  }

  async observe(): Promise<Observation> {
    await this.ensureStarted();
    const png = (await this.call("GET", "/screenshot", undefined, { raw: true })) as Buffer;
    const { width, height } = pngSize(png);
    if (!this.scale) this.scale = pixelsPerPoint({ width, height }, await this.sizePt());
    const scale = this.scale;

    let nodes: A11yNode[] | null = null;
    let treeSource: string | null = null;
    try {
      const q = this.appId ? `?bundleId=${encodeURIComponent(this.appId)}` : "";
      const tree = (await this.call("GET", `/tree${q}`)) as { nodes: DriverNode[]; debugDescription: string | null };
      nodes = nodesFromDriver(tree.nodes, scale);
      treeSource = "xcuitest snapshot";
    } catch (e) {
      // Ordinary: a snapshot can fail mid-transition. The contract says carry on with the picture.
      this.log(`tree failed on ${this.target.id}: ${(e as Error).message.slice(0, 200)}`);
    }

    let foreground: string | null = null;
    try {
      const ids = this.appId ? `?bundleIds=${encodeURIComponent(this.appId)}` : "";
      const fg = (await this.call("GET", `/foreground${ids}`)) as { bundleId: string | null };
      foreground = fg.bundleId ?? FOREGROUND_OTHER;
    } catch (e) {
      this.log(`foreground failed on ${this.target.id}: ${(e as Error).message.slice(0, 200)}`);
    }

    return {
      png, width, height, nodes, treeSource, foreground,
      focus: isTv(this.target) ? focusLine(nodes) : null,
      keyboard: keyboardShown(nodes),
    };
  }

  async act(a: Action): Promise<void> {
    await this.ensureStarted();
    const tv = isTv(this.target);
    const touchOnly = (what: string) => {
      if (tv) throw new Error(`${what} needs a touch screen; ${this.target.id} is an Apple TV, driven by the remote (key actions)`);
    };
    switch (a.kind) {
      case "tap": {
        touchOnly("tap");
        const s = await this.pxScale();
        await this.call("POST", "/tap", { x: pxToPt(a.x, s), y: pxToPt(a.y, s) });
        return;
      }
      case "long_press": {
        touchOnly("long_press");
        const s = await this.pxScale();
        await this.call("POST", "/long_press", { x: pxToPt(a.x, s), y: pxToPt(a.y, s), ms: a.ms ?? 800 });
        return;
      }
      case "swipe": {
        touchOnly("swipe");
        const s = await this.pxScale();
        await this.call("POST", "/swipe", {
          x1: pxToPt(a.x1, s), y1: pxToPt(a.y1, s), x2: pxToPt(a.x2, s), y2: pxToPt(a.y2, s), ms: a.ms ?? 300,
        });
        return;
      }
      case "scroll": {
        if (tv) {
          // A remote has no swipe: scrolling a TV list is moving focus through it.
          const b = pressButtonFor(a.direction, "tvos");
          if ("error" in b) throw new Error(b.error);
          for (let i = 0; i < dpadPressesForScroll(a.factor); i++) await this.call("POST", "/press", b);
          return;
        }
        await this.call("POST", "/swipe", { ...scrollSwipe(a.direction, a.factor ?? 0.5, await this.sizePt()), ms: 300 });
        return;
      }
      case "type": {
        if (a.x !== undefined && a.y !== undefined) {
          touchOnly("type at a point");
          const s = await this.pxScale();
          await this.call("POST", "/tap", { x: pxToPt(a.x, s), y: pxToPt(a.y, s) });
          // The keyboard animates in; typing into it mid-animation drops keys.
          await sleep(400);
        }
        await this.call("POST", "/type", {
          text: a.text + (a.enter ? "\n" : ""),
          clear: a.overwrite === true,
          ...(this.appId ? { bundleId: this.appId } : {}),
        });
        return;
      }
      case "key": {
        if (!this.caps.keys.includes(a.key)) {
          throw new Error(`${this.target.platform} has no "${a.key}" key here; it accepts ${this.caps.keys.join(", ")}`);
        }
        const b = pressButtonFor(a.key, this.target.platform);
        if ("error" in b) throw new Error(b.error);
        await this.call("POST", "/press", b);
        return;
      }
      case "hide_keyboard":
        await this.call("POST", "/hide_keyboard", {});
        return;
      case "wait":
        await sleep(Math.max(0, Math.min(a.ms, 60_000)));
        return;
      default: {
        const never: never = a;
        throw new Error(`unknown action ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Crashes since the previous call; the first call for an app sets the
   * baseline and reports none.
   *
   * Simulator: the simulator's unified log since that moment, read with the
   * same predicate and parser the soak workload uses (parseSimCrashLog), so a
   * crash counts the same in both. Device: devicectl has no log or crash-report
   * access, so the answer is an honest "cannot tell" rather than a zero.
   */
  async crashes(appId: string): Promise<CrashReport> {
    if (!isSimulator(this.target)) {
      return {
        count: 0, signatures: [], excerpt: "",
        problems: ["no crash log access on a physical device via devicectl"],
      };
    }
    const now = new Date();
    const since = this.lastCrashCheck.get(appId);
    this.lastCrashCheck.set(appId, now);
    if (!since) return { count: 0, signatures: [], excerpt: "", problems: [] };
    try {
      const { stdout } = await exec("xcrun", [
        "simctl", "spawn", this.target.id, "log", "show", "--style", "syslog",
        "--start", logStartArg(since),
        "--predicate", 'process == "ReportCrash" OR eventMessage CONTAINS[c] "crash"',
      ], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
      const c = parseSimCrashLog(stdout, appId);
      const leaf = appId.split(".").pop()!.toLowerCase();
      const excerpt = stdout.split("\n")
        .filter((l) => { const low = l.toLowerCase(); return low.includes(appId.toLowerCase()) || low.includes(leaf); })
        .slice(-40).join("\n").slice(-4000);
      return { count: c.count, signatures: c.signatures, excerpt, problems: c.problem ? [c.problem] : [] };
    } catch (e) {
      return {
        count: 0, signatures: [], excerpt: "",
        problems: [`simctl log show failed: ${(e as Error).message.slice(0, 160)}`],
      };
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (this.baseUrl && child && !this.childExit) {
      await this.call("POST", "/quit", {}, { timeoutMs: 5000 }).catch(() => {});
    }
    if (child && !this.childExit) {
      // The test returns after /quit and xcodebuild exits on its own within a
      // few seconds; only a driver that did not hear the quit needs a signal.
      const exited = await waitFor(() => this.childExit !== null, 20_000);
      if (!exited) {
        child.kill("SIGTERM");
        if (!(await waitFor(() => this.childExit !== null, 10_000))) child.kill("SIGKILL");
      }
    }
    this.child = null;
    this.baseUrl = null;
  }
}

// ---------------------------------------------------------------------------
// Shell-outs kept out of the class so each one is one obvious thing
// ---------------------------------------------------------------------------

/**
 * A physical device's CoreDevice tunnel address. The ONE place the device
 * route is decided, so that when it is first tried on real hardware there is
 * one function to fix. UNVERIFIED (no device attached when written): that
 * devicectl reports the address while xcodebuild holds the device, and that
 * the driver's port is reachable at it -- both are what CoreDevice's tunnel is
 * documented to do, and neither has been seen to happen here.
 */
async function deviceTunnelAddress(udid: string): Promise<string | null> {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-dc-")), "details.json");
  try {
    await exec("xcrun", ["devicectl", "device", "info", "details", "--device", udid, "--json-output", out],
      { timeout: 30_000 });
    return tunnelAddressFromDevicectl(JSON.parse(readFileSync(out, "utf8")));
  } catch {
    return null;
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

/**
 * Empty a simulator app's data without uninstalling it. Returns what it did,
 * for the log. System apps (com.apple.*) have containers simctl will not
 * hand out, so for those this is a terminate and nothing more.
 */
async function clearSimAppData(udid: string, appId: string): Promise<string> {
  const done: string[] = [];
  try {
    const { stdout } = await exec("xcrun", ["simctl", "get_app_container", udid, appId, "data"], { timeout: 30_000 });
    const dir = stdout.trim();
    if (dir && existsSync(dir)) {
      // Children of the top-level folders, not the folders themselves: the
      // app expects Documents, Library and tmp to exist, and iOS creates them
      // at install, not at launch.
      for (const top of readdirSync(dir)) {
        const full = path.join(dir, top);
        if (!statSync(full).isDirectory()) { rmSync(full, { force: true }); continue; }
        for (const c of readdirSync(full)) rmSync(path.join(full, c), { recursive: true, force: true });
      }
      done.push("data container emptied");
    }
  } catch (e) {
    done.push(`no data container (${((e as { stderr?: string }).stderr ?? (e as Error).message).trim().slice(0, 100)})`);
  }
  try {
    const { stdout } = await exec("xcrun", ["simctl", "get_app_container", udid, appId, "groups"], { timeout: 30_000 });
    let n = 0;
    for (const line of stdout.split("\n")) {
      const dir = line.split("\t").pop()?.trim();
      if (!dir || !existsSync(dir)) continue;
      for (const c of readdirSync(dir)) rmSync(path.join(dir, c), { recursive: true, force: true });
      n++;
    }
    if (n) done.push(`${n} app-group container(s) emptied`);
  } catch { /* no groups is the common case */ }
  // Through cfprefsd, which caches preferences: deleting the plist alone would
  // leave the cached copy for the app to read straight back.
  await exec("xcrun", ["simctl", "spawn", udid, "defaults", "delete", appId], { timeout: 30_000 })
    .then(() => done.push("preferences deleted"))
    .catch(() => {});
  return done.join(", ") || "terminated only";
}

/** A TCP port nothing on this Mac is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not find a free port"))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(200);
  }
  return cond();
}
