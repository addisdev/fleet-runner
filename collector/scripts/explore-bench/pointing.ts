// B1, the pointing test: can the model put a tap on a named control, on OUR
// screens?
//
// The vendor's grounding scores are measured on the vendor's screenshots. This
// builds targets from the fleet's own UI trees -- every explore run saves the
// tree beside each screenshot -- so "Tap Add Plant" comes with the button's
// real bounds and needs no hand labelling. A hit is a point inside the bounds.
//
//   npx tsx scripts/explore-bench/pointing.ts --from <dir> [--from <dir>...] \
//     --base-url http://127.0.0.1:8091 --model qwen3.5-2b [--n 200] [--out report.json]
//
//   --capture --device <serial> --out <dir> --name <screen>
//     saves the current screen and tree, for building a set by hand.
//
// <dir> is searched recursively for NNN.png with NNN.nodes.json beside it, or
// NNN.png with NNN.xml (a raw uiautomator dump).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseUiautomatorDump, type A11yNode } from "../../src/a11y-tree.js";
import { pngSize } from "../../src/workloads/explore/actuators/android.js";
import { shrinkForModel } from "../../src/workloads/explore/image.js";
import { convertCall, parseInlineCalls, parseToolCalls, toolsFor } from "../../src/workloads/explore/model.js";

const run = promisify(execFile);

type Target = { shot: string; label: string; kind: string; bounds: { x: number; y: number; w: number; h: number }; w: number; h: number };
export type PointingResult = { model: string; n: number; hits: number; rate: number; medianMs: number; medianMissPx: number | null; rows: { shot: string; label: string; hit: boolean; ms: number; dist: number | null; error?: string }[] };

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const all = (k: string) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  return { get, all, has: (k: string) => a.includes(k) };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/^\d+\.png$|^[\w-]+\.png$/.test(e)) out.push(f);
  }
  return out;
}

function treeFor(png: string): A11yNode[] | null {
  const j = png.replace(/\.png$/, ".nodes.json"), x = png.replace(/\.png$/, ".xml");
  if (existsSync(j)) return JSON.parse(readFileSync(j, "utf8")) as A11yNode[];
  if (existsSync(x)) return parseUiautomatorDump(readFileSync(x, "utf8")).nodes;
  return null;
}

/**
 * Targets from one screen: tappable, enabled, labelled, uniquely named on
 * that screen, and a sensible size. A label that appears twice cannot be
 * scored ("tap Delete" -- which one?), so it is skipped.
 */
export function targetsFrom(shot: string, nodes: A11yNode[], w: number, h: number): Target[] {
  const named = nodes.filter((n) => n.tappable && n.enabled && n.bounds && n.bounds.w >= 8 && n.bounds.h >= 8
    && n.bounds.w * n.bounds.h < w * h * 0.25)
    .map((n) => ({ n, label: (n.label || n.text).trim() }))
    .filter((x) => x.label.length >= 2 && x.label.length <= 40);
  // A tappable container often has no label while its child Text does.
  for (const n of nodes) {
    if (!n.tappable || !n.bounds || (n.label || n.text).trim()) continue;
    const child = nodes.find((c) => c !== n && c.bounds && (c.text || c.label).trim()
      && c.bounds.x >= n.bounds!.x && c.bounds.y >= n.bounds!.y && c.bounds.x + c.bounds.w <= n.bounds!.x + n.bounds!.w && c.bounds.y + c.bounds.h <= n.bounds!.y + n.bounds!.h);
    if (child && n.bounds.w * n.bounds.h < w * h * 0.25) named.push({ n, label: (child.text || child.label).trim() });
  }
  const counts = new Map<string, number>();
  for (const x of named) counts.set(x.label.toLowerCase(), (counts.get(x.label.toLowerCase()) ?? 0) + 1);
  const seen = new Set<string>();
  return named.filter((x) => counts.get(x.label.toLowerCase()) === 1 && !seen.has(x.label) && seen.add(x.label))
    .map((x) => ({ shot, label: x.label, kind: (x.n.cls.split(".").pop() ?? "control").replace(/^XCUIElementType/, ""), bounds: x.n.bounds!, w, h }));
}

/** Spread the sample across screens instead of taking the first screen's twenty buttons. */
export function sample(ts: Target[], n: number): Target[] {
  const byShot = new Map<string, Target[]>();
  for (const t of ts) byShot.set(t.shot, [...(byShot.get(t.shot) ?? []), t]);
  const out: Target[] = [];
  const lists = [...byShot.values()];
  for (let round = 0; out.length < n && lists.some((l) => l.length > round); round++) {
    for (const l of lists) if (l[round] && out.length < n) out.push(l[round]);
  }
  return out;
}

