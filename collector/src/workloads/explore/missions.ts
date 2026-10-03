/**
 * Which missions run tonight, and in what order.
 *
 * A night is short: at 20 seconds a step, two and a half hours is about eleven
 * forty-step missions across every app and surface. So the order matters more
 * than the list, and the rule is that **missions aimed at what changed today
 * go first** (D6). The day's commits name files; files name screens
 * (PlantDetailScreen.kt, CareReminderView.swift); a mission card lists the
 * screens it tends to reach. Overlap between the two ranks the cards, and the
 * changed screen names are also handed to the model as a hint, so even a
 * general mission leans towards today's work.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Mission, Surface } from "./types.js";

const run = promisify(execFile);

export const MISSIONS_DIR = process.env.FLEET_MISSIONS_DIR ?? path.resolve("examples/missions");

/** Every card for an app, validated loosely; a broken card is reported, not fatal. */
export function loadMissions(app: string, dir = MISSIONS_DIR, onProblem: (m: string) => void = () => {}): Mission[] {
  const d = path.join(dir, app);
  if (!existsSync(d)) return [];
  const out: Mission[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(readFileSync(path.join(d, f), "utf8")) as Mission | Mission[];
      for (const m of Array.isArray(raw) ? raw : [raw]) {
        const problem = missionProblem(m);
        if (problem) { onProblem(`${app}/${f}: ${problem}`); continue; }
        out.push({ ...m, app: m.app ?? app });
      }
    } catch (e) {
      onProblem(`${app}/${f}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function missionProblem(m: Partial<Mission>): string | null {
  for (const k of ["id", "title", "persona", "goal"] as const) {
    if (typeof m[k] !== "string" || !m[k]) return `missing ${k}`;
  }
  if (m.budget?.steps !== undefined && (!Number.isInteger(m.budget.steps) || m.budget.steps < 3 || m.budget.steps > 300)) {
    return "budget.steps must be an integer from 3 to 300";
  }
  return null;
}

/**
 * Screen-ish words out of changed file paths.
 *
 * `app/src/main/java/com/x/plant/PlantDetailScreen.kt` -> ["plant", "detail"].
 * Generic suffixes (Screen, View, ViewModel, Fragment, Activity, Test) and
 * directory names that every file shares are dropped, because they would
 * match every card equally and rank nothing.
 */
export function changedWords(files: string[]): string[] {
  const generic = new Set(["screen", "view", "viewmodel", "model", "fragment", "activity", "test", "tests", "ui", "kt", "swift",
    "java", "src", "main", "app", "impl", "repository", "util", "utils", "helper", "component", "components", "the", "and", "for", "res", "values", "layout", "drawable", "xml", "json", "md", "strings"]);
  const out = new Set<string>();
  for (const f of files) {
    const base = path.basename(f).replace(/\.[^.]+$/, "");
    for (const w of base.split(/(?=[A-Z][a-z])|[_\-.\s]+/)) {
      const lw = w.toLowerCase();
      if (lw.length >= 3 && !generic.has(lw) && !/^\d+$/.test(lw)) out.add(lw);
    }
  }
  return [...out];
}

/** Files changed in `repo` since `since` (a sha or a git date like "24 hours ago"). */
export async function changedFiles(repo: string, since: string): Promise<string[]> {
  const range = /^[0-9a-f]{7,40}$/.test(since) ? [`${since}..HEAD`] : [`--since=${since}`];
  const { stdout } = await run("git", ["-C", repo, "log", "--name-only", "--pretty=format:", ...range], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return [...new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
}

/**
 * Order cards for tonight: matches with today's words first, then cards that
 * have run least recently (`lastRun`, from the screen map's history), then
 * file order. Cards for another surface are dropped.
 */
export function orderMissions(ms: Mission[], opts: { surface: Surface; words?: string[]; lastRun?: Record<string, string>; only?: string[]; bench?: boolean }): Mission[] {
  const words = new Set((opts.words ?? []).map((w) => w.toLowerCase()));
  const score = (m: Mission) => {
    const hay = [...(m.screens ?? []), m.title, m.goal].join(" ").toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s++;
    return s;
  };
  return ms
    .filter((m) => !m.surfaces || m.surfaces.includes(opts.surface))
    .filter((m) => (opts.only?.length ? opts.only.includes(m.id) : true))
    .filter((m) => (opts.bench ? m.id.startsWith("bench-") : !m.id.startsWith("bench-") || (opts.only?.includes(m.id) ?? false)))
    .map((m, i) => ({ m, i, s: score(m), last: opts.lastRun?.[m.id] ?? "" }))
    .sort((a, b) => b.s - a.s || a.last.localeCompare(b.last) || a.i - b.i)
    .map((x) => x.m);
}
