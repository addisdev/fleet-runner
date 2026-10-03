/**
 * One mission: look, decide, check, act, until the budget runs out.
 *
 * The order inside a step is the design, so it is worth stating:
 *
 *   1. observe       screenshot, tree, what is in front, where focus is
 *   2. place it      which screen this is in the map, and whether it is new
 *   3. check it      checks that need no model: blank screen, left the app,
 *                    accessibility (once per screen), and the visual judge
 *                    (once per screen, if one is configured)
 *   4. ask           the model gets the screenshot plus a line or two from
 *                    the harness (step count, novelty, notices)
 *   5. leash         every action is snapped onto the element under it and
 *                    refused if that element is a dangerous control
 *   6. act           then wait for the screen to settle
 *   7. crash check   the platform's crash and ANR logs since step 1
 *
 * The checks never stop a mission. A crash is a candidate and the app is
 * relaunched; leaving the app is noted and undone; a frozen screen is noted
 * and the model told. A run that stopped at its first problem could only
 * ever report one.
 *
 * Nothing found here is a finding yet. Candidates go to `confirm`, which
 * replays each one on a clean install and asks the same question again. That
 * is the step that keeps the morning list short and true.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { a11yFindings, type A11yGeometry, type A11yNode } from "../../a11y-tree.js";
import { resolveFlow, runFlow } from "../flows.js";
import type { Target } from "../types.js";
import { dhash, hamming, isBlank } from "./image.js";
import { judgeGoal, judgeVisual } from "./judge.js";
import { leash, leftApp, snap } from "./leash.js";
import { Conversation, convertCall, missionPrompt, systemPrompt, type ModelConfig } from "./model.js";
import { replayThrough, type Executed } from "./replay.js";
import type { ScreenEntry, ScreenMap } from "./screenmap.js";
import type { Action, Actuator, CheckName, Mission, Observation, TrajectoryStep } from "./types.js";

export type LoopDeps = {
  actuator: Actuator;
  appId: string;
  /** The app's name as the model should call it. */
  appName: string;
  /** An installable build, reinstalled on every reset; null keeps what is installed. */
  appFile: string | null;
  model: ModelConfig;
  judge: ModelConfig | null;
  map: ScreenMap;
  /** Where this mission's screenshots and trajectory are written. */
  runDir: string;
  /** The night this belongs to (the job id), for the screen map. */
  night: string;
  log(msg: string): void;
  /** Called after every step; the workload beacons here so the lease never lapses. */
  onStep?(step: TrajectoryStep, obs: Observation): Promise<void>;
  /** Visual classes the owner's verdicts have switched off. */
  disabledVisual?: string[];
  /** Whole checks the owner's verdicts have switched off (never crash or anr). */
  disabledChecks?: string[];
  /** Language the app should be in tonight, for the untranslated check. */
  language?: string | null;
  /** Lines added to the mission prompt: today's changes, the condition in force. */
  hints?: string[];
  /** Maestro env for the setup flow (credentials resolved on the host). */
  setupEnv?: Record<string, string>;
  /** Run the setup flow; null where Maestro cannot reach the device. */
  canRunFlows: boolean;
  /** Epoch ms when the night ends; the mission stops early when it comes. */
  deadline: number;
  /** Send the app to the background once, at this share of the step budget (the "background" condition). */
  backgroundAt?: number | null;
};

/** A candidate finding: something a check saw, not yet replayed. */
export type Candidate = {
  check: CheckName;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  step: number;
  screen: ScreenEntry;
  /** How many executed entries lead up to it: the replay prefix. */
  upTo: number;
  /** What makes two of these the same: crash signature, visual class, element. */
  key: string;
  /** For a dead control: where it is, so the replay can tap it again. */
  point?: { x: number; y: number };
  /** For visual: which class the judge named. */
  visualClass?: string;
  /** For goal: what the mission wanted, so the replay can ask the judge the same question. */
  goal?: { goal: string; success: string };
  /** Where it came from: an oracle, the judge, or the agent's own report. */
  source: "oracle" | "judge" | "agent";
  shot: string;
  logExcerpt?: string;
};

