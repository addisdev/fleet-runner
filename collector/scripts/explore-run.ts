// Run explore missions straight against a device, with no collector.
//
// The workload proper is a fleet job: it claims a lease, beacons, uploads
// artifacts and posts findings. This is the same loop for a person at a desk
// (and for the bake-off): pick a device, a model and some cards, and get the
// run directories and a summary on disk. Nothing is posted anywhere.
//
//   npx tsx scripts/explore-run.ts --device emulator-5554 --app-id dev.fleetrunner.buggarden \
//     --app-key bug-garden --base-url http://127.0.0.1:8091 --model qwen3.5-2b \
//     [--bench] [--missions a,b] [--steps 30] [--judge-model m | --no-judge] [--tree-hints] \
//     [--apk path] [--confirm] [--out dir]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Target } from "../src/workloads/types.js";
import { actuatorFor } from "../src/workloads/explore/actuators/index.js";
import { confirm, runMission, type LoopDeps } from "../src/workloads/explore/loop.js";
import { loadMissions, orderMissions } from "../src/workloads/explore/missions.js";
import type { ModelConfig } from "../src/workloads/explore/model.js";
import { pickCandidates, fileable } from "../src/workloads/explore/index.js";
import { ScreenMap } from "../src/workloads/explore/screenmap.js";

export type RunSummary = {
  model: string; device: string; app: string; bench: boolean; started: string; minutes: number;
  missions: { id: string; steps: number; endedBy: string; bench: { passed: boolean; detail: string } | null; candidates: number; filed: number; modelMsP50: number | null; error?: string; dir: string }[];
  benchPassed: number; benchTotal: number;
};

