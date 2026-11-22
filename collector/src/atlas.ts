/**
 * Screen Atlas: every screen of an app, captured once per version, kept as one
 * browsable set.
 *
 * A capture is the app's own screen walk (each app already has one: a UI test
 * that visits every screen in light, dark and the largest text size). The app
 * says how to run it and how its file names read in a recipe, `atlas.json`, in
 * its own repository; this module only normalises what the walk wrote:
 *
 *   <root>/<app>/<version>/<platform>/<screen>__<variant>.png
 *   <root>/<app>/<version>/index.json      every shot: sha256, size, pixels
 *   <root>/<app>/<version>/index.html      one row per screen, one column per variant
 *
 * and compares two versions (`diffVersions`): a pixel diff per screen and
 * variant, with a threshold, written as `diff.json` and a `report.html`.
 *
 * One capture serves several jobs that are done separately today: the PR's
 * `Lab:` line cites a version's index, store screenshots and promo frames are
 * picked from it by name (the index's entries carry the same fields as the
 * launch kit's `captures.json`), and the largest-text variant is the overflow
 * check.
 *
 * Pure except for the file system and, in `storeAtlas`, rsync and ssh: no
 * device is touched here. The workload (workloads/atlas) and the command
 * (scripts/atlas.ts) run the walk.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { contactSheetHtml, type SheetShot } from "./contact-sheet.js";

/** How one platform's walk is run and how its file names read. */
export type AtlasPlatformRecipe = {
  /** argv, run with the app checkout as the working directory. */
  command: string[];
  /** Extra environment. `{udid}`, `{serial}`, `{shots}` and `{work}` are filled in. */
  env?: Record<string, string>;
  /** The environment variable naming the folder the walk writes PNGs into. Default SHOTS. */
  shots_env?: string;
  /**
   * A regular expression over a PNG's file name with named groups `screen` and
   * `variant` (and any others the `screen` template uses). A file that does
   * not match (a failure shot, a contact sheet) is left out and listed.
   */
  pattern: string;
  /** How the atlas names a screen from the groups, e.g. "{screen}.{state}". Default "{screen}". */
  screen?: string;
  /** The walk's variant names to the atlas's: light, dark, light-ax5, dark-ax5. Unlisted variants are left out. */
  variants: Record<string, string>;
  /** Longest the walk may take. Default 3600. */
  timeout_s?: number;
};

export type AtlasRecipe = {
  schema: 1;
  /** The atlas folder name, e.g. "homelake". */
  app: string;
  platforms: Record<string, AtlasPlatformRecipe>;
};

/** One shot in index.json. The first seven fields are the launch kit's captures.json fields. */
export type AtlasEntry = {
  file: string;
  sha256: string;
  size: number;
  kind: "screenshot";
  platform: string;
  screen: string;
  variant: string;
  width: number;
  height: number;
};

export type AtlasPlatformMeta = {
  device: string;
  captured_at: string;
  capture_s: number;
  shots: number;
  screens: number;
  /** Files the walk wrote that the recipe's pattern did not name. */
  left_out: string[];
};

export type AtlasIndex = {
  schema: 1;
  tool: "atlas";
  app: string;
  version: string;
  commit: string | null;
  updated_at: string;
  platforms: Record<string, AtlasPlatformMeta>;
  counts: { shots: number; screens: number };
  files: AtlasEntry[];
};