export async function scorePointing(targets: Target[], cfg: { baseUrl: string; model: string; apiKey?: string; maxPixels?: number; extraBody?: Record<string, unknown> }): Promise<PointingResult> {
  const caps = { surface: "touch" as const, keys: [] as const, tree: true, foreground: true };
  const tools = toolsFor({ ...caps, keys: [] }).filter((t) => t.function.name === "mobile_click");
  const rows: PointingResult["rows"] = [];
  for (const t of targets) {
    const png = readFileSync(t.shot);
    const img = shrinkForModel(png, cfg.maxPixels ?? 1_000_000);
    const t0 = Date.now();
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model, temperature: 0, max_tokens: 400, tools, tool_choice: "auto",
          messages: [
            { role: "system", content: "You control a phone by touch. Pointer coordinates are on a 0-1000 scale on both axes: x 0 is the left edge, 1000 the right; y 0 is the top, 1000 the bottom. Answer with one mobile_click call." },
            { role: "user", content: [
              { type: "text", text: `Tap the "${t.label}" ${t.kind.toLowerCase()}.` },
              { type: "image_url", image_url: { url: `data:image/png;base64,${img.png.toString("base64")}` } },
            ] },
          ],
          ...(cfg.extraBody ?? {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = await res.json() as { choices?: { message?: { tool_calls?: unknown; content?: string } }[] };
      const msg = body.choices?.[0]?.message ?? {};
      let calls = parseToolCalls(msg.tool_calls);
      if (!calls.length) calls = parseInlineCalls(msg.content ?? "");
      const conv = calls.length ? convertCall(calls[0], t.w, t.h, { ...caps, keys: [] }) : [];
      const a = conv[0]?.kind === "action" ? conv[0].action : null;
      const ms = Date.now() - t0;
      if (!a || a.kind !== "tap") { rows.push({ shot: t.shot, label: t.label, hit: false, ms, dist: null, error: "no tap" }); continue; }
      const b = t.bounds, pad = 4;
      const hit = a.x >= b.x - pad && a.x <= b.x + b.w + pad && a.y >= b.y - pad && a.y <= b.y + b.h + pad;
      const dx = Math.max(b.x - a.x, 0, a.x - (b.x + b.w)), dy = Math.max(b.y - a.y, 0, a.y - (b.y + b.h));
      rows.push({ shot: t.shot, label: t.label, hit, ms, dist: hit ? 0 : Math.round(Math.hypot(dx, dy)) });
    } catch (e) {
      rows.push({ shot: t.shot, label: t.label, hit: false, ms: Date.now() - t0, dist: null, error: (e as Error).message.slice(0, 120) });
    }
    process.stderr.write(rows[rows.length - 1].hit ? "." : "x");
  }
  process.stderr.write("\n");
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const misses = rows.filter((r) => !r.hit && r.dist !== null).map((r) => r.dist!);
  const hits = rows.filter((r) => r.hit).length;
  return { model: cfg.model, n: rows.length, hits, rate: rows.length ? Math.round((hits / rows.length) * 1000) / 10 : 0, medianMs: med(rows.map((r) => r.ms)), medianMissPx: misses.length ? med(misses) : null, rows };
}

export function collectTargets(dirs: string[], n: number): Target[] {
  const all: Target[] = [];
  for (const d of dirs) {
    for (const shot of walk(d)) {
      const nodes = treeFor(shot);
      const size = pngSize(readFileSync(shot));
      if (!nodes || !size) continue;
      all.push(...targetsFrom(shot, nodes, size.width, size.height));
    }
  }
  return sample(all, n);
}

async function capture(device: string, out: string, name: string) {
  mkdirSync(out, { recursive: true });
  const shot = (await promisify(execFile)("adb", ["-s", device, "exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 64 << 20 } as never)) as unknown as { stdout: Buffer };
  writeFileSync(path.join(out, `${name}.png`), shot.stdout);
  await run("adb", ["-s", device, "shell", "uiautomator", "dump", "/sdcard/b1.xml"]);
  const { stdout } = await run("adb", ["-s", device, "shell", "cat", "/sdcard/b1.xml"], { maxBuffer: 32 << 20 });
  writeFileSync(path.join(out, `${name}.xml`), stdout);
  console.log(`saved ${name}.png and ${name}.xml in ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = args();
  if (a.has("--capture")) {
    await capture(a.get("--device")!, a.get("--out")!, a.get("--name") ?? `screen-${Date.now()}`);
  } else {
    const targets = collectTargets(a.all("--from"), Number(a.get("--n") ?? 200));
    if (!targets.length) { console.error("no targets: point --from at explore run directories or captured screens"); process.exit(1); }
    console.error(`${targets.length} targets from ${new Set(targets.map((t) => t.shot)).size} screens`);
    const r = await scorePointing(targets, {
      baseUrl: a.get("--base-url") ?? process.env.FLEET_EXPLORE_BASE_URL ?? "http://127.0.0.1:8091",
      model: a.get("--model") ?? "pilot", apiKey: process.env.FLEET_EXPLORE_API_KEY,
      maxPixels: a.get("--max-pixels") ? Number(a.get("--max-pixels")) : undefined,
      extraBody: a.get("--extra-body") ? JSON.parse(a.get("--extra-body")!) : undefined,
    });
    console.log(`${r.model}: ${r.hits}/${r.n} hits (${r.rate}%), median ${r.medianMs} ms, median miss ${r.medianMissPx ?? "-"} px`);
    if (a.get("--out")) writeFileSync(a.get("--out")!, JSON.stringify(r, null, 1));
  }
}
