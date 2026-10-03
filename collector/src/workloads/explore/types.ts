/**
 * The shapes the explore workload is built from.
 *
 * `explore` is the workload EXPANSION-PLAN.md called "a monkey test with a
 * memory": a vision model looks at the screen, picks an action, the harness
 * checks the action against the leash and performs it, and a set of checks
 * decides after every step whether anything went wrong. What comes out is a
 * short list of findings, each replayed on a clean install before it is
 * believed.
 *
 * This file is the contract between the four parts that are built separately:
 *
 *   actuators/  one per way of reaching a device (adb touch, adb D-pad, tvloop
 *               for a Roku, the FleetDriver XCUITest bundle for Apple devices).
 *               They know how to look and how to act, and nothing about models.
 *   model.ts    turns an observation into actions, in the dialect the model was
 *               trained on. Knows nothing about devices.
 *   loop.ts     the mission: budget, leash, checks, trajectory, replay.
 *   findings    what the collector stores and the dashboard shows.
 *
 * Coordinates are the one thing all four have to agree on, so the rule is
 * stated once here: **everything outside model.ts is in screenshot pixels.**
 * The model speaks 0-1000 on both axes (Holo4's convention, and what every
 * other model is asked to use too); model.ts converts on the way in and out.
 * An actuator converts screenshot pixels to whatever its input path wants
 * (device pixels on Android, which are the same thing; points on iOS, which are
 * pixels divided by the screen scale).
 */
import type { A11yNode } from "../../a11y-tree.js";
import type { Target } from "../types.js";

// ---------------------------------------------------------------------------
// Looking
// ---------------------------------------------------------------------------

/** One look at the device. */
export type Observation = {
  /** PNG bytes, exactly as captured. */
  png: Buffer;
  /** The PNG's own size, in pixels. Every coordinate in this file is in these. */
  width: number;
  height: number;
  /**
   * The UI tree with bounds already scaled into screenshot pixels, or null when
   * the source failed this step. Null is ordinary (a dump times out while an
   * animation runs) and the loop carries on with the picture alone.
   */
  nodes: A11yNode[] | null;
  /** Which tool produced `nodes`, for the trajectory. */
  treeSource: string | null;
  /**
   * The app in front, as a package or bundle id, or null when the platform
   * cannot say. The leash uses it to notice the agent has left the app.
   */
  foreground: string | null;
  /**
   * A TV's focus, as text a model can read: "Home > Row 2 > Tile 'Rain on the
   * porch' (focused)". Null on touch devices.
   */
  focus: string | null;
  /** Whether a soft keyboard is covering the screen, when the platform says. */
  keyboard: boolean | null;
  /**
   * Screen density, when the tree's bounds are pixels and the platform says:
   * what turns a 53-pixel button into the 20dp touch target it is. Absent
   * means touch-target sizes are not judged.
   */
  densityDpi?: number | null;
};

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/**
 * Remote and hardware keys, by one name each across platforms.
 *
 * `select` is OK on a Roku remote, DPAD_CENTER on Android TV, select on an
 * Apple TV remote. `back` is Back on Roku and Android and Menu on tvOS, which
 * is what that button does there.
 */
export type Key =
  | "up" | "down" | "left" | "right" | "select"
  | "back" | "home" | "menu" | "play_pause" | "rewind" | "fast_forward"
  | "enter" | "search";

export const ALL_KEYS: readonly Key[] = [
  "up", "down", "left", "right", "select", "back", "home", "menu",
  "play_pause", "rewind", "fast_forward", "enter", "search",
];

/** One thing to do to the device. Screenshot pixels throughout. */
export type Action =
  | { kind: "tap"; x: number; y: number }
  | { kind: "long_press"; x: number; y: number; ms?: number }
  /**
   * Type into a field. With x/y the field is tapped first (Holo4's
   * `mobile_write` contract: one call focuses and types). `overwrite` clears
   * what is there; `enter` presses the keyboard's action key afterwards.
   */
  | { kind: "type"; text: string; x?: number; y?: number; overwrite?: boolean; enter?: boolean }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
  /** Scroll the content in `direction`; factor is the share of a screen, default 0.5. */
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; factor?: number }
  | { kind: "key"; key: Key }
  | { kind: "hide_keyboard" }
  | { kind: "wait"; ms: number };

/** Touch screens and remote-driven screens are explored differently. */
export type Surface = "touch" | "dpad";

/** What an actuator can do, so the loop offers the model only those tools. */
export type ActuatorCaps = {
  surface: Surface;
  /** Keys `act({kind:"key"})` accepts. */
  keys: readonly Key[];
  /** Whether `nodes` can be expected at all (false for a Roku without app-ui). */
  tree: boolean;
  /** Whether `foreground` is ever non-null. */
  foreground: boolean;
};

/** A crash or hang the platform recorded, since the last time anyone asked. */
export type CrashReport = {
  count: number;
  /** One line per crash: exception class and message, or the signal. */
  signatures: string[];
  /** Raw log excerpt for the report, already trimmed. */
  excerpt: string;
  /** Problems reading the log, said rather than reported as zero crashes. */
  problems: string[];
};

/**
 * One way of reaching one device.
 *
 * Every method may throw; the loop records the error on the step and decides
 * whether the mission can continue. None of them may block longer than its
 * own timeout -- a hung `observe` must not outlive the lease.
 */