export type MissionResult = {
  mission: Mission;
  steps: TrajectoryStep[];
  executed: Executed[];
  candidates: Candidate[];
  answer: string | null;
  goal: { met: boolean | null; reason: string } | null;
  /** For bench missions: did the final screen satisfy `mission.check`? */
  bench: { passed: boolean; detail: string } | null;
  screen: { w: number; h: number };
  stats: {
    steps: number; actions: number; misses: number; refused: number; refusedByClass: Record<string, number>;
    newScreensEver: number; screensThisRun: number; modelMs: number[]; promptTokens: number[];
    cachedTokens: number[]; errors: number; leftApp: number; crashes: number; endedBy: string;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Numbers, hex, ids and quoted strings out of a message, so two of the same crash fingerprint alike. */
export function normalizeMessage(s: string): string {
  return s.toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#").replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#")
    .replace(/'[^']*'|"[^"]*"/g, "'…'").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * What the tree says the screen's state is: every element's text, value and
 * on/off state. Two looks with the same picture hash and the same state are
 * "nothing happened"; a switch that toggled changes the state even when it is
 * too small to move the hash.
 */
export function stateSig(nodes: A11yNode[] | null): string {
  if (!nodes) return "";
  return createHash("sha1").update(nodes.map((n) => `${n.cls}|${n.text}|${n.label}|${n.value}|${n.checked ? 1 : 0}|${n.focused ? 1 : 0}|${n.enabled ? 1 : 0}`).join("\n")).digest("hex");
}

/** Nothing happened between two looks. */
export function unchanged(h1: string, s1: string, h2: string, s2: string): boolean {
  return hamming(h1, h2) <= 2 && s1 === s2;
}

export function fingerprint(app: string, surface: string, screen: string, check: string, key: string): string {
  // Crashes are fingerprinted without the screen: the same exception reached
  // from two screens is one bug, and splitting it would double the morning
  // list for every crash in shared code.
  const where = check === "crash" || check === "anr" ? "*" : screen;
  return createHash("sha1").update([app, surface, where, check, normalizeMessage(key)].join("|")).digest("hex");
}

/** Bench check (B4): is the mission's end state on the final screen? */
export function benchCheck(check: Mission["check"], nodes: A11yNode[] | null, screenName: string): { passed: boolean; detail: string } {
  if (!check) return { passed: false, detail: "no check" };
  const visible = (nodes ?? []).flatMap((n) => [n.text, n.label, n.value]).filter(Boolean).map((s) => s.toLowerCase());
  const missing = (check.text ?? []).filter((t) => !visible.some((v) => v.includes(t.toLowerCase())));
  if (missing.length) return { passed: false, detail: `not on the final screen: ${missing.map((m) => JSON.stringify(m)).join(", ")}` };
  const present = (check.absent_text ?? []).filter((t) => visible.some((v) => v.includes(t.toLowerCase())));
  if (present.length) return { passed: false, detail: `still on the final screen: ${present.map((m) => JSON.stringify(m)).join(", ")}` };
  if (check.focused_label) {
    const f = (nodes ?? []).find((n) => n.focused);
    const label = (f?.label || f?.text || "").toLowerCase();
    if (!label.includes(check.focused_label.toLowerCase())) return { passed: false, detail: `focus is on ${JSON.stringify(label || "nothing")}, not ${JSON.stringify(check.focused_label)}` };
  }
  if (check.screen && !screenName.toLowerCase().includes(check.screen.toLowerCase())) {
    return { passed: false, detail: `ended on "${screenName}", not "${check.screen}"` };
  }
  return { passed: true, detail: "end state reached" };
}

const ISSUE_TO_CHECK: Record<string, { check: CheckName; cls?: string }> = {
  visual: { check: "visual" },
  dead_control: { check: "dead_control" },
  wrong_result: { check: "goal" },
  error_message: { check: "visual", cls: "raw_error" },
  language: { check: "visual", cls: "untranslated" },
  other: { check: "visual" },
};

export async function runMission(m: Mission, d: LoopDeps): Promise<MissionResult> {
  const { actuator, appId } = d;
  const caps = actuator.caps;
  const shotsDir = path.join(d.runDir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const maxSteps = m.budget?.steps ?? 40;
  const missionDeadline = Math.min(d.deadline, Date.now() + (m.budget?.minutes ?? 30) * 60_000);

  const stats: MissionResult["stats"] = {
    steps: 0, actions: 0, misses: 0, refused: 0, refusedByClass: {}, newScreensEver: 0, screensThisRun: 0,
    modelMs: [], promptTokens: [], cachedTokens: [], errors: 0, leftApp: 0, crashes: 0, endedBy: "budget",
  };
  const steps: TrajectoryStep[] = [];
  const executed: Executed[] = [];
  const candidates: Candidate[] = [];
  let answer: string | null = null;
  let screen = { w: 0, h: 0 };

  // --- a clean start ---------------------------------------------------
  await actuator.reset(appId, { file: d.appFile ?? undefined, launchArgs: m.launch_args });
  if (m.setup_flow) {
    if (!d.canRunFlows) throw new Error(`mission ${m.id} needs setup flow ${m.setup_flow}, and Maestro cannot reach ${actuator.target.id}`);
    const err = await runFlow(actuator.target, resolveFlow(m.setup_flow), path.join(d.runDir, "maestro"), { APP_ID: appId, ...d.setupEnv }, 180_000);
    if (err) throw new Error(`setup flow ${m.setup_flow} failed: ${err.slice(-200)}`);
  }
  await actuator.crashes(appId);

  const conv = new Conversation(
    d.model,
    systemPrompt({ platform: actuator.target.platform, caps, appName: d.appName }),
    missionPrompt(m, d.hints ?? []),
    caps,
  );

  const a11yDone = new Set<string>();
  const judged = new Set<string>();
  const deadTaps = new Map<string, number>();
  let results: string[] = [];
  let lastNewStep = 0;
  let consecutiveErrors = 0;
  let sameScreenRun = 0;
  let prevHash: string | null = null;
  let pending: { tapKey: string; hashBefore: string; sigBefore: string; point: { x: number; y: number }; label: string } | null = null;
  let prevSig = "";
  let lastObs: Observation | null = null;

  for (let i = 1; i <= maxSteps; i++) {
    if (Date.now() > missionDeadline) { stats.endedBy = "time"; break; }

    let obs: Observation;
    try {
      obs = await actuator.observe();
    } catch (e) {
      stats.errors++;
      d.log(`observe failed at step ${i}: ${(e as Error).message.slice(0, 160)}`);
      if (++consecutiveErrors > 3) { stats.endedBy = "device"; break; }
      await sleep(2000);
      continue;
    }
    lastObs = obs;
    screen = { w: obs.width, h: obs.height };
    // A device whose screenshots are blank while its tree is full of text is
    // not showing a blank app: it cannot capture its screen (an Android ATD
    // image does exactly this). A model driving it would see nothing all night.
    if (i === 1 && isBlank(obs.png).blank && (obs.nodes ?? []).filter((n) => (n.text || n.label).trim()).length >= 3) {
      throw new Error(`${actuator.target.id} returns blank screenshots while its UI tree has text; it cannot be explored by sight (an ATD emulator image? use google_apis)`);
    }
    const shotName = `${String(i).padStart(3, "0")}.png`;
    writeFileSync(path.join(shotsDir, shotName), obs.png);
    // The tree beside the picture: the pointing bench (B1) harvests its
    // targets from these, so every night's run grows the benchmark.
    if (obs.nodes) writeFileSync(path.join(shotsDir, shotName.replace(/\.png$/, ".nodes.json")), JSON.stringify(obs.nodes));
    const hash = dhash(obs.png);
    const sig = stateSig(obs.nodes);
    const place = d.map.identify(obs.nodes, hash, obs.height, d.night);
    if (place.newEver) stats.newScreensEver++;
    if (place.newThisRun) { lastNewStep = i; stats.screensThisRun++; }

    const stepChecks: TrajectoryStep["checks"] = [];
    const notices: string[] = [];
    const flag = (c: Omit<Candidate, "step" | "screen" | "upTo" | "shot">) => {
      if (d.disabledChecks?.includes(c.check)) return;
      if (c.check === "visual" && c.visualClass && d.disabledVisual?.includes(c.visualClass)) return;
      candidates.push({ ...c, step: i, screen: place.entry, upTo: executed.length, shot: shotName });
      stepChecks.push({ check: c.check, detail: c.detail });
    };

    // A dead control: the previous step tapped something tappable and the
    // screen did not change at all. Twice on the same control is a candidate.
    if (pending && unchanged(pending.hashBefore, pending.sigBefore, hash, sig)) {
      const n = (deadTaps.get(pending.tapKey) ?? 0) + 1;
      deadTaps.set(pending.tapKey, n);
      if (n === 2) {
        flag({
          check: "dead_control", severity: "medium", source: "oracle", key: pending.tapKey, point: pending.point,
          title: `"${pending.label}" does nothing when tapped`,
          detail: `Tapping "${pending.label}" on ${place.entry.name} left the screen unchanged, twice.`,
        });
      }
    }
    pending = null;

    // Frozen: nothing has changed for four steps in which something was done.
    sameScreenRun = prevHash && unchanged(prevHash, prevSig, hash, sig) ? sameScreenRun + 1 : 0;
    prevHash = hash;
    prevSig = sig;
    if (sameScreenRun === 4) {
      flag({
        check: "frozen", severity: "high", source: "oracle", key: place.entry.id,
        title: `${place.entry.name} stops responding`,
        detail: `The screen stayed identical for four steps of input on ${place.entry.name}.`,
      });
      notices.push("The screen has not changed for several steps. Try going back, or a different control.");
    }

    if (i > 1 && obs.foreground === appId) {
      const b = isBlank(obs.png);
      if (b.blank) {
        flag({
          check: "blank", severity: "high", source: "oracle", key: place.entry.id,
          title: `Blank screen after reaching ${place.entry.name}`,
          detail: `The app is in front and the screen is one flat colour (luminance spread ${b.stddev}).`,
        });
      }
    }

    if (leftApp(obs.foreground, appId)) {
      stats.leftApp++;
      stepChecks.push({ check: "left_app", detail: `${obs.foreground} is in front` });
      // Back once, then relaunch if that did not do it. Leaving is the
      // agent's doing far more often than the app's, so it is noted on the
      // step, not made a candidate; a link that throws the user out of the
      // app shows up as a reproducible exit in the replay of whatever led there.
      await actuator.act({ kind: "key", key: "back" }).catch(() => {});
      await sleep(800);
      const again = await actuator.observe().catch(() => null);
      if (!again || leftApp(again.foreground, appId)) {
        await actuator.launch(appId, m.launch_args);
        executed.push({ step: i, kind: "relaunch" });
      }
      notices.push(`You left the app (${obs.foreground} came to the front). The harness brought ${d.appName} back. Stay inside the app.`);
      results = results.map(() => "ok");
      continue;
    }

    if (place.newThisRun && obs.nodes && !a11yDone.has(place.entry.id)) {
      a11yDone.add(place.entry.id);
      const geometry: A11yGeometry = caps.surface === "touch" && actuator.target.platform === "android"
        ? { unit: "unknown" } : { unit: "points" };
      for (const f of a11yFindings(obs.nodes, geometry, { step: place.entry.name, cap: 5 })) {
        if (f.check !== "a11y-label") continue;
        flag({
          check: "a11y", severity: "low", source: "oracle", key: f.detail.replace(/ at \d+,\d+ \(\d+x\d+\)/, ""),
          title: `Unlabelled control on ${place.entry.name}`, detail: f.detail,
        });
      }
    }

    if (d.judge && place.newThisRun && !judged.has(place.entry.id) && !d.disabledChecks?.includes("visual")) {
      judged.add(place.entry.id);
      const v = await judgeVisual(d.judge, obs.png, { language: d.language, disabled: d.disabledVisual });
      if (v.error) d.log(`visual judge: ${v.error.slice(0, 160)}`);
      for (const issue of v.issues) {
        flag({
          check: "visual", severity: issue.cls === "raw_error" ? "high" : "medium", source: "judge",
          key: `${issue.cls}:${issue.where}`, visualClass: issue.cls,
          title: `${issue.cls.replace("_", " ")} on ${place.entry.name}`, detail: `${issue.description}${issue.where ? ` (${issue.where})` : ""}`,
        });
      }
    }

    if (d.backgroundAt && i === Math.max(2, Math.round(maxSteps * d.backgroundAt))) {
      await actuator.act({ kind: "key", key: "home" }).catch(() => {});
      await sleep(3000);
      await actuator.launch(appId, m.launch_args);
      executed.push({ step: i, kind: "home" });
      notices.push("The harness sent the app to the background and brought it back. Check that nothing you entered was lost.");
    }

    // --- ask --------------------------------------------------------------
    const extra = [`Step ${i} of ${maxSteps}.`];
    extra.push(place.newEver ? `This screen ("${place.entry.name}") is new: no run has seen it before.`
      : place.newThisRun ? `This screen ("${place.entry.name}") is new this run.`
      : `You have been on "${place.entry.name}" before.`);
    if (i - lastNewStep >= 10) {
      const un = d.map.unvisited(5).map((s) => `"${s.name}"`);
      extra.push(`<harness>No new screen for ${i - lastNewStep} steps. Go somewhere you have not been${un.length ? `, for example ${un.join(", ")}` : ""}.</harness>`);
    }
    for (const n of notices) extra.push(`<harness>${n}</harness>`);
    if (i === maxSteps - 2) extra.push("<harness>Two steps left. Finish with `answer` soon.</harness>");

    const turn = await conv.next(obs, results, extra);
    results = [];
    stats.modelMs.push(turn.ms);
    if (turn.usage.promptTokens !== null) stats.promptTokens.push(turn.usage.promptTokens);
    if (turn.usage.cachedTokens !== null) stats.cachedTokens.push(turn.usage.cachedTokens);

    const step: TrajectoryStep = {
      i, at: new Date().toISOString(), screen: place.entry.id, newScreen: place.newThisRun,
      note: turn.text.slice(0, 600), thought: turn.thought.slice(0, 1200),
      calls: turn.calls.map((c) => ({ name: c.name, args: c.args })),
      actions: [], refused: [], misses: 0,
      model: { ms: turn.ms, promptTokens: turn.usage.promptTokens, completionTokens: turn.usage.completionTokens, cachedTokens: turn.usage.cachedTokens },
      checks: stepChecks, shot: `shots/${shotName}`,
      ...(turn.error ? { error: turn.error } : {}),
    };

    if (turn.calls.length === 0) {
      stats.errors++;
      steps.push(step);
      if (++consecutiveErrors > 3) { stats.endedBy = "model"; break; }
      conv.say("Your last reply had no tool call. Every reply must call at least one tool.");
      continue;
    }
    consecutiveErrors = 0;

    // --- leash and act ----------------------------------------------------
    let done = false;
    for (const call of turn.calls) {
      const converted = convertCall(call, obs.width, obs.height, caps);
      const answers: string[] = [];
      for (const c of converted) {
        if (c.kind === "invalid") { answers.push(`error: ${c.reason}`); continue; }
        if (c.kind === "note") { answers.push("Note recorded"); continue; }
        if (c.kind === "plan") { answers.push(c.text || "Plan updated"); continue; }
        if (c.kind === "answer") { answer = c.text; done = true; answers.push("Mission finished"); continue; }
        if (c.kind === "issue") {
          const map = ISSUE_TO_CHECK[c.issue.kind] ?? ISSUE_TO_CHECK.other;
          // The agent's own report is a lead, never a finding: visual ones
          // go to the judge on replay, the rest to the replay itself.
          flag({
            check: map.check, severity: "medium", source: "agent", visualClass: map.cls,
            key: `${c.issue.kind}:${c.issue.element ?? c.issue.description}`,
            title: `${c.issue.description.slice(0, 80)}`, detail: c.issue.description,
          });
          answers.push("Reported. Keep exploring.");
          continue;
        }
        if (c.kind === "home") {
          await actuator.act({ kind: "key", key: "home" }).catch(() => {});
          await sleep(1500);
          await actuator.launch(appId, m.launch_args);
          executed.push({ step: i, kind: "home" });
          answers.push("The app went to the background and was brought back.");
          continue;
        }
        if (caps.surface === "dpad" && c.action.kind !== "key" && c.action.kind !== "type" && c.action.kind !== "wait") {
          answers.push("error: this device has no touch input; use tv_press");
          continue;
        }
        const snapped = snap(c.action, obs.nodes, { w: obs.width, h: obs.height });
        if (snapped.miss) { step.misses++; stats.misses++; }
        const focusedNode = caps.surface === "dpad" && c.action.kind === "key" && c.action.key === "select"
          ? obs.nodes?.find((n) => n.focused) ?? null : null;
        const verdict = leash(snapped.action, snapped.node ?? focusedNode, obs.nodes, m.allow ?? [], m.block ?? []);
        if (!verdict.ok) {
          stats.refused++;
          stats.refusedByClass[verdict.danger] = (stats.refusedByClass[verdict.danger] ?? 0) + 1;
          step.refused.push({ call: call.name, reason: verdict.reason });
          answers.push(`refused by the harness: ${verdict.reason}`);
          continue;
        }
        try {
          const before = hash;
          await actuator.act(snapped.action);
          const settleMs = settleFor(snapped.action, caps.surface);
          await sleep(settleMs);
          executed.push({ step: i, kind: "action", action: snapped.action, settleMs });
          step.actions.push(snapped.action);
          stats.actions++;
          answers.push(snapped.miss ? "ok (nothing tappable at that point)" : "ok");
          if ((snapped.action.kind === "tap") && snapped.node && !snapped.miss) {
            const label = (snapped.node.label || snapped.node.text || snapped.node.id.split("/").pop() || snapped.node.cls).trim();
            pending = { tapKey: `${place.entry.id}:${label}:${snapped.node.id}`, hashBefore: before, sigBefore: sig, point: { x: snapped.action.x, y: snapped.action.y }, label };
          }
        } catch (e) {
          answers.push(`error: ${(e as Error).message.slice(0, 200)}`);
          step.error = (e as Error).message.slice(0, 300);
        }
      }
      results.push(answers.join("; ") || "ok");
    }

    // --- crashes ------------------------------------------------------------
    const cr = await actuator.crashes(appId).catch((e) => ({ count: 0, signatures: [], excerpt: "", problems: [(e as Error).message] }));
    if (cr.count > 0) {
      stats.crashes += cr.count;
      for (const sig of cr.signatures) {
        const anr = sig.startsWith("ANR");
        candidates.push({
          check: anr ? "anr" : "crash", severity: "high", source: "oracle", key: sig, step: i, screen: place.entry,
          upTo: executed.length, shot: shotName, logExcerpt: cr.excerpt,
          title: anr ? `App not responding after an action on ${place.entry.name}` : `Crash: ${sig.slice(0, 100)}`,
          detail: `${sig} (after step ${i} on ${place.entry.name})`,
        });
        step.checks.push({ check: anr ? "anr" : "crash", detail: sig });
      }
      await sleep(1000);
      await actuator.launch(appId, m.launch_args).catch(() => {});
      executed.push({ step: i, kind: "relaunch" });
      conv.say("The app crashed and the harness restarted it. Carry on exploring.");
      pending = null;
    }

    steps.push(step);
    stats.steps = i;
    await d.onStep?.(step, obs);
    if (done) { stats.endedBy = "answer"; break; }
    if (i - lastNewStep >= 18) { stats.endedBy = "stuck"; break; }
  }

  // --- the end state --------------------------------------------------------
  let goal: MissionResult["goal"] = null;
  let bench: MissionResult["bench"] = null;
  const final = await actuator.observe().catch(() => lastObs);
  if (final) {
    writeFileSync(path.join(shotsDir, "final.png"), final.png);
    const finalScreen = d.map.identify(final.nodes, dhash(final.png), final.height, d.night).entry;
    if (m.check) bench = benchCheck(m.check, final.nodes, finalScreen.name);
    if (d.judge && m.success && !m.check && !d.disabledChecks?.includes("goal")) {
      const g = await judgeGoal(d.judge, final.png, m.goal, m.success, final.nodes);
      goal = { met: g.met, reason: g.reason };
      if (g.met === false) {
        candidates.push({
          check: "goal", severity: "medium", source: "judge", key: m.id, step: stats.steps, screen: finalScreen,
          upTo: executed.length, shot: "final.png", goal: { goal: m.goal, success: m.success },
          title: `"${m.title}" did not hold`, detail: `${m.success} — but: ${g.reason}`,
        });
      }
    }
  }
  d.map.save();
  return { mission: m, steps, executed, candidates, answer, goal, bench, screen, stats };
}

/** How long to let the screen settle after an action before looking again. */
function settleFor(a: Action, surface: "touch" | "dpad"): number {
  if (a.kind === "wait") return 0;
  if (surface === "dpad") return 450;
  if (a.kind === "type") return 500;
  if (a.kind === "scroll" || a.kind === "swipe") return 700;
  return 900;
}

// ---------------------------------------------------------------------------
// Confirmation: replay each candidate on a clean install (T1)
// ---------------------------------------------------------------------------

export type Confirmed = Candidate & { attempts: number; reproduced: number; replayNotes: string[] };

/**
 * Replay one candidate `attempts` times and count how often its check fires
 * again. The caller decides what to file: a crash is evidence by itself; any
 * other check that never reproduces is dropped.
 */
export async function confirm(
  c: Candidate, r: MissionResult, d: LoopDeps, attempts = 2,
): Promise<Confirmed> {
  const notes: string[] = [];
  let reproduced = 0;
  const m = r.mission;
  for (let k = 0; k < attempts; k++) {
    try {
      await d.actuator.reset(d.appId, { file: d.appFile ?? undefined, launchArgs: m.launch_args });
      if (m.setup_flow && d.canRunFlows) {
        const err = await runFlow(d.actuator.target, resolveFlow(m.setup_flow), path.join(d.runDir, "maestro"), { APP_ID: d.appId, ...d.setupEnv }, 180_000);
        if (err) { notes.push(`attempt ${k + 1}: setup failed`); continue; }
      }
      await d.actuator.crashes(d.appId);
      await replayThrough(d.actuator, d.appId, r.executed, c.upTo, m.launch_args);
      const hit = await checkAgain(c, d);
      notes.push(`attempt ${k + 1}: ${hit.hit ? "reproduced" : "not reproduced"}${hit.note ? ` (${hit.note})` : ""}`);
      if (hit.hit) reproduced++;
    } catch (e) {
      notes.push(`attempt ${k + 1}: replay failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return { ...c, attempts, reproduced, replayNotes: notes };
}

async function checkAgain(c: Candidate, d: LoopDeps): Promise<{ hit: boolean; note?: string }> {
  const a = d.actuator;
  switch (c.check) {
    case "crash":
    case "anr": {
      await sleep(1500);
      const cr = await a.crashes(d.appId);
      const same = cr.signatures.some((s) => normalizeMessage(s) === normalizeMessage(c.key));
      return { hit: cr.count > 0 && (same || c.check === "anr"), note: cr.signatures[0] };
    }
    case "blank": {
      await sleep(1500);
      const o = await a.observe();
      return { hit: o.foreground === d.appId && isBlank(o.png).blank };
    }
    case "frozen": {
      const o1 = await a.observe();
      await a.act({ kind: "key", key: a.caps.keys.includes("back") ? "back" : "home" }).catch(() => {});
      await sleep(1500);
      const o2 = await a.observe();
      return { hit: o2.foreground === d.appId && unchanged(dhash(o1.png), stateSig(o1.nodes), dhash(o2.png), stateSig(o2.nodes)) };
    }
    case "dead_control": {
      if (!c.point) return { hit: false, note: "no point recorded" };
      const o1 = await a.observe();
      await a.act({ kind: "tap", ...c.point });
      await sleep(1200);
      const o2 = await a.observe();
      return { hit: unchanged(dhash(o1.png), stateSig(o1.nodes), dhash(o2.png), stateSig(o2.nodes)) };
    }
    case "a11y": {
      const o = await a.observe();
      if (!o.nodes) return { hit: false, note: "no tree on replay" };
      const again = a11yFindings(o.nodes, { unit: "unknown" }, { step: c.screen.name, cap: 25 })
        .some((f) => f.check === "a11y-label" && f.detail.replace(/ at \d+,\d+ \(\d+x\d+\)/, "") === c.key);
      return { hit: again };
    }
    case "visual": {
      if (!d.judge) return { hit: false, note: "no judge configured" };
      await sleep(800);
      const o = await a.observe();
      const v = await judgeVisual(d.judge, o.png, { language: d.language, disabled: d.disabledVisual });
      const hit = c.visualClass ? v.issues.some((i) => i.cls === c.visualClass) : v.issues.length > 0;
      return { hit, note: v.issues.map((i) => i.cls).join(", ") || "judge saw nothing" };
    }
    case "goal": {
      // The agent's own "wrong result" reports have no success criterion to
      // re-ask about, so only the judge's goal verdicts can be replayed.
      if (!d.judge || !c.goal) return { hit: false, note: c.goal ? "no judge configured" : "no success criterion to check" };
      await sleep(800);
      const o = await a.observe();
      const g = await judgeGoal(d.judge, o.png, c.goal.goal, c.goal.success, o.nodes);
      return { hit: g.met === false, note: g.reason };
    }
    default:
      return { hit: false, note: `no replay check for ${c.check}` };
  }
}

export type { Target };