export async function exploreRun(o: {
  device: string; platform?: string; appId: string; appKey: string; appName?: string; model: ModelConfig; judge: ModelConfig | null;
  missionsDir?: string; only?: string[]; bench?: boolean; steps?: number; apk?: string | null; confirm?: boolean; out: string;
  surface?: "touch" | "dpad"; driver?: string; kind?: "device" | "simulator";
}): Promise<RunSummary> {
  const t: Target = { id: o.device, platform: o.platform ?? "android", kind: o.kind ?? (o.device.startsWith("emulator-") ? "simulator" : "device"), driver: o.driver ?? "adb" };
  const actuator = await actuatorFor(t, { surface: o.surface, log: (m) => console.error(`  [${t.id}] ${m}`) });
  const cards = loadMissions(o.appKey, o.missionsDir, (m) => console.error(`  card problem: ${m}`));
  const missions = orderMissions(cards, { surface: actuator.caps.surface, only: o.only, bench: o.bench });
  const map = new ScreenMap(`${o.appKey}${o.bench ? "-bench" : ""}`);
  const started = Date.now();
  const summary: RunSummary = { model: o.model.model, device: o.device, app: o.appKey, bench: !!o.bench, started: new Date().toISOString(), minutes: 0, missions: [], benchPassed: 0, benchTotal: 0 };
  let first = true;
  for (const m0 of missions) {
    const m = o.steps ? { ...m0, budget: { ...(m0.budget ?? {}), steps: o.steps } } : m0;
    const runDir = path.join(o.out, m.id);
    mkdirSync(runDir, { recursive: true });
    const deps: LoopDeps = {
      actuator, appId: o.appId, appName: o.appName ?? o.appKey, appFile: first ? o.apk ?? null : null,
      model: o.model, judge: o.judge, map, runDir, night: `local-${started}`, log: (x) => console.error(`  ${x}`),
      canRunFlows: t.platform === "android" || t.kind === "simulator", deadline: Date.now() + 6 * 3600_000,
      onStep: async (s) => { process.stderr.write(`  ${m.id} step ${s.i}: ${s.calls.map((c) => c.name).join("+") || "-"} ${(s.model.ms / 1000).toFixed(1)}s${s.checks.length ? ` [${s.checks.map((c) => c.check).join(",")}]` : ""}${s.refused.length ? " (refused)" : ""}\n`); },
    };
    first = false;
    try {
      const r = await runMission(m, deps);
      let filed = 0;
      const confirmed: Record<string, unknown>[] = [];
      if (o.confirm && !o.bench) {
        for (const { c, fp } of pickCandidates(r.candidates, o.appKey, actuator.caps.surface, 6)) {
          const cf = await confirm(c, r, deps, 2);
          const ok = fileable(cf);
          if (ok) filed++;
          // The shape a finding has when posted, enough for the garden scorer.
          confirmed.push({ fingerprint: fp, check: c.check, subclass: c.visualClass ?? null, title: c.title, detail: c.detail,
            screen: c.screen.id, screen_name: c.screen.name, shot: `shots/${c.shot}`, step: c.step,
            attempts: cf.attempts, reproduced: cf.reproduced, filed: ok, replay_notes: cf.replayNotes });
          console.error(`  candidate ${c.check} "${c.title}": ${cf.replayNotes.join("; ")}`);
        }
      }
      writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
        ...r, candidates: r.candidates.map(({ screen, ...c }) => ({ ...c, screen: screen.name })), confirmed,
      }, null, 1));
      const ms = [...r.stats.modelMs].sort((a, b) => a - b);
      summary.missions.push({ id: m.id, steps: r.stats.steps, endedBy: r.stats.endedBy, bench: r.bench, candidates: r.candidates.length, filed, modelMsP50: ms.length ? ms[Math.floor(ms.length / 2)] : null, dir: runDir });
      if (r.bench) { summary.benchTotal++; if (r.bench.passed) summary.benchPassed++; }
      console.error(`  ${m.id}: ${r.stats.steps} steps, ended by ${r.stats.endedBy}${r.bench ? `, bench ${r.bench.passed ? "PASS" : "fail"} (${r.bench.detail})` : ""}, ${r.candidates.length} candidates`);
    } catch (e) {
      summary.missions.push({ id: m.id, steps: 0, endedBy: "error", bench: null, candidates: 0, filed: 0, modelMsP50: null, error: (e as Error).message, dir: runDir });
      if (o.bench) summary.benchTotal++;
      console.error(`  ${m.id} failed: ${(e as Error).message}`);
    }
  }
  map.save();
  await actuator.close();
  summary.minutes = Math.round((Date.now() - started) / 600) / 100;
  writeFileSync(path.join(o.out, "summary.json"), JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const has = (k: string) => a.includes(k);
  const baseUrl = get("--base-url") ?? process.env.FLEET_EXPLORE_BASE_URL ?? "http://127.0.0.1:8091";
  const extraBody = get("--extra-body") ? JSON.parse(get("--extra-body")!) as Record<string, unknown> : undefined;
  const model: ModelConfig = { baseUrl, model: get("--model") ?? "pilot", apiKey: process.env.FLEET_EXPLORE_API_KEY, treeHints: has("--tree-hints"), extraBody };
  const judge: ModelConfig | null = has("--no-judge") || has("--bench") ? null
    : { baseUrl: get("--judge-base-url") ?? baseUrl, model: get("--judge-model") ?? model.model, apiKey: process.env.FLEET_EXPLORE_API_KEY, extraBody };
  const out = get("--out") ?? mkdtempSync(path.join(os.tmpdir(), "explore-run-"));
  const s = await exploreRun({
    device: get("--device")!, appId: get("--app-id")!, appKey: get("--app-key") ?? get("--app-id")!.split(".").pop()!, appName: get("--app-name"),
    model, judge, missionsDir: get("--missions-dir"), only: get("--missions")?.split(","), bench: has("--bench"),
    steps: get("--steps") ? Number(get("--steps")) : undefined, apk: get("--apk") ?? null, confirm: has("--confirm"), out,
    surface: get("--surface") as "touch" | "dpad" | undefined,
  });
  console.log(JSON.stringify({ out, ...s }, null, 1));
}
