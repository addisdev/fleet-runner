#!/usr/bin/env node
/**
 * The numbers the docs state by hand agree with the code.
 *
 *   node scripts/check-counts.mjs          # exit 1 on any disagreement
 *   node scripts/check-counts.mjs --json   # print the counts and exit
 *
 * The README and the docs said "28 workloads" while the catalog grew to 34,
 * and nothing noticed. A number written in prose cannot be generated without
 * turning the prose into a template, so instead each one is marked where it
 * stands and this checks the marks:
 *
 *     The collector ships <!-- count:workloads -->34 workloads.
 *     <!-- count:workloads -->Thirty-four workloads ...
 *
 * The comment is invisible on GitHub and in the mkdocs site. The number right
 * after it -- digits, or words up to ninety-nine -- is compared with the count,
 * and a mismatch fails with the file, the line and what it should say.
 *
 * ## Where the count comes from
 *
 * `workloads` is the number of entries in `CATALOG` in
 * collector/src/workloads/catalog.ts that are not `reserved(...)`. It is read as
 * text rather than imported, so this runs with no `npm ci` and can sit in a job
 * that runs on every pull request, docs-only ones included -- a docs change is
 * exactly where a stale number gets written. The collector's own suite imports
 * the real `CATALOG` and checks this parse against it
 * (collector/scripts/check-counts.ts), so the text reading cannot drift away
 * from what the catalog actually holds without that suite failing.
 *
 * Plain Node, no dependencies, like scripts/version.mjs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = "collector/src/workloads/catalog.ts";

/**
 * Shipped and reserved entries in the CATALOG array literal.
 *
 * Each entry is one call at the array's top level: `e(...)` or
 * `fromManifest(...)` for shipped, `reserved(...)` for reserved. Anything else
 * at that level -- a spread, an inline object -- throws, because a parse that
 * silently skips an entry is a check that silently passes.
 */
export function countCatalog(src) {
  const start = src.indexOf("export const CATALOG");
  if (start < 0) throw new Error(`no \`export const CATALOG\` in ${CATALOG}`);
  const open = src.indexOf("[", src.indexOf("=", start));
  let depth = 0;
  let i = open;
  let entryStart = -1;
  const entries = [];
  let inString = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") {
      depth++;
      if (depth === 2 && entryStart < 0) entryStart = i;
      continue;
    }
    if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && /\S/.test(c) && c !== ",") {
      if (entryStart < 0) entryStart = i;
    }
    if (depth === 1 && c === "," && entryStart >= 0) {
      entries.push(src.slice(entryStart, i).trim());
      entryStart = -1;
    }
  }
  if (depth !== 0) throw new Error(`the CATALOG array in ${CATALOG} never closes`);
  if (entryStart >= 0) {
    const last = src.slice(entryStart, i).trim();
    if (last) entries.push(last);
  }
  let shipped = 0;
  let reserved = 0;
  for (const entry of entries) {
    const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(entry)?.[1];
    if (callee === "reserved") reserved++;
    else if (callee === "e" || callee === "fromManifest") shipped++;
    else throw new Error(`cannot tell whether this CATALOG entry is shipped: ${entry.slice(0, 80)}`);
  }
  if (shipped === 0) throw new Error(`counted no shipped workloads in ${CATALOG}; this check needs updating`);
  return { shipped, reserved };
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** `34`, `thirty-four`, `Thirty four` -> 34. Null for anything else. */
export function parseCount(text) {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const words = t.split(/[-\s]+/);
  if (words.length === 1) {
    const one = ONES.indexOf(words[0]);
    if (one >= 0) return one;
    const ten = TENS.indexOf(words[0]);
    return ten >= 2 ? ten * 10 : null;
  }
  if (words.length === 2) {
    const ten = TENS.indexOf(words[0]);
    const one = ONES.indexOf(words[1]);
    if (ten >= 2 && one >= 1 && one <= 9) return ten * 10 + one;
  }
  return null;
}

const MARKER = /<!--\s*count:([a-z-]+)\s*-->\s*([0-9]+|[A-Za-z]+(?:[-\s][A-Za-z]+)?)/g;

/**
 * The text with code blanked out, same length, newlines kept.
 *
 * A marker written inside backticks is an example of the syntax -- in
 * CONTRIBUTING.md, in a changelog entry -- not a number standing in prose, and
 * it must not start failing the day the count moves.
 */
export function maskCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blank);
}

/** Every marked number in a file, outside code: `{ key, text, value, line }`. */
export function findMarkers(text) {
  const out = [];
  text = maskCode(text);
  for (const m of text.matchAll(MARKER)) {
    let token = m[2];
    // "thirty-four workloads": keep the second word only if it is a units word.
    let value = parseCount(token);
    if (value === null && /[-\s]/.test(token)) {
      token = token.split(/[-\s]/)[0];
      value = parseCount(token);
    }
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ key: m[1], text: token, value, line });
  }
  return out;
}

/**
 * Problems, as strings. `files` is `[{ path, text }]`; `counts` maps a marker
 * key to the true number.
 */
export function check(files, counts) {
  const problems = [];
  let seen = 0;
  for (const f of files) {
    for (const mark of findMarkers(f.text)) {
      seen++;
      const where = `${f.path}:${mark.line}`;
      if (!(mark.key in counts)) {
        problems.push(`${where}: unknown count "${mark.key}" (known: ${Object.keys(counts).join(", ")})`);
      } else if (mark.value === null) {
        problems.push(`${where}: "${mark.text}" after <!-- count:${mark.key} --> is not a number`);
      } else if (mark.value !== counts[mark.key]) {
        problems.push(`${where}: says ${mark.text}, but there are ${counts[mark.key]} ${mark.key}`);
      }
    }
  }
  if (seen === 0) problems.push("found no <!-- count:... --> markers at all, so nothing was checked");
  return { problems, seen };
}

/** Markdown files worth checking: the READMEs and docs/, never dependencies. */
function markdownFiles(dir = ROOT, rel = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "site" || name === "dist" || name === "build") continue;
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(abs, r));
    else if (name.endsWith(".md")) out.push(r);
  }
  return out;
}

export function counts() {
  const { shipped } = countCatalog(readFileSync(path.join(ROOT, CATALOG), "utf8"));
  return { workloads: shipped };
}

function main(argv) {
  const c = counts();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(c));
    return 0;
  }
  const files = markdownFiles().map((p) => ({ path: p, text: readFileSync(path.join(ROOT, p), "utf8") }));
  const { problems, seen } = check(files, c);
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    console.error(`\n${problems.length} documented count(s) disagree with the code. Fix the number after the marker.`);
    return 1;
  }
  console.log(`ok -- ${seen} marked count(s) agree: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
