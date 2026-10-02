/**
 * explore: a vision model uses tonight's build the way a person would, and
 * leaves a short list of reproduced bugs for the morning.
 *
 * EXPANSION-PLAN.md specified this as "a monkey test with a memory" and it was
 * never built, because the model was the missing part. It is a host workload:
 * the executor drives the device, and the model is somewhere on the network
 * behind an OpenAI-compatible gateway (on ultra, the `pilot` name points at
 * Holo4 35B-A3B with no cloud fallback, so a busy Studio delays QA and
 * nothing else).
 *
 * Per device, per mission, inside one night's budget:
 *
 *   1. wait for room (Load Warden, where it is installed)
 *   2. apply the night's condition (dark, largest text, Spanish, offline...)
 *   3. run the mission (loop.ts): observe, ask, leash, act, check
 *   4. replay every candidate on a clean install; keep what reproduces
 *   5. optionally replay it on the previous build too (O6): new or old?
 *   6. post the finding, with its steps, screenshot, sheet and Maestro flow
 *
 * Bench mode (`params.bench: true`) runs the `bench-` mission cards instead,
 * files nothing, and reports how many end states the model reached -- the
 * mission bench (B4) the plan compares models on.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BASE, NoTargetsError } from "../../fleet-client.js";
import { keychainPassword } from "../../secrets.js";
import type { Job, Target, WorkloadCtx } from "../types.js";
import { actuatorFor } from "./actuators/index.js";
import { conditionFor, parseConditions } from "./conditions.js";
import { toJpeg } from "./image.js";
import { confirm, fingerprint, runMission, type Candidate, type Confirmed, type LoopDeps, type MissionResult } from "./loop.js";
import { changedFiles, changedWords, loadMissions, orderMissions } from "./missions.js";
import type { ModelConfig } from "./model.js";
import { replayThrough, toMaestro } from "./replay.js";
import { stepsInWords, trajectorySheet } from "./report.js";
import { ScreenMap } from "./screenmap.js";
import type { Actuator, CheckName, ExploreFinding, Mission } from "./types.js";

const run = promisify(execFile);
const STATE_DIR = process.env.FLEET_STATE_DIR ?? path.join(os.homedir(), ".fleet");

type Params = {
  app_id: string;
  app_name?: string;
  /** Missions directory and screen-map key. Default: the app id's last part. */
  app_key?: string;
  missions?: string[];
  missions_dir?: string;
  bench?: boolean;
  model?: Partial<ModelWire>;
  judge?: Partial<ModelWire> | false;
  /** Minutes for the whole night on each device. Default 150. */
  minutes?: number;
  /** New findings to file per app per night. Default 5. */
  findings_per_night?: number;
  replay_attempts?: number;
  /** Candidates replayed per mission, most severe first. Default 6. */
  confirm_per_mission?: number;
  conditions?: string[];
  changed?: { repo?: string; since?: string; files?: string[] };
  previous_app?: { sha256: string; build?: string };
  surface?: "touch" | "dpad";
  credentials?: { account: string; email_var?: string; password_var?: string };
  mirror?: boolean;
};

type ModelWire = {
  base_url: string; model: string; max_pixels: number; keep_shots: number; keep_turns: number;
  tree_hints: boolean; extra_body: Record<string, unknown>; max_tokens: number; timeout_s: number;
};

/** Pure: the model configs from params and the environment, without the key. */
export function modelConfigs(p: Params, env: NodeJS.ProcessEnv = process.env): { model: ModelConfig; judge: ModelConfig | null } {
  const base = p.model?.base_url ?? env.FLEET_EXPLORE_BASE_URL ?? "http://ultra.local:4000";
  const shape = (w: Partial<ModelWire> | undefined, fallbackModel: string): ModelConfig => ({
    baseUrl: w?.base_url ?? base,
    model: w?.model ?? fallbackModel,
    maxPixels: w?.max_pixels,
    keepShots: w?.keep_shots,
    keepTurns: w?.keep_turns,
    treeHints: w?.tree_hints,
    extraBody: w?.extra_body,
    maxTokens: w?.max_tokens,
    timeoutMs: w?.timeout_s ? w.timeout_s * 1000 : undefined,
  });
  const model = shape(p.model, env.FLEET_EXPLORE_MODEL ?? "pilot");
  const judge = p.judge === false || p.bench ? null : shape(p.judge, env.FLEET_EXPLORE_JUDGE_MODEL ?? "vision");
  return { model, judge };
}