/** Atlas names: lowercase, digits, dot and dash. Anything else would be a path. */
const NAME = /^[a-z0-9][a-z0-9.-]*$/;
export const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export function slug(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read and check a recipe. Throws naming the field that is wrong. */
export function loadRecipe(file: string): AtlasRecipe {
  const r = JSON.parse(readFileSync(file, "utf8")) as AtlasRecipe;
  if (r.schema !== 1) throw new Error(`${file}: schema must be 1`);
  if (typeof r.app !== "string" || !NAME.test(r.app)) throw new Error(`${file}: app must match ${NAME}`);
  if (!r.platforms || typeof r.platforms !== "object") throw new Error(`${file}: platforms is missing`);
  for (const [p, pr] of Object.entries(r.platforms)) {
    if (!NAME.test(p)) throw new Error(`${file}: platform ${JSON.stringify(p)} must match ${NAME}`);
    if (!Array.isArray(pr.command) || pr.command.length === 0) throw new Error(`${file}: platforms.${p}.command is empty`);
    const re = new RegExp(pr.pattern);
    if (!/\(\?<screen>/.test(pr.pattern) || !/\(\?<variant>/.test(pr.pattern)) {
      throw new Error(`${file}: platforms.${p}.pattern needs named groups screen and variant (${re.source})`);
    }
    if (!pr.variants || Object.keys(pr.variants).length === 0) throw new Error(`${file}: platforms.${p}.variants is empty`);
    for (const v of Object.values(pr.variants)) {
      if (!NAME.test(v)) throw new Error(`${file}: platforms.${p}.variants value ${JSON.stringify(v)} must match ${NAME}`);
    }
  }
  return r;
}

export function versionDir(root: string, app: string, version: string): string {
  if (!NAME.test(app)) throw new Error(`app ${JSON.stringify(app)} must match ${NAME}`);
  if (!SAFE_VERSION.test(version)) throw new Error(`version ${JSON.stringify(version)} must match ${SAFE_VERSION}`);
  return path.join(root, app, version);
}

/** Width and height from a PNG's IHDR, without decoding it. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  const sig = "89504e470d0a1a0a";
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== sig) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function walkPngs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPngs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".png") && !e.name.startsWith("._")) out.push(p);
  }
  return out.sort();
}

/** The atlas's name for a shot the walk wrote, or null when the recipe does not name it. */
export function nameShot(fileName: string, pr: AtlasPlatformRecipe): { screen: string; variant: string } | null {
  const m = new RegExp(pr.pattern).exec(fileName);
  if (!m?.groups) return null;
  const variant = pr.variants[m.groups.variant];
  if (!variant) return null;
  const groups = m.groups;
  const raw = (pr.screen ?? "{screen}").replace(/\{(\w+)\}/g, (_, k: string) => groups[k] ?? "");
  const screen = slug(raw);
  if (!screen || !NAME.test(screen)) return null;
  return { screen, variant };
}

/**
 * Copy one platform's shots from the walk's folder into the version folder,
 * under the atlas's names. A second shot with the same name replaces the
 * first: a walk that photographs a screen twice meant the later one.
 */
export function normalizeShots(
  srcDir: string, outDir: string, platform: string, pr: AtlasPlatformRecipe,
): { entries: AtlasEntry[]; leftOut: string[] } {
  const platDir = path.join(outDir, platform);
  mkdirSync(platDir, { recursive: true });
  const byFile = new Map<string, AtlasEntry>();
  const leftOut: string[] = [];
  for (const src of walkPngs(srcDir)) {
    const name = nameShot(path.basename(src), pr);
    if (!name) {
      leftOut.push(path.relative(srcDir, src));
      continue;
    }
    const rel = `${platform}/${name.screen}__${name.variant}.png`;
    const buf = readFileSync(src);
    const { width, height } = pngSize(buf);
    copyFileSync(src, path.join(outDir, rel));
    byFile.set(rel, {
      file: rel,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
      kind: "screenshot",
      platform,
      screen: name.screen,
      variant: name.variant,
      width,
      height,
    });
  }
  const entries = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  return { entries, leftOut };
}

export function readIndex(dir: string): AtlasIndex | null {
  const f = path.join(dir, "index.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as AtlasIndex) : null;
}

const VARIANT_ORDER = ["light", "dark", "light-ax5", "dark-ax5"];
const variantRank = (v: string) => (VARIANT_ORDER.includes(v) ? VARIANT_ORDER.indexOf(v) : 99);

/**
 * Write (or merge into) a version's index.json and index.html. Platforms other
 * than `platform` keep their entries, so iOS and Android captured on different
 * hosts land in one index.
 */
export function writeIndex(
  dir: string,
  o: { app: string; version: string; commit: string | null; platform: string; meta: Omit<AtlasPlatformMeta, "shots" | "screens">; entries: AtlasEntry[] },
): AtlasIndex {
  const prev = readIndex(dir);
  const files = [...(prev?.files ?? []).filter((e) => e.platform !== o.platform), ...o.entries]
    .sort((a, b) => a.file.localeCompare(b.file));
  const screensOf = (es: AtlasEntry[]) => new Set(es.map((e) => `${e.platform}/${e.screen}`)).size;
  const platforms = { ...(prev?.platforms ?? {}) };
  platforms[o.platform] = { ...o.meta, shots: o.entries.length, screens: screensOf(o.entries) };
  const index: AtlasIndex = {
    schema: 1,
    tool: "atlas",
    app: o.app,
    version: o.version,
    commit: o.commit ?? prev?.commit ?? null,
    updated_at: new Date().toISOString(),
    platforms,
    counts: { shots: files.length, screens: screensOf(files) },
    files,
  };
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  writeFileSync(path.join(dir, "index.html"), indexHtml(index));
  return index;
}

/** The browsable page: one row per screen, one column per variant, per platform. */
export function indexHtml(index: AtlasIndex): string {
  const shots: SheetShot[] = [...index.files]
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.screen.localeCompare(b.screen) || variantRank(a.variant) - variantRank(b.variant))
    .map((e) => ({ column: e.variant, device: e.platform, shot: e.screen, file: e.file }));
  const plats = Object.entries(index.platforms)
    .map(([p, m]) => `${p}: ${m.shots} shots of ${m.screens} screens on ${m.device}, ${Math.round(m.capture_s / 60)} min`)
    .join("; ");
  return contactSheetHtml(`${index.app} ${index.version}`, shots, {
    columnNoun: "variant",
    subtitle: `Screen Atlas${index.commit ? ` at ${index.commit.slice(0, 10)}` : ""}. ${plats}`,
  });
}

export type DiffStatus = "same" | "changed" | "resized" | "new" | "gone";
export type DiffRow = {
  platform: string;
  screen: string;
  variant: string;
  status: DiffStatus;
  diff_pct: number | null;
  a: string | null;
  b: string | null;
  diff: string | null;
};
export type AtlasDiff = {
  schema: 1;
  tool: "atlas";
  app: string;
  from: string;
  to: string;
  threshold_pct: number;
  made_at: string;
  counts: Record<DiffStatus, number>;
  rows: DiffRow[];
};

/**
 * Compare two versions' shots, screen by screen.
 *
 * pixelmatch at its default colour threshold (0.1), antialiasing ignored, so a
 * shot whose pixels differ only by rendering noise reads as the same. A shot is
 * `changed` when more than `thresholdPct` of its pixels differ, `resized` when
 * its size changed (a longer page has changed, whatever its overlap looks
 * like), `new` or `gone` when only one version has it. Identical bytes skip the
 * decode.
 */
export function diffVersions(
  aDir: string, bDir: string, outDir: string, o: { thresholdPct?: number; only?: string } = {},
): AtlasDiff {
  const a = readIndex(aDir);
  const b = readIndex(bDir);
  if (!a) throw new Error(`${aDir} has no index.json`);
  if (!b) throw new Error(`${bDir} has no index.json`);
  const threshold = o.thresholdPct ?? 0.1;
  mkdirSync(path.join(outDir, "diff"), { recursive: true });
  const key = (e: AtlasEntry) => `${e.platform}/${e.screen}__${e.variant}`;
  const am = new Map(a.files.filter((e) => !o.only || e.platform === o.only).map((e) => [key(e), e]));
  const bm = new Map(b.files.filter((e) => !o.only || e.platform === o.only).map((e) => [key(e), e]));
  const keys = [...new Set([...am.keys(), ...bm.keys()])].sort();
  const rows: DiffRow[] = [];
  for (const k of keys) {
    const ea = am.get(k);
    const eb = bm.get(k);
    const base = { platform: (ea ?? eb)!.platform, screen: (ea ?? eb)!.screen, variant: (ea ?? eb)!.variant };
    const aFile = ea ? path.join(aDir, ea.file) : null;
    const bFile = eb ? path.join(bDir, eb.file) : null;
    if (!ea || !eb) {
      rows.push({ ...base, status: ea ? "gone" : "new", diff_pct: null, a: aFile, b: bFile, diff: null });
      continue;
    }
    if (ea.sha256 === eb.sha256) {
      rows.push({ ...base, status: "same", diff_pct: 0, a: aFile, b: bFile, diff: null });
      continue;
    }
    if (ea.width !== eb.width || ea.height !== eb.height) {
      rows.push({ ...base, status: "resized", diff_pct: 100, a: aFile, b: bFile, diff: null });
      continue;
    }
    const pa = PNG.sync.read(readFileSync(aFile!));
    const pb = PNG.sync.read(readFileSync(bFile!));
    const d = new PNG({ width: pa.width, height: pa.height });
    const n = pixelmatch(pa.data, pb.data, d.data, pa.width, pa.height, { threshold: 0.1 });
    const pct = (n / (pa.width * pa.height)) * 100;
    let diff: string | null = null;
    if (n > 0) {
      diff = path.join(outDir, "diff", `${base.platform}__${base.screen}__${base.variant}.png`);
      writeFileSync(diff, PNG.sync.write(d));
    }
    rows.push({ ...base, status: pct > threshold ? "changed" : "same", diff_pct: Math.round(pct * 1000) / 1000, a: aFile, b: bFile, diff });
  }
  const counts: Record<DiffStatus, number> = { same: 0, changed: 0, resized: 0, new: 0, gone: 0 };
  for (const r of rows) counts[r.status]++;
  const result: AtlasDiff = {
    schema: 1, tool: "atlas", app: b.app, from: a.version, to: b.version, threshold_pct: threshold,
    made_at: new Date().toISOString(), counts, rows,
  };
  // Paths in diff.json are relative to the report, so the folder can move (to the NAS) and still open.
  const rel = (p: string | null) => (p ? path.relative(outDir, p) : null);
  const portable = { ...result, rows: rows.map((r) => ({ ...r, a: rel(r.a), b: rel(r.b), diff: rel(r.diff) })) };
  writeFileSync(path.join(outDir, "diff.json"), JSON.stringify(portable, null, 2) + "\n");
  writeFileSync(path.join(outDir, "report.html"), diffHtml(portable));
  return portable;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_ORDER: DiffStatus[] = ["changed", "resized", "new", "gone", "same"];

/** The diff report: what changed first, each row the old shot, the new one and the diff image. */
export function diffHtml(d: AtlasDiff): string {
  const rows = [...d.rows].sort((x, y) =>
    STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || (y.diff_pct ?? 0) - (x.diff_pct ?? 0) ||
    `${x.platform}/${x.screen}/${x.variant}`.localeCompare(`${y.platform}/${y.screen}/${y.variant}`));
  const img = (p: string | null, alt: string) => (p ? `<a href="${esc(p)}"><img loading="lazy" src="${esc(p)}" alt="${esc(alt)}"></a>` : `<div class="hole">none</div>`);
  const body = rows.map((r) => `<tr class="${r.status}"><th>${esc(r.platform)}<br>${esc(r.screen)}<br><small>${esc(r.variant)}</small></th>` +
    `<td class="st">${r.status}${r.diff_pct != null && r.status !== "same" ? `<br>${r.diff_pct}%` : ""}</td>` +
    `<td>${img(r.a, `${d.from}`)}</td><td>${img(r.b, `${d.to}`)}</td><td>${img(r.diff, "diff")}</td></tr>`).join("\n");
  const c = d.counts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.app)} ${esc(d.from)} to ${esc(d.to)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--changed:#b45309;--new:#1d4ed8;--gone:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#999;--line:#333;--changed:#f59e0b;--new:#60a5fa;--gone:#f87171}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,system-ui,sans-serif}
table{border-collapse:collapse;width:100%}th,td{border-top:1px solid var(--line);padding:8px;vertical-align:top;text-align:left}
th{width:12em;font-weight:600}td.st{width:6em}img{max-width:220px;width:100%;height:auto;border:1px solid var(--line)}
tr.changed td.st,tr.resized td.st{color:var(--changed)}tr.new td.st{color:var(--new)}tr.gone td.st{color:var(--gone)}
tr.same{opacity:.55}.hole{color:var(--muted)}p{color:var(--muted)}
</style></head><body>
<h1>${esc(d.app)}: ${esc(d.from)} to ${esc(d.to)}</h1>
<p>${c.changed} changed, ${c.resized} resized, ${c.new} new, ${c.gone} gone, ${c.same} the same (a shot counts as changed above ${d.threshold_pct}% of its pixels). Made ${esc(d.made_at)}.</p>
<table><thead><tr><th>screen</th><td>status</td><td>${esc(d.from)}</td><td>${esc(d.to)}</td><td>diff</td></tr></thead><tbody>
${body}
</tbody></table></body></html>
`;
}

/** Run a command to completion, with its output going to `log`. Resolves the exit code. */
export function runLogged(
  argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutS: number; log: (line: string) => void; onTick?: () => void },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    const tick = o.onTick ? setInterval(o.onTick, 60_000) : null;
    const kill = setTimeout(() => child.kill("SIGTERM"), o.timeoutS * 1000);
    let buf = "";
    const take = (chunk: Buffer) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        o.log(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => {
      if (buf) o.log(buf);
      if (tick) clearInterval(tick);
      clearTimeout(kill);
      resolve(code ?? 1);
    });
    child.on("error", (e) => {
      o.log(`cannot start ${argv[0]}: ${e.message}`);
      if (tick) clearInterval(tick);
      clearTimeout(kill);
      resolve(127);
    });
  });
}

/** Fill `{udid}`-style placeholders in a recipe's env. */
export function fillEnv(env: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = v.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m);
  return out;
}

function capture(argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
    c.on("error", (e) => resolve({ code: 127, out: e.message }));
  });
}

/**
 * Copy a version folder to the NAS and prove it landed.
 *
 * `dest` is `host:path` (rsync over ssh; on this lab the NAS is mounted only on
 * ultra, at ~/mnt/photos) or a local folder. After the copy every shot's
 * sha256 on the far side is compared with the index; macOS's `._*` files are
 * ignored. `catalog`, when given, gets a copy of index.json (and each
 * diff-from-<v>/diff.json, as diff-from-<v>.json) on
 * a local disk, because launchd jobs (the lake's collector) cannot read the
 * NFS share: never a symlink from a scanned tree into the NAS.
 */
export async function storeAtlas(
  dir: string, app: string, version: string, dest: string, catalog?: string,
): Promise<{ files: number; verified: number; dest: string }> {
  const index = readIndex(dir);
  if (!index) throw new Error(`${dir} has no index.json`);
  const remote = /^[A-Za-z0-9._-]+:/.test(dest);
  const target = `${dest.replace(/\/+$/, "")}/${app}/${version}`;
  const [host, rpath] = remote ? [dest.split(":")[0], target.slice(dest.split(":")[0].length + 1)] : [null, target];
  const mk = remote ? await capture(["ssh", host!, `mkdir -p '${rpath}'`]) : (mkdirSync(rpath, { recursive: true }), { code: 0, out: "" });
  if (mk.code !== 0) throw new Error(`cannot make ${target}: ${mk.out.trim()}`);
  const rs = await capture(["rsync", "-a", "--exclude", "._*", `${dir.replace(/\/+$/, "")}/`, remote ? `${host}:${rpath}/` : `${rpath}/`]);
  if (rs.code !== 0) throw new Error(`rsync to ${target} failed: ${rs.out.trim().slice(0, 300)}`);
  const list = remote
    ? await capture(["ssh", host!, `cd '${rpath}' && find . -name '*.png' ! -name '._*' -type f -exec shasum -a 256 {} +`])
    : await capture(["sh", "-c", `cd '${rpath}' && find . -name '*.png' ! -name '._*' -type f -exec shasum -a 256 {} +`]);
  if (list.code !== 0) throw new Error(`cannot list ${target}: ${list.out.trim().slice(0, 300)}`);
  const far = new Map<string, string>();
  for (const line of list.out.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim());
    if (m) far.set(m[2], m[1]);
  }
  const bad = index.files.filter((e) => far.get(e.file) !== e.sha256).map((e) => e.file);
  if (bad.length) throw new Error(`${bad.length} of ${index.files.length} shots did not land intact at ${target}, e.g. ${bad[0]}`);
  if (catalog) {
    const cremote = /^[A-Za-z0-9._-]+:/.test(catalog);
    const ctarget = `${catalog.replace(/\/+$/, "")}/${app}/${version}`;
    // index.json, and each diff-from-<v>/diff.json as diff-from-<v>.json: one flat folder per version.
    const stage = mkdtempSync(path.join(os.tmpdir(), "atlas-catalog-"));
    copyFileSync(path.join(dir, "index.json"), path.join(stage, "index.json"));
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const dj = path.join(dir, e.name, "diff.json");
      if (e.isDirectory() && e.name.startsWith("diff-from-") && existsSync(dj)) copyFileSync(dj, path.join(stage, `${e.name}.json`));
    }
    if (cremote) {
      const ch = catalog.split(":")[0];
      const cp = ctarget.slice(ch.length + 1);
      const m2 = await capture(["ssh", ch, `mkdir -p '${cp}'`]);
      if (m2.code !== 0) throw new Error(`cannot make ${ctarget}: ${m2.out.trim()}`);
      const c2 = await capture(["rsync", "-a", `${stage}/`, `${ch}:${cp}/`]);
      if (c2.code !== 0) throw new Error(`cannot copy the index to ${ctarget}: ${c2.out.trim()}`);
    } else {
      mkdirSync(ctarget, { recursive: true });
      for (const f of readdirSync(stage)) copyFileSync(path.join(stage, f), path.join(ctarget, f));
    }
  }
  return { files: index.files.length, verified: index.files.length, dest: target };
}

/**
 * Run one platform's walk on one device and file what it wrote.
 *
 * The walk writes into a fresh folder under `work`, never into the atlas, so a
 * failed walk leaves the version's earlier shots alone. A walk that exits
 * non-zero but wrote shots is still filed (a screen walk that loses one screen
 * has photographed the rest), with `exit` on the result saying so; a walk that
 * wrote nothing files nothing.
 */
export async function capturePlatform(o: {
  recipe: AtlasRecipe; platform: string; checkout: string; root: string; version: string;
  device: string; work: string; log: (line: string) => void; onTick?: () => void;
  vars?: Record<string, string>;
}): Promise<{ exit: number; index: AtlasIndex | null; entries: AtlasEntry[]; leftOut: string[]; captureS: number; dir: string }> {
  const pr = o.recipe.platforms[o.platform];
  if (!pr) throw new Error(`the recipe has no platform ${o.platform} (it has ${Object.keys(o.recipe.platforms).join(", ")})`);
  const shots = path.join(o.work, `shots-${o.platform}`);
  mkdirSync(shots, { recursive: true });
  const vars = { udid: o.device, serial: o.device, shots, work: o.work, version: o.version, ...(o.vars ?? {}) };
  const env = { ...process.env, ...fillEnv(pr.env, vars), [pr.shots_env ?? "SHOTS"]: shots };
  const argv = pr.command.map((a) => a.replace(/\{(\w+)\}/g, (m, n: string) => (vars as Record<string, string>)[n] ?? m));
  const t0 = Date.now();
  o.log(`atlas: ${o.recipe.app} ${o.version} ${o.platform} on ${o.device}: ${argv.join(" ")}`);
  const exit = await runLogged(argv, { cwd: o.checkout, env, timeoutS: pr.timeout_s ?? 3600, log: o.log, onTick: o.onTick });
  const captureS = Math.round((Date.now() - t0) / 1000);
  const dir = versionDir(o.root, o.recipe.app, o.version);
  const { entries, leftOut } = normalizeShots(shots, dir, o.platform, pr);
  if (entries.length === 0) return { exit, index: null, entries, leftOut, captureS, dir };
  const head = await capture(["git", "-C", o.checkout, "rev-parse", "HEAD"]);
  const index = writeIndex(dir, {
    app: o.recipe.app, version: o.version, commit: head.code === 0 ? head.out.trim() : null, platform: o.platform,
    meta: { device: o.device, captured_at: new Date(t0).toISOString(), capture_s: captureS, left_out: leftOut },
    entries,
  });
  return { exit, index, entries, leftOut, captureS, dir };
}

/** Where `atlas diff` writes by default: inside the newer version, so storing it carries the report. */
export function diffDir(root: string, app: string, from: string, to: string): string {
  return path.join(versionDir(root, app, to), `diff-from-${from}`);
}

/** A folder's total bytes, for the log line. */
export function folderBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? folderBytes(p) : statSync(p).size;
  }
  return n;
}