export interface Actuator {
  readonly target: Target;
  readonly caps: ActuatorCaps;
  /**
   * Install `file` if given, then make sure `appId` starts from a clean state:
   * data cleared, permissions as `prepare` left them, nothing in the
   * background. Called before every mission and before every replay.
   */
  reset(appId: string, opts?: { file?: string; launchArgs?: string[] }): Promise<void>;
  /** Start (or bring to front) the app. */
  launch(appId: string, launchArgs?: string[]): Promise<void>;
  observe(): Promise<Observation>;
  act(a: Action): Promise<void>;
  /** Crashes and hangs for `appId` since the previous call (the first call sets the baseline). */
  crashes(appId: string): Promise<CrashReport>;
  /** Release whatever the actuator started: a driver process, a port forward. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/**
 * A mission card. Kept per app under examples/missions/<app>/*.json.
 *
 * A persona and a goal give the model a reason to go somewhere; the budget
 * stops it going there forever. `allow` is the only way a mission may reach
 * the controls the leash blocks by default (deleting the account, buying
 * something, inviting someone).
 */
export type Mission = {
  id: string;
  /** Which app this is for: the key used for screen maps and findings. */
  app: string;
  title: string;
  /** Who the model is pretending to be, in a sentence. */
  persona: string;
  /** What to try to do, in a sentence or two. */
  goal: string;
  /**
   * How to tell the goal was reached, checked by the goal judge after the run.
   * Plain language: "a plant named 'Fern' is in the plant list".
   */
  success?: string;
  /** Steps and minutes. A step is one model call, whatever it chained. */
  budget?: { steps?: number; minutes?: number };
  surfaces?: Surface[];
  /** Screen names this mission is likely to reach, matched against changed files (D6). */
  screens?: string[];
  /** Leash exceptions this mission is allowed: "delete", "purchase", "invite", "sign_out". */
  allow?: string[];
  /**
   * Extra controls this mission must not touch, as case-insensitive regular
   * expressions over the control's label: a build that talks to a production
   * backend blocks "create account" so the explorer cannot make real accounts.
   */
  block?: string[];
  /** A Maestro flow (relative to the flows dir) that signs in before the model starts. */
  setup_flow?: string;
  /** Launch arguments, for apps with a UI-test mode (-uiTestSignedOut and friends). */
  launch_args?: string[];
  /**
   * For the mission bench (B4): an end state the harness can check without a
   * model, by looking for text or a focused element in the final tree.
   */
  check?: {
    /** Each must appear in some element's text, label (content-desc) or value; case-insensitive substring. */
    text?: string[];
    /** None of these may appear anywhere on the final screen: "the plant is gone" is checked this way. */
    absent_text?: string[];
    focused_label?: string;
    screen?: string;
  };
};

// ---------------------------------------------------------------------------
// What a run leaves behind
// ---------------------------------------------------------------------------

/** One model turn and what came of it. */
export type TrajectoryStep = {
  i: number;
  at: string;
  /** The screen's identity in the screen map, and whether it was new. */
  screen: string;
  newScreen: boolean;
  /** The model's narration and reasoning, trimmed. */
  note: string;
  thought: string;
  /** The model's calls as it made them, before conversion. */
  calls: { name: string; args: Record<string, unknown> }[];
  /** What was actually done, after snapping and the leash. */
  actions: Action[];
  /** Calls the leash refused, with the reason. */
  refused: { call: string; reason: string }[];
  /** Taps that landed on nothing tappable; the agent's misses, not the app's bugs. */
  misses: number;
  /** Model latency and tokens for this step (B2 is built from these). */
  model: { ms: number; promptTokens: number | null; completionTokens: number | null; cachedTokens: number | null };
  /** Checks that fired on this step. */
  checks: { check: CheckName; detail: string }[];
  /** Artifact-relative path of the screenshot taken before the step. */
  shot: string;
  error?: string;
};

export type CheckName =
  | "crash" | "anr" | "frozen" | "blank" | "left_app" | "a11y"
  | "visual" | "goal" | "regression" | "agent_stuck"
  /** A control the tree calls tappable that changed nothing when tapped, twice. */
  | "dead_control"
  /** The leash refused something the screen talked the agent into (a planted instruction). */
  | "leash";

/** Every CheckName, for validation on the collector side. */
export const CHECK_NAMES: readonly CheckName[] = [
  "crash", "anr", "frozen", "blank", "left_app", "a11y", "visual", "goal",
  "regression", "agent_stuck", "dead_control", "leash",
];

/**
 * A finding, as the executor posts it to the collector's `POST /findings`.
 *
 * `fingerprint` is what merges duplicates (T2): app, surface, screen, check and
 * the message with its numbers, ids and quoted strings stripped. The collector
 * upserts on it, so the second night that sees the same crash raises a count
 * instead of a second report.
 */
export type ExploreFinding = {
  fingerprint: string;
  app: string;
  build: string;
  platform: string;
  device_id: string;
  job_id: string;
  mission_id: string;
  check: CheckName;
  /**
   * Finer than the check, where one exists: the visual judge's class
   * (overlap, clipped, raw_error...). Precision is kept per check AND
   * subclass, so a judge that is wrong about contrast can be switched off
   * without losing the one that is right about raw error text.
   */
  subclass?: string | null;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  /** The screen-map id where it happened, and a readable name for it. */
  screen: string;
  screen_name: string;
  /** Steps a person would follow, one per line, from the trajectory. */
  steps: string[];
  /**
   * The replay (T1): what kind of file, its artifact hash, and how many of the
   * replays reproduced the check. `reproduced < attempts` is filed as flaky,
   * `reproduced == 0` is not filed at all.
   */
  replay: { kind: "maestro" | "tvloop" | "none"; sha256: string | null; attempts: number; reproduced: number } | null;
  /** Artifact hashes: screenshot at the moment, contact sheet, trajectory JSON, log excerpt. */
  artifacts: { shot?: string; sheet?: string; trajectory?: string; log?: string; replay?: string };
};

/** A person's verdict on a finding (T4). Also the training label if E8 ever happens. */
export type Verdict = "real" | "duplicate" | "not_a_bug" | "agent_mistake";