export function paramsProblem(p: Partial<Params> | undefined): string | null {
  if (!p || typeof p.app_id !== "string" || !p.app_id) return "params.app_id is required (the package or bundle id to explore)";
  if (p.minutes !== undefined && !(p.minutes > 0 && p.minutes <= 600)) return "params.minutes must be between 1 and 600";
  if (p.findings_per_night !== undefined && !(p.findings_per_night >= 0 && p.findings_per_night <= 50)) return "params.findings_per_night must be 0-50";
  if (p.replay_attempts !== undefined && !(p.replay_attempts >= 1 && p.replay_attempts <= 5)) return "params.replay_attempts must be 1-5";
  return null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

const SEVERITY: Record<Candidate["severity"], number> = { high: 0, medium: 1, low: 2 };
const SOURCE: Record<Candidate["source"], number> = { oracle: 0, judge: 1, agent: 2 };

/** Which candidates get the replay budget: worst first, oracle before judge before agent, one per fingerprint. */
export function pickCandidates(cs: Candidate[], app: string, surface: string, limit: number): { c: Candidate; fp: string }[] {
  const seen = new Set<string>();
  const out: { c: Candidate; fp: string }[] = [];
  for (const c of [...cs].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || SOURCE[a.source] - SOURCE[b.source] || a.step - b.step)) {
    const fp = fingerprint(app, surface, c.screen.id, c.check, c.key);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ c, fp });
    if (out.length >= limit) break;
  }
  return out;
}

/** Does this finding get filed? Crashes stand on their log; everything else must reproduce. */
export function fileable(c: Confirmed): boolean {
  if (c.check === "crash" || c.check === "anr") return true;
  return c.reproduced > 0;
}

async function wardenRoom(log: (m: string) => void): Promise<boolean> {
  try {
    await run("warden", ["wait", "--for", "device-ui-test", "--timeout", "1800"], { timeout: 1_900_000 });
    return true;
  } catch (e) {
    const err = e as { code?: string | number; stderr?: string };
    if (err.code === "ENOENT") return true; // no Load Warden on this host: nothing to ask
    log(`Load Warden had no room: ${(err.stderr ?? "").trim().slice(0, 160)}`);
    return false;
  }
}

