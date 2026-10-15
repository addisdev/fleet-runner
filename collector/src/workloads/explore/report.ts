/**
 * What a person reads in the morning: a finding's steps in words, and a sheet
 * of thumbnails that shows the walk that led to it.
 *
 * The sheet is one self-contained HTML file with the images inlined, because
 * it is an artifact: it is downloaded from the collector and opened anywhere,
 * and a page that pointed at files beside it would arrive with every image
 * broken.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { boxResize, decodePng } from "./image.js";
import type { Executed } from "./replay.js";
import type { Action, TrajectoryStep } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A small PNG for the sheet: 220 pixels wide. */
export function thumb(png: Buffer, width = 220): Buffer {
  const src = decodePng(png);
  const h = Math.max(1, Math.round((width * src.height) / src.width));
  const small = boxResize(src, width, h);
  const out = new PNG({ width, height: h });
  small.data.copy(out.data);
  return PNG.sync.write(out);
}

/** What an action was, in words a bug report can use. */
export function describeAction(a: Action, element?: string): string {
  const what = element ? ` "${element}"` : "";
  switch (a.kind) {
    case "tap": return `Tap${what || ` at ${Math.round(a.x)},${Math.round(a.y)}`}`;
    case "long_press": return `Long-press${what || ` at ${Math.round(a.x)},${Math.round(a.y)}`}`;
    case "type": return `${a.overwrite ? "Replace the text with" : "Type"} ${JSON.stringify(a.text)}${a.enter ? " and press Enter" : ""}`;
    case "swipe": return "Swipe";
    case "scroll": return `Scroll ${a.direction}`;
    case "key": return `Press ${a.key.replace("_", " ")}`;
    case "hide_keyboard": return "Hide the keyboard";
    case "wait": return `Wait ${Math.round(a.ms / 1000)} s`;
  }
}

/**
 * Steps a person would follow, from the trajectory, up to `upTo` executed
 * entries. Element names come from the model's own `element` argument when it
 * gave one, which is usually the most readable thing available.
 */
export function stepsInWords(steps: TrajectoryStep[], executed: Executed[], upTo: number, screenNames: Map<string, string>): string[] {
  const out: string[] = [];
  let lastScreen = "";
  for (const e of executed.slice(0, upTo)) {
    const st = steps.find((s) => s.i === e.step);
    if (st && st.screen !== lastScreen) {
      lastScreen = st.screen;
      out.push(`On "${screenNames.get(st.screen) ?? st.screen}":`);
    }
    if (e.kind === "relaunch") { out.push("  (the app was restarted)"); continue; }
    if (e.kind === "home") { out.push("  Press Home, then reopen the app"); continue; }
    const call = st?.calls.find((c) => typeof c.args.element === "string");
    out.push(`  ${describeAction(e.action, e.action.kind === "tap" || e.action.kind === "type" || e.action.kind === "long_press" ? (call?.args.element as string | undefined) : undefined)}`);
  }
  return out;
}

/** The trajectory sheet: one card per step, newest last, with what the model did and what fired. */
export function trajectorySheet(opts: {
  title: string; subtitle: string; runDir: string; steps: TrajectoryStep[]; screenNames: Map<string, string>;
  from?: number; to?: number; highlight?: number;
}): string {
  const steps = opts.steps.filter((s) => s.i >= (opts.from ?? 0) && s.i <= (opts.to ?? Infinity));
  const cards = steps.map((s) => {
    let img = "";
    try {
      img = `<img alt="step ${s.i}" src="data:image/png;base64,${thumb(readFileSync(path.join(opts.runDir, s.shot))).toString("base64")}">`;
    } catch { img = `<div class="hole">no shot</div>`; }
    const checks = s.checks.map((c) => `<li class="chk">${esc(c.check)}: ${esc(c.detail)}</li>`).join("");
    const refused = s.refused.map((r) => `<li class="ref">refused ${esc(r.call)}: ${esc(r.reason)}</li>`).join("");
    const calls = s.calls.map((c) => `<li><code>${esc(c.name)}</code> ${esc(JSON.stringify(c.args).slice(0, 140))}</li>`).join("");
    return `<figure class="${s.i === opts.highlight ? "hi" : ""}">${img}<figcaption><b>${s.i}</b> · ${esc(opts.screenNames.get(s.screen) ?? s.screen)}${s.newScreen ? " · <i>new</i>" : ""}<span class="ms">${(s.model.ms / 1000).toFixed(1)} s</span>${s.note ? `<p>${esc(s.note.slice(0, 220))}</p>` : ""}<ul>${calls}${refused}${checks}</ul></figcaption></figure>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#1a1f26;--mute:#5d6673;--line:#d5dae0;--hi:#b0420e;--chk:#8a1c1c;--ref:#6b4e00}
@media (prefers-color-scheme:dark){:root{--bg:#121519;--card:#1b2026;--ink:#e6e9ed;--mute:#9aa3ad;--line:#2c333b;--hi:#f08a4b;--chk:#ff8a8a;--ref:#e7c25b}}
body{margin:0;padding:20px;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--mute);margin:0 0 18px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px}
figure.hi{border:2px solid var(--hi)}img{width:100%;border-radius:3px;border:1px solid var(--line)}
figcaption{font-size:12px}figcaption p{margin:4px 0;color:var(--mute)}.ms{float:right;color:var(--mute)}
ul{margin:4px 0 0;padding-left:16px}code{font-size:11px}.chk{color:var(--chk)}.ref{color:var(--ref)}
.hole{aspect-ratio:9/16;display:grid;place-items:center;color:var(--mute);border:1px dashed var(--line)}
</style></head><body><h1>${esc(opts.title)}</h1><p class="sub">${esc(opts.subtitle)}</p><main>${cards}</main></body></html>`;
}
