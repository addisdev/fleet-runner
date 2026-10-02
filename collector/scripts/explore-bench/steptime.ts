// B2, step time: how long one step of a real mission takes on a given server,
// and whether the prefix cache is doing its job.
//
// A step's prompt is the whole conversation so far -- system prompt, mission,
// every earlier turn, the last three screenshots -- around 16,000 tokens by
// the middle of a mission in the vendor's own Android runs. If the server
// reuses the shared prefix, each step pays only for what is new; if it does
// not (the vendor's docs say llama.cpp on Apple silicon lacks prefix caching
// for Holo4's architecture), each step pays for everything again and step time
// climbs with the mission. This replays a growing conversation with real
// screenshots and real model replies, and prints both curves.
//
//   npx tsx scripts/explore-bench/steptime.ts --base-url http://ultra.local:4000 \
//     --model pilot --shots <dir of PNGs> [--n 50] [--out steptime.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Conversation, systemPrompt, type ModelConfig } from "../../src/workloads/explore/model.js";
import { pngSize } from "../../src/workloads/explore/actuators/android.js";
import type { Observation } from "../../src/workloads/explore/types.js";

export type StepTime = { step: number; ms: number; promptTokens: number | null; cachedTokens: number | null; calls: number; error?: string };

export async function measureSteps(cfg: ModelConfig, shots: string[], n: number, onStep?: (s: StepTime) => void): Promise<StepTime[]> {
  const caps = { surface: "touch" as const, keys: ["back", "home", "enter"] as const, tree: false, foreground: true };
  const conv = new Conversation(cfg, systemPrompt({ platform: "android", caps: { ...caps, keys: [...caps.keys] }, appName: "the app" }),
    "Mission: Look around\nPersona: a new user\nGoal: visit every screen you can find and report anything broken.", { ...caps, keys: [...caps.keys] });
  const out: StepTime[] = [];
  let results: string[] = [];
  for (let i = 0; i < n; i++) {
    const png = readFileSync(shots[i % shots.length]);
    const size = pngSize(png)!;
    const obs: Observation = { png, width: size.width, height: size.height, nodes: null, treeSource: null, foreground: null, focus: null, keyboard: null };
    const t = await conv.next(obs, results, [`Step ${i + 1} of ${n}.`]);
    // Every call is answered "ok": the point is the conversation's growth, not the device.
    results = t.calls.map(() => "ok");
    const s: StepTime = { step: i + 1, ms: t.ms, promptTokens: t.usage.promptTokens, cachedTokens: t.usage.cachedTokens, calls: t.calls.length, ...(t.error ? { error: t.error } : {}) };
    out.push(s);
    onStep?.(s);
  }
  return out;
}

export function summarise(rows: StepTime[]) {
  const ok = rows.filter((r) => !r.error);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
  const first = ok[0]?.ms ?? null;
  const late = ok.slice(-Math.max(1, Math.floor(ok.length / 4)));
  const early = ok.slice(1, 1 + Math.max(1, Math.floor(ok.length / 4)));
  const avg = (xs: StepTime[]) => (xs.length ? Math.round(xs.reduce((a, r) => a + r.ms, 0) / xs.length) : null);
  const cached = ok.filter((r) => (r.cachedTokens ?? 0) > 0).length;
  return {
    steps: rows.length, errors: rows.length - ok.length, first_ms: first, p50_ms: q(0.5), p90_ms: q(0.9),
    early_mean_ms: avg(early), late_mean_ms: avg(late),
    prompt_tokens_last: ok[ok.length - 1]?.promptTokens ?? null,
    steps_with_cache_hits: cached,
    // Growth by more than half from the early quarter to the late quarter,
    // with no cached tokens reported, is the signature of no prefix reuse.
    prefix_cache: cached > 0 ? "reported" : (avg(late) ?? 0) > 1.5 * (avg(early) ?? Infinity) ? "absent (step time grows with history)" : "unreported",
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dir = get("--shots");
  if (!dir) { console.error("--shots <dir of PNGs> is required"); process.exit(1); }
  const shots = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f));
  const cfg: ModelConfig = {
    baseUrl: get("--base-url") ?? process.env.FLEET_EXPLORE_BASE_URL ?? "http://127.0.0.1:8091",
    model: get("--model") ?? "pilot", apiKey: process.env.FLEET_EXPLORE_API_KEY,
    maxPixels: get("--max-pixels") ? Number(get("--max-pixels")) : undefined,
    extraBody: get("--extra-body") ? JSON.parse(get("--extra-body")!) : undefined,
  };
  const rows = await measureSteps(cfg, shots, Number(get("--n") ?? 50), (s) =>
    console.error(`step ${s.step}: ${(s.ms / 1000).toFixed(1)} s, prompt ${s.promptTokens ?? "?"} tok, cached ${s.cachedTokens ?? "?"}${s.error ? ` (${s.error.slice(0, 80)})` : ""}`));
  const sum = summarise(rows);
  console.log(JSON.stringify(sum, null, 1));
  if (get("--out")) writeFileSync(get("--out")!, JSON.stringify({ model: cfg.model, summary: sum, rows }, null, 1));
}