async function postFinding(f: ExploreFinding): Promise<{ id?: number; new?: boolean; error?: string }> {
  try {
    const res = await fetch(`${BASE}/findings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
    const body = await res.json().catch(() => ({})) as { id?: number; new?: boolean; error?: string };
    if (!res.ok) return { error: body.error ?? `POST /findings -> ${res.status}` };
    return body;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * What the owner's verdicts have switched off for this app (O4: precision under
 * 30% after ten verdicts). A visual row with a subclass switches off that one
 * judge class; any other row switches off its whole check. Crashes and ANRs are
 * never switched off: their evidence is the platform's own log, not a judgement.
 */
export function switchedOff(body: { disabled?: { check: string; subclass?: string | null }[] }): { visual: string[]; checks: string[] } {
  const visual: string[] = [], checks: string[] = [];
  for (const d of body.disabled ?? []) {
    if (d.check === "crash" || d.check === "anr") continue;
    if (d.check === "visual" && d.subclass) visual.push(d.subclass);
    else checks.push(d.check);
  }
  return { visual, checks };
}

async function disabledClasses(app: string): Promise<{ visual: string[]; checks: string[] }> {
  try {
    const res = await fetch(`${BASE}/api/findings/precision?app=${encodeURIComponent(app)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { visual: [], checks: [] };
    return switchedOff(await res.json() as { disabled?: { check: string; subclass?: string | null }[] });
  } catch {
    return { visual: [], checks: [] };
  }
}

function mirrorFrame(jobId: string, png: Buffer) {
  void toJpeg(png).then((jpg) => {
    if (!jpg) return;
    const token = process.env.FLEET_DASH_TOKEN;
    return fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}/mirror`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", ...(token ? { "x-fleet-token": token } : {}) },
      body: new Uint8Array(jpg),
      signal: AbortSignal.timeout(5_000),
    });
  }).catch(() => { /* the live view never costs a step */ });
}

export async function run_(job: Job, ctx: WorkloadCtx): Promise<void> {
  const p = (job.params ?? {}) as Params;
  const problem = paramsProblem(p);
  if (problem) throw new Error(problem);
  const appKey = p.app_key ?? p.app_id.split(".").pop()!;
  const appName = p.app_name ?? appKey;

  const all = await ctx.listTargets();
  const targets = await ctx.selectTargets(job, all);
  if (targets.length === 0) throw new NoTargetsError(`no device matches this job on ${ctx.host}`);

  const { model, judge } = modelConfigs(p);
  const key = process.env.FLEET_EXPLORE_API_KEY
    ?? await keychainPassword("gateway", "fleet-explore-gateway").then((k) => (k.ok ? k.password : undefined));
  if (key) { model.apiKey = key; if (judge) judge.apiKey = key; }

  // An installable build, if the job names one. Without it the app already on
  // the device is explored, which is what a quick local run wants.
  const work = mkdtempSync(path.join(os.tmpdir(), `fleet-explore-${job.job_id}-`));
  let appFile: string | null = null;
  if (job.app?.sha256) {
    appFile = path.join(work, `app-${job.app.sha256.slice(0, 12)}${job.app.platform === "android" || /apk/i.test(job.app.name) ? ".apk" : ".zip"}`);
    await ctx.fetchArtifact(job.app.sha256, appFile);
  }
  let previousFile: string | null = null;
  if (p.previous_app?.sha256) {
    previousFile = path.join(work, `prev-${p.previous_app.sha256.slice(0, 12)}${appFile?.endsWith(".zip") ? ".zip" : ".apk"}`);
    await ctx.fetchArtifact(p.previous_app.sha256, previousFile);
  }

  let words: string[] = [];
  if (p.changed?.files) words = changedWords(p.changed.files);
  else if (p.changed?.repo) {
    try { words = changedWords(await changedFiles(p.changed.repo.replace(/^~(?=\/)/, os.homedir()), p.changed.since ?? "24 hours ago")); }
    catch (e) { ctx.log(`changed files: ${(e as Error).message.slice(0, 160)}`); }
  }

  const conditions = parseConditions(p.conditions);
  const disabled = p.bench ? { visual: [], checks: [] } : await disabledClasses(appKey);
  if (disabled.visual.length || disabled.checks.length) {
    ctx.log(`switched off by verdicts: ${[...disabled.checks, ...disabled.visual.map((v) => `visual/${v}`)].join(", ")}`);
  }

  let setupEnv: Record<string, string> = {};
  if (p.credentials) {
    const creds = await ctx.secrets.credentialsFor({ kind: "explore", credentials: p.credentials }, job.job_id);
    if (creds) setupEnv = { [creds.emailVar]: creds.account, [creds.passwordVar]: creds.password };
  }

  const deadline = Date.now() + (p.minutes ?? 150) * 60_000;
  const newCap = p.findings_per_night ?? 5;
  let newFiled = 0;

  if (job.targets?.exclusive) {
    const granted = await ctx.locks.acquire(job.job_id, targets.map((t) => t.id));
    for (const t of targets) if (!granted.has(t.id)) ctx.log(`${t.id} is held by another job; skipping it`);
    targets.splice(0, targets.length, ...targets.filter((t) => granted.has(t.id)));
  }

  try {
    for (const t of targets) {
      if (Date.now() > deadline) break;
      const r = await exploreDevice(t);
      await ctx.postResult({ job_id: job.job_id, device_id: t.id, iter: 0, ...r });
    }
  } finally {
    if (job.targets?.exclusive) await ctx.locks.release(job.job_id);
  }
  await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: true });

  async function exploreDevice(t: Target): Promise<Record<string, unknown>> {
    let actuator: Actuator;
    try {
      actuator = await actuatorFor(t, { surface: p.surface, log: (m) => ctx.log(`[${t.id}] ${m}`), rokuPassword: await rokuPassword(t) });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const surface = actuator.caps.surface;
    const map = new ScreenMap(appKey);
    const lastRunFile = path.join(STATE_DIR, "explore", appKey.replace(/[^\w.-]/g, "_"), "missions-last-run.json");
    const lastRun: Record<string, string> = existsSync(lastRunFile) ? JSON.parse(readFileSync(lastRunFile, "utf8")) as Record<string, string> : {};
    const problems: string[] = [];
    const cards = loadMissions(appKey, p.missions_dir, (m) => problems.push(m));
    // A card that signs in needs credentials; without them it would fail at
    // its setup flow every night and spend the budget learning nothing.
    const missions = orderMissions(cards, { surface, words, lastRun, only: p.missions, bench: p.bench })
      .filter((m) => !m.setup_flow || !/sign-?in/i.test(m.setup_flow) || Object.keys(setupEnv).length > 0);
    if (missions.length === 0) {
      await actuator.close();
      return { ok: false, error: `no ${p.bench ? "bench " : ""}missions for ${appKey} on a ${surface} device (looked in ${p.missions_dir ?? "examples/missions"}/${appKey})${problems.length ? `; problems: ${problems.join("; ")}` : ""}` };
    }

    const totals = { missions: 0, steps: 0, actions: 0, candidates: 0, findings: 0, findingsNew: 0, notReproduced: 0, misses: 0, refused: 0, benchPassed: 0, benchTotal: 0 };
    const stepMs: number[] = [], modelMs: number[] = [], promptTokens: number[] = [], cachedTokens: number[] = [];
    const missionLog: Record<string, unknown>[] = [];
    let lastStepAt = Date.now();

    try {
      for (const [k, m] of missions.entries()) {
        if (Date.now() > deadline - 3 * 60_000) break;
        if (!(await wardenRoom(ctx.log))) { missionLog.push({ id: m.id, skipped: "no room on this host" }); continue; }
        const condName = p.bench ? "baseline" : conditions[k % conditions.length];
        let cond;
        try { cond = await conditionFor(condName, t); }
        catch (e) { missionLog.push({ id: m.id, condition: condName, skipped: (e as Error).message }); continue; }
        const mission: Mission = { ...m, launch_args: [...(m.launch_args ?? []), ...cond.launchArgs] };
        const runDir = path.join(work, t.id.replace(/[^\w.-]/g, "_"), `${String(k + 1).padStart(2, "0")}-${m.id}`);
        mkdirSync(runDir, { recursive: true });
        const hints = [
          ...(cond.hint ? [`Condition: ${cond.hint}`] : []),
          ...(words.length ? [`Today's changes touched: ${words.slice(0, 12).join(", ")}. Spend time near those parts of the app.`] : []),
        ];
        const deps: LoopDeps = {
          actuator, appId: p.app_id, appName, appFile, model, judge, map, runDir, night: job.job_id,
          log: (msg) => ctx.log(`[${t.id}] ${msg}`), disabledVisual: disabled.visual, disabledChecks: disabled.checks, language: cond.language, hints,
          setupEnv, canRunFlows: t.platform === "android" || t.kind === "simulator", deadline,
          backgroundAt: cond.backgroundAt,
          onStep: async (step, obs) => {
            stepMs.push(Date.now() - lastStepAt);
            lastStepAt = Date.now();
            if (p.mirror !== false) mirrorFrame(job.job_id, obs.png);
            await ctx.postBeacon(job.job_id, t.id, { mission: m.id, step: step.i, screen: step.screen }).catch(() => {});
          },
        };

        ctx.log(`[${t.id}] mission ${m.id} (${condName})`);
        lastStepAt = Date.now();
        let result: MissionResult;
        try {
          result = await cond.around(() => runMission(mission, deps));
        } catch (e) {
          missionLog.push({ id: m.id, condition: condName, error: (e as Error).message.slice(0, 300) });
          ctx.log(`[${t.id}] mission ${m.id} failed: ${(e as Error).message.slice(0, 200)}`);
          continue;
        }
        lastRun[m.id] = new Date().toISOString();
        totals.missions++;
        totals.steps += result.stats.steps;
        totals.actions += result.stats.actions;
        totals.misses += result.stats.misses;
        totals.refused += result.stats.refused;
        totals.candidates += result.candidates.length;
        modelMs.push(...result.stats.modelMs);
        promptTokens.push(...result.stats.promptTokens);
        cachedTokens.push(...result.stats.cachedTokens);
        if (result.bench) { totals.benchTotal++; if (result.bench.passed) totals.benchPassed++; }

        const names = new Map<string, string>();
        for (const s of result.steps) names.set(s.screen, map.byId(s.screen)?.name ?? s.screen);
        writeFileSync(path.join(runDir, "trajectory.json"), JSON.stringify({
          job: job.job_id, device: t.id, mission: m, condition: condName, stats: result.stats, answer: result.answer,
          goal: result.goal, bench: result.bench, steps: result.steps, executed: result.executed,
          candidates: result.candidates.map(({ screen, ...c }) => ({ ...c, screen: screen.id, screen_name: screen.name })),
        }, null, 1));
        const sheet = trajectorySheet({
          title: `${appName}: ${m.title}`, subtitle: `${t.id} · ${condName} · ${result.stats.steps} steps · ended by ${result.stats.endedBy}`,
          runDir, steps: result.steps, screenNames: names,
        });
        writeFileSync(path.join(runDir, "sheet.html"), sheet);
        const runShas = {
          trajectory: await ctx.uploadArtifact(path.join(runDir, "trajectory.json"), `explore-run-${job.job_id}-${m.id}.json`).catch(() => undefined),
          sheet: await ctx.uploadArtifact(path.join(runDir, "sheet.html"), `explore-run-${job.job_id}-${m.id}.html`).catch(() => undefined),
        };
        missionLog.push({
          id: m.id, condition: condName, steps: result.stats.steps, ended_by: result.stats.endedBy,
          screens: result.stats.screensThisRun, new_screens: result.stats.newScreensEver, candidates: result.candidates.length,
          misses: result.stats.misses, refused: result.stats.refusedByClass, goal: result.goal, bench: result.bench, answer: result.answer?.slice(0, 300),
          artifacts: runShas,
        });

        if (p.bench) continue;

        // --- confirm and file ---------------------------------------------------
        const picked = pickCandidates(result.candidates, appKey, surface, p.confirm_per_mission ?? 6);
        for (const { c, fp } of picked) {
          if (Date.now() > deadline - 2 * 60_000) break;
          const conf = await confirm(c, result, deps, p.replay_attempts ?? 2);
          await ctx.postBeacon(job.job_id, t.id, { mission: m.id, replayed: c.check }).catch(() => {});
          if (!fileable(conf)) { totals.notReproduced++; continue; }
          if (newFiled >= newCap) { ctx.log(`[${t.id}] finding cap (${newCap}) reached; ${c.title} not filed tonight`); continue; }

          let previously: string | null = null;
          if (previousFile && conf.reproduced > 0) previously = await onPreviousBuild(actuator, conf, result, deps, previousFile);

          const f = await buildFinding(conf, fp, result, runDir, names, { job, t, appKey, condName, previously, mission });
          const posted = await postFinding(f);
          if (posted.error) { ctx.log(`[${t.id}] could not file "${f.title}": ${posted.error}`); continue; }
          totals.findings++;
          if (posted.new) { totals.findingsNew++; newFiled++; }
        }
      }
    } finally {
      map.save();
      mkdirSync(path.dirname(lastRunFile), { recursive: true });
      writeFileSync(lastRunFile, JSON.stringify(lastRun, null, 1));
      await actuator.close().catch(() => {});
    }

    const logFile = path.join(work, `${t.id.replace(/[^\w.-]/g, "_")}-missions.json`);
    writeFileSync(logFile, JSON.stringify(missionLog, null, 1));
    const missionsSha = await ctx.uploadArtifact(logFile, `explore-run-${job.job_id}-${t.id}-missions.json`).catch(() => undefined);
    return {
      ok: totals.missions > 0,
      ...(totals.missions === 0 ? { error: `no mission completed: ${missionLog.map((x) => `${x.id}: ${x.error ?? x.skipped ?? "?"}`).join("; ").slice(0, 400)}` } : {}),
      metrics: {
        explore_missions: totals.missions, explore_steps: totals.steps, explore_actions: totals.actions,
        explore_screens: map.seenThisRun.length, explore_new_screens: missionLog.reduce((a, x) => a + (Number(x.new_screens) || 0), 0),
        explore_candidates: totals.candidates, explore_findings: totals.findings, explore_findings_new: totals.findingsNew,
        explore_not_reproduced: totals.notReproduced, explore_misses: totals.misses, explore_refused: totals.refused,
        explore_step_ms_p50: median(stepMs), explore_model_ms_p50: median(modelMs),
        explore_prompt_tokens_mean: mean(promptTokens), explore_cached_tokens_mean: mean(cachedTokens),
        ...(p.bench ? { explore_bench_passed: totals.benchPassed, explore_bench_total: totals.benchTotal } : {}),
      },
      artifacts: missionsSha ? [missionsSha] : [],
      missions: missionLog,
    };
  }

  /** O6: is this already broken in the previous build? Null when that could not be found out. */
  async function onPreviousBuild(actuator: Actuator, c: Confirmed, r: MissionResult, d: LoopDeps, file: string): Promise<string | null> {
    const prev = await confirm(c, r, { ...d, appFile: file }, 1).catch(() => null);
    // Put the build under test back for whatever runs next.
    await actuator.reset(p.app_id, { file: appFile ?? undefined, launchArgs: r.mission.launch_args }).catch(() => {});
    if (!prev) return null;
    return prev.reproduced > 0 ? "also happens on the previous build" : "new in this build: the previous build does not do this";
  }

  async function buildFinding(
    c: Confirmed, fp: string, r: MissionResult, runDir: string, names: Map<string, string>,
    o: { job: Job; t: Target; appKey: string; condName: string; previously: string | null; mission: Mission },
  ): Promise<ExploreFinding> {
    const dir = path.join(runDir, `finding-${fp.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const words = stepsInWords(r.steps, r.executed, c.upTo, names);
    const flow = toMaestro({
      appId: p.app_id, executed: r.executed, upTo: c.upTo, screen: r.screen, title: c.title,
      setupFlow: o.mission.setup_flow ?? null, launchArgs: o.mission.launch_args,
    });
    writeFileSync(path.join(dir, "replay.yaml"), flow);
    const sheet = trajectorySheet({
      title: c.title, subtitle: `${o.t.id} · ${o.condName} · step ${c.step}`, runDir, steps: r.steps, screenNames: names,
      from: Math.max(1, c.step - 11), to: c.step, highlight: c.step,
    });
    writeFileSync(path.join(dir, "sheet.html"), sheet);
    const up = (f: string, n: string) => ctx.uploadArtifact(f, n).catch(() => undefined);
    const tag = `explore-finding-${fp.slice(0, 12)}`;
    const artifacts: ExploreFinding["artifacts"] = {
      shot: await up(path.join(runDir, "shots", c.shot), `${tag}.png`),
      sheet: await up(path.join(dir, "sheet.html"), `${tag}.html`),
      trajectory: await up(path.join(runDir, "trajectory.json"), `${tag}-trajectory.json`),
      replay: await up(path.join(dir, "replay.yaml"), `${tag}.yaml`),
    };
    if (c.logExcerpt) {
      writeFileSync(path.join(dir, "log.txt"), c.logExcerpt);
      artifacts.log = await up(path.join(dir, "log.txt"), `${tag}.log`);
    }
    const condition = o.condName === "baseline" ? "" : ` Condition: ${o.condName}.`;
    const replayKind: "maestro" | "tvloop" | "none" = o.t.platform === "roku" ? "tvloop" : "maestro";
    return {
      fingerprint: fp,
      app: o.appKey,
      build: o.job.app?.build ?? "installed",
      platform: o.t.platform,
      device_id: o.t.id,
      job_id: o.job.job_id,
      mission_id: o.mission.id,
      check: c.check as CheckName,
      subclass: c.visualClass ?? null,
      severity: c.severity,
      title: c.title.slice(0, 200),
      detail: `${c.detail}${condition}${o.previously ? ` ${o.previously[0].toUpperCase()}${o.previously.slice(1)}.` : ""} Replays: ${c.replayNotes.join("; ")}.`.slice(0, 4000),
      screen: c.screen.id,
      screen_name: c.screen.name,
      steps: words,
      replay: (c.check === "crash" || c.check === "anr") && c.reproduced === 0
        ? null
        : { kind: replayKind, sha256: artifacts.replay ?? null, attempts: c.attempts, reproduced: c.reproduced },
      artifacts,
    };
  }

  async function rokuPassword(t: Target): Promise<string | undefined> {
    if (t.platform !== "roku") return undefined;
    const r = await ctx.secrets.rokuDevPassword();
    return r.ok ? r.password : undefined;
  }
}

export { run_ as run };
export { replayThrough };
