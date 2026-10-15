// B5, the bake-off: the same pointing targets, the same step-time replay and
// the same bench missions for every model in a list, one table at the end.
//
// The plan's comparison is Holo4 35B-A3B at 4-bit and 6-bit against plain
// Qwen3.8-27B and GUI-Owl-1.5, with one small cloud sample as the ceiling. On
// ultra those are gateway names and the list is just names. On a laptop the
// models do not fit side by side, so an entry may say how to serve it and the
// bake-off starts llama-server for it, measures, and stops it before the next.
//
//   npx tsx scripts/explore-bench/bakeoff.ts --config models.json --from <runs dir> \
//     [--device emulator-5554 --app-id dev.fleetrunner.buggarden --app-key bug-garden] \
//     [--n 60] [--steps-n 15] [--out bakeoff/]
//
// models.json:
//   [{ "name": "holo4-35b-4bit", "base_url": "http://ultra.local:4000", "model": "pilot" },
//    { "name": "qwen3.5-2b", "model": "qwen3.5-2b", "tree_hints": true,
//      "serve": { "model": "~/models/gguf/Qwen3.5-2B-Q4_K_M.gguf", "mmproj": "~/models/gguf/Qwen3.5-2B-mmproj-F16.gguf", "port": 8091 } }]
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectTargets, scorePointing } from "./pointing.js";
import { measureSteps, summarise } from "./steptime.js";
import { exploreRun } from "../explore-run.js";

type Entry = {
  name: string; base_url?: string; model?: string; tree_hints?: boolean; extra_body?: Record<string, unknown>; max_pixels?: number;
  serve?: { model: string; mmproj?: string; port?: number; ctx?: number; args?: string[] };
};

const home = (p: string) => p.replace(/^~(?=\/)/, os.homedir());

async function serve(e: Entry): Promise<{ proc: ChildProcess; url: string } | null> {
  if (!e.serve) return null;
  const port = e.serve.port ?? 8091;
  const args = ["-m", home(e.serve.model), ...(e.serve.mmproj ? ["--mmproj", home(e.serve.mmproj)] : []),
    "--jinja", "-c", String(e.serve.ctx ?? 16384), "-np", "1", "--port", String(port), "--host", "127.0.0.1", "-ngl", "99",
    "--alias", e.model ?? e.name, ...(e.serve.args ?? [])];
  const proc = spawn("llama-server", args, { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return { proc, url }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  proc.kill();
  throw new Error(`llama-server for ${e.name} did not come up on ${url}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const all = (k: string) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  const entries = JSON.parse(readFileSync(get("--config")!, "utf8")) as Entry[];
  const out = get("--out") ?? path.join(os.tmpdir(), `bakeoff-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const targets = all("--from").length ? collectTargets(all("--from"), Number(get("--n") ?? 60)) : [];
  const shotsDir = all("--from")[0];
  const shots = shotsDir ? findPngs(shotsDir).slice(0, 20) : [];
  const rows: Record<string, unknown>[] = [];

  for (const e of entries) {
    console.error(`\n== ${e.name}`);
    let served: Awaited<ReturnType<typeof serve>> = null;
    try {
      served = await serve(e);
      const cfg = { baseUrl: served?.url ?? e.base_url ?? "http://127.0.0.1:8091", model: e.model ?? e.name, apiKey: process.env.FLEET_EXPLORE_API_KEY, treeHints: e.tree_hints, extraBody: e.extra_body, maxPixels: e.max_pixels };
      const row: Record<string, unknown> = { model: e.name };
      if (targets.length) {
        const p = await scorePointing(targets, cfg);
        Object.assign(row, { pointing_pct: p.rate, pointing_n: p.n, pointing_ms_p50: p.medianMs, miss_px_p50: p.medianMissPx });
        writeFileSync(path.join(out, `${e.name}-pointing.json`), JSON.stringify(p, null, 1));
      }
      if (shots.length) {
        const st = summarise(await measureSteps(cfg, shots, Number(get("--steps-n") ?? 15)));
        Object.assign(row, { step_ms_p50: st.p50_ms, step_ms_early: st.early_mean_ms, step_ms_late: st.late_mean_ms, prompt_tokens_last: st.prompt_tokens_last, prefix_cache: st.prefix_cache });
      }
      if (get("--device")) {
        const s = await exploreRun({
          device: get("--device")!, appId: get("--app-id")!, appKey: get("--app-key")!, model: cfg, judge: null,
          bench: true, out: path.join(out, `${e.name}-bench`), missionsDir: get("--missions-dir"),
          only: get("--missions")?.split(","),
        });
        Object.assign(row, { bench_passed: s.benchPassed, bench_total: s.benchTotal, bench_minutes: s.minutes });
      }
      rows.push(row);
      console.error(JSON.stringify(row));
    } catch (err) {
      rows.push({ model: e.name, error: (err as Error).message });
    } finally {
      served?.proc.kill();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  writeFileSync(path.join(out, "bakeoff.json"), JSON.stringify(rows, null, 1));
  const cols = ["model", "pointing_pct", "pointing_ms_p50", "miss_px_p50", "step_ms_p50", "step_ms_early", "step_ms_late", "prefix_cache", "bench_passed", "bench_total", "error"];
  const md = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`)].join("\n");
  writeFileSync(path.join(out, "bakeoff.md"), `${md}\n`);
  console.log(md);
  console.log(`\n${out}`);
}

function findPngs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (/^\d+\.png$/.test(e.name)) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}
