/**
 * The screen map: every screen of an app the explorer has seen, across nights.
 *
 * A screen's identity is what is ON it structurally -- the ids and classes of
 * its controls and its short static labels -- not what it looks like. A plant
 * list with three plants and a plant list with thirty are the same screen; a
 * clock ticking in the corner does not make a new one. Two observations are the
 * same screen when their token sets overlap by at least 60% (Jaccard), and the
 * picture hash decides only when there is no tree to read.
 *
 * What the map is for:
 *
 *   - novelty: the model is told whether the screen in front of it has been
 *     seen before, how often, and which screens it has not reached yet this
 *     run, which is what turns a random walk into exploration;
 *   - names: findings and the morning list say "Plant detail", not a hash;
 *   - memory: it lives in a JSON file on the executor host and grows night
 *     over night, so the second night starts knowing the first night's map.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { A11yNode } from "../../a11y-tree.js";
import { hamming } from "./image.js";

export type ScreenEntry = {
  id: string;
  name: string;
  tokens: string[];
  hash: string | null;
  firstSeen: string;
  lastSeen: string;
  visits: number;
  /** Nights (job ids) the screen was seen on; capped. */
  nights: string[];
};

type MapFile = { version: 1; app: string; screens: ScreenEntry[] };

const STATE_DIR = process.env.FLEET_STATE_DIR ?? path.join(os.homedir(), ".fleet");

/**
 * The tokens a screen is identified by.
 *
 * Numbers, dates, prices and anything long are dropped: they are content, and
 * content changes between visits to the same screen. Resource ids are kept
 * whole because they are the most stable thing an Android screen has; on iOS
 * the accessibility identifiers play the same part.
 */
export function screenTokens(nodes: A11yNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.id) out.add(`id:${n.id.split("/").pop()}`);
    const cls = (n.cls.split(".").pop() ?? "").replace(/^XCUIElementType/, "");
    if (n.tappable && cls) out.add(`tap:${cls}`);
    for (const t of [n.text, n.label]) {
      const s = t.trim();
      if (s.length < 2 || s.length > 32) continue;
      if (/\d/.test(s)) continue;
      out.add(`t:${s.toLowerCase()}`);
    }
  }
  return [...out].sort();
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sb = new Set(b);
  let inter = 0;
  for (const t of a) if (sb.has(t)) inter++;
  return inter / (a.length + b.length - inter);
}

/**
 * A readable name: the most title-like text near the top of the screen.
 *
 * Largest text height in the top quarter wins, which in practice is the app
 * bar title. Falls back to the first short label anywhere, then to the id.
 */
export function screenName(nodes: A11yNode[] | null, height: number, fallback: string): string {
  if (!nodes) return fallback;
  const candidates = nodes.filter((n) => n.bounds && (n.text || n.label)
    && n.bounds.y < height * 0.25 && n.bounds.y > height * 0.02
    && (n.text || n.label).trim().length >= 2 && (n.text || n.label).trim().length <= 40
    && !/^\d+[:.]\d+/.test((n.text || n.label).trim()));
  candidates.sort((a, b) => b.bounds!.h - a.bounds!.h || a.bounds!.y - b.bounds!.y);
  const pick = candidates[0] ?? nodes.find((n) => (n.text || n.label).trim().length >= 3 && (n.text || n.label).trim().length <= 40);
  return pick ? (pick.text || pick.label).trim() : fallback;
}

export class ScreenMap {
  private file: string;
  private data: MapFile;
  private dirty = false;
  /** Screens seen in this run, in order of first visit. */
  readonly seenThisRun: string[] = [];

  constructor(readonly app: string, dir = path.join(STATE_DIR, "explore", app.replace(/[^\w.-]/g, "_"))) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "screenmap.json");
    this.data = { version: 1, app, screens: [] };
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as MapFile;
        if (parsed.version === 1 && Array.isArray(parsed.screens)) this.data = parsed;
      } catch { /* a corrupt map is rebuilt; it is a cache of observations, not a record */ }
    }
  }

  get size() { return this.data.screens.length; }

  /**
   * Which screen this is; adds it to the map when it is new.
   * `newEver` is new to the map; `newThisRun` is new tonight.
   */
  identify(nodes: A11yNode[] | null, hash: string, height: number, night: string): { entry: ScreenEntry; newEver: boolean; newThisRun: boolean } {
    const tokens = nodes ? screenTokens(nodes) : [];
    let best: ScreenEntry | null = null, bestScore = 0;
    for (const s of this.data.screens) {
      const score = tokens.length && s.tokens.length
        ? jaccard(tokens, s.tokens)
        : (s.hash && hamming(hash, s.hash) <= 6 ? 0.99 : 0);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    const now = new Date().toISOString();
    let newEver = false;
    if (!best || bestScore < 0.6) {
      newEver = true;
      const id = createHash("sha1").update(tokens.join("|") || hash).digest("hex").slice(0, 10);
      best = { id, name: screenName(nodes, height, `screen ${id.slice(0, 4)}`), tokens, hash, firstSeen: now, lastSeen: now, visits: 0, nights: [] };
      this.data.screens.push(best);
    } else if (tokens.length > best.tokens.length && bestScore > 0.8) {
      // A richer view of the same screen (a list that loaded more rows)
      // becomes its identity, so the next match is stricter, not looser.
      best.tokens = tokens;
    }
    best.visits++;
    best.lastSeen = now;
    if (!best.nights.includes(night)) best.nights = [...best.nights, night].slice(-30);
    const newThisRun = !this.seenThisRun.includes(best.id);
    if (newThisRun) this.seenThisRun.push(best.id);
    this.dirty = true;
    return { entry: best, newEver, newThisRun };
  }

  /** Screens the map knows that this run has not reached yet, most-visited first. */
  unvisited(limit = 8): ScreenEntry[] {
    return this.data.screens
      .filter((s) => !this.seenThisRun.includes(s.id))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, limit);
  }

  byId(id: string): ScreenEntry | undefined {
    return this.data.screens.find((s) => s.id === id);
  }

  /** Written atomically, so a killed executor cannot leave half a map. */
  save() {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
    this.dirty = false;
  }
}
