// The Screen Atlas without a device: recipe checks, naming, the index, the
// diff's five answers, a walk run as a plain command, and the workload's
// refusals against a fake context.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { capturePlatform, diffVersions, loadRecipe, nameShot, normalizeShots, readIndex, storeAtlas, writeIndex, type AtlasRecipe } from "../../atlas.js";
import type { Job, Target, WorkloadCtx } from "../types.js";
import { run } from "./index.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

function png(file: string, w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const [r, g, b] = paint(x, y);
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(p));
}

const RECIPE: AtlasRecipe = {
  schema: 1,
  app: "demo",
  platforms: {
    ios: {
      command: ["sh", "-c", "true"],
      pattern: "^(?<screen>.+)-(?<state>dayone|full)-(?<variant>light|dark|lightAX5)-(?<device>[^-]+)\\.png$",
      screen: "{screen}.{state}",
      variants: { light: "light", dark: "dark", lightAX5: "light-ax5" },
    },
  },
};

async function rejects(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try { await p; return false; } catch (e) { return re.test((e as Error).message); }
}

export async function runAtlasChecks(check: Check): Promise<void> {
  console.log("\natlas (no device)");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "atlas-test-"));

  const bad = path.join(tmp, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...RECIPE, platforms: { ios: { ...RECIPE.platforms.ios, pattern: "^(.+)\\.png$" } } }));
  check("a recipe whose pattern names no screen and variant is refused", await rejects(Promise.resolve().then(() => loadRecipe(bad)), /named groups/));
  const good = path.join(tmp, "atlas.json");
  writeFileSync(good, JSON.stringify(RECIPE));
  check("a good recipe loads", loadRecipe(good).app === "demo");

  const pr = RECIPE.platforms.ios;
  const n = nameShot("trends-sleep-full-lightAX5-sim.png", pr);
  check("a walk's file name becomes screen and variant", n?.screen === "trends-sleep.full" && n?.variant === "light-ax5", JSON.stringify(n));
  check("a failure shot is not named", nameShot("failure-testFull-1763840000.png", pr) === null);
  check("an unlisted variant is not named", nameShot("today-full-sepia-sim.png", pr) === null);
  check("camelCase screens are dashed", nameShot("questionsStreams-full-dark-sim.png", pr)?.screen === "questions-streams.full");

  // Version 1: three screens. Version 2: one the same, one changed, one resized, one new; one gone.
  const w1 = path.join(tmp, "walk1");
  const flat = () => [200, 200, 200] as [number, number, number];
  png(path.join(w1, "today-full-light-sim.png"), 20, 40, flat);
  png(path.join(w1, "trends-full-light-sim.png"), 20, 40, flat);
  png(path.join(w1, "spaces-full-dark-sim.png"), 20, 40, flat);
  png(path.join(w1, "lab-full-light-sim.png"), 20, 40, flat);
  png(path.join(w1, "failure-x-1.png"), 4, 4, flat);
  const root = path.join(tmp, "atlas");
  const v1 = path.join(root, "demo", "1.0.0");
  const a = normalizeShots(w1, v1, "ios", pr);
  check("normalize files every named shot and lists the rest", a.entries.length === 4 && a.leftOut.length === 1, JSON.stringify(a.leftOut));
  check("shots land under <platform>/<screen>__<variant>.png", existsSync(path.join(v1, "ios", "today.full__light.png")));
  const i1 = writeIndex(v1, { app: "demo", version: "1.0.0", commit: "abc", platform: "ios", entries: a.entries,
    meta: { device: "SIM", captured_at: "2026-11-22T00:00:00Z", capture_s: 60, left_out: a.leftOut } });
  check("the index counts shots and screens", i1.counts.shots === 4 && i1.platforms.ios.screens === 4);
  check("an entry carries the kit's captures.json fields", ["file", "sha256", "size", "kind", "platform"].every((k) => k in i1.files[0]));
  check("the index has a browsable page", readFileSync(path.join(v1, "index.html"), "utf8").includes("today.full"));
  // A second platform merges into the same index.
  writeIndex(v1, { app: "demo", version: "1.0.0", commit: null, platform: "android", entries: [],
    meta: { device: "emu", captured_at: "2026-11-22T00:00:00Z", capture_s: 1, left_out: [] } });
  check("another platform's capture keeps iOS's shots", readIndex(v1)?.counts.shots === 4 && readIndex(v1)?.commit === "abc");

  const w2 = path.join(tmp, "walk2");
  png(path.join(w2, "today-full-light-sim.png"), 20, 40, flat);
  png(path.join(w2, "trends-full-light-sim.png"), 20, 40, (x, y) => (y < 10 ? [0, 0, 0] : [200, 200, 200]));
  png(path.join(w2, "spaces-full-dark-sim.png"), 20, 60, flat);
  png(path.join(w2, "settings-full-light-sim.png"), 20, 40, flat);
  const v2 = path.join(root, "demo", "1.0.1");
  const b = normalizeShots(w2, v2, "ios", pr);
  writeIndex(v2, { app: "demo", version: "1.0.1", commit: "def", platform: "ios", entries: b.entries,
    meta: { device: "SIM", captured_at: "2026-11-22T00:00:00Z", capture_s: 60, left_out: [] } });
  const out = path.join(v2, "diff-from-1.0.0");
  const d = diffVersions(v1, v2, out);
  const st = (s: string) => d.rows.find((r) => r.screen === s)?.status;
  check("identical bytes are the same", st("today.full") === "same");
  check("a quarter of the pixels changed is changed", st("trends.full") === "changed" && d.rows.find((r) => r.screen === "trends.full")?.diff_pct === 25);
  check("a taller shot is resized", st("spaces.full") === "resized");
  check("a shot only in the newer version is new", st("settings.full") === "new");
  check("a shot only in the older version is gone", st("lab.full") === "gone");
  check("the changed shot has a diff image", existsSync(path.join(out, "diff", "ios__trends.full__light.png")));
  const dj = JSON.parse(readFileSync(path.join(out, "diff.json"), "utf8"));
  check("diff.json's paths are relative to the report", dj.rows.every((r: { a: string | null }) => !r.a || !path.isAbsolute(r.a)));
  check("the report lists what changed", readFileSync(path.join(out, "report.html"), "utf8").includes("1 changed, 1 resized, 1 new, 1 gone, 1 the same"));

  // A walk run as a command: the recipe's command writes into $SHOTS.
  const walker = path.join(tmp, "walk.sh");
  writeFileSync(walker, `#!/bin/sh\ncp "${w1}/today-full-light-sim.png" "$SHOTS/today-full-light-$DEV.png"\necho walked\n`, { mode: 0o755 });
  const lines: string[] = [];
  const cap = await capturePlatform({
    recipe: { ...RECIPE, platforms: { ios: { ...pr, command: [walker], env: { DEV: "{udid}" } } } },
    platform: "ios", checkout: tmp, root, version: "1.0.2", device: "sim", work: path.join(tmp, "work"), log: (l) => lines.push(l),
  });
  check("a walk's shots are filed with its exit code and time", cap.exit === 0 && cap.entries.length === 1 && lines.includes("walked"), JSON.stringify(cap.entries));

  const store = path.join(tmp, "nas");
  const s = await storeAtlas(v2, "demo", "1.0.1", store, path.join(tmp, "catalog"));
  check("store copies and verifies every shot", s.verified === 4 && existsSync(path.join(store, "demo", "1.0.1", "ios", "today.full__light.png")));
  check("store puts the index (and the diff) beside the lake", existsSync(path.join(tmp, "catalog", "demo", "1.0.1", "index.json")) &&
    existsSync(path.join(tmp, "catalog", "demo", "1.0.1", "diff-from-1.0.0.json")));

  // The workload's refusals.
  const sim: Target = { id: "SIM-1", platform: "ios", kind: "simulator", driver: "simctl" };
  const ctx = {
    host: "test-host", log: () => {}, postResult: async () => {}, postBeacon: async () => {},
    fetchArtifact: async () => {}, uploadArtifact: async () => "0".repeat(64),
    listTargets: async () => [sim], selectTargets: async (_j: Job, all: Target[]) => all, leaseBudgetS: () => 600,
    locks: { acquire: async (_j: string, ids: string[]) => new Set(ids), release: async () => {} },
    secrets: {} as WorkloadCtx["secrets"],
  } as WorkloadCtx;
  const job = (params: Record<string, unknown>) => ({ job_id: "atlas-1", workload: "atlas", executor: "host", params }) as unknown as Job;
  check("no checkout is refused", await rejects(run(job({ version: "1" }), ctx), /params\.checkout/));
  check("no version is refused", await rejects(run(job({ checkout: tmp }), ctx), /params\.version/));
  check("a version that is a path is refused", await rejects(run(job({ checkout: tmp, version: "../x" }), ctx), /version/));
  check("a platform the recipe lacks is refused by name", await rejects(run(job({ checkout: tmp, version: "1", platform: "android" }), ctx), /no platform android/));
}
