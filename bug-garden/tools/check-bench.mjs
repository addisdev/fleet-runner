#!/usr/bin/env node
/**
 * Check a bench mission's end state against a uiautomator dump, with no model.
 *
 *   node bug-garden/tools/check-bench.mjs <mission.json> <dump.xml>
 *   adb exec-out uiautomator dump /dev/tty | node check-bench.mjs <mission.json> -
 *
 * Exit 0 and "PASS" when every part of the mission's `check` holds, exit 1 and
 * "FAIL" with what was missing otherwise.
 *
 * The rules, which are the ones README.md states for the harness:
 *   text          every string must be a substring (case-sensitive) of some
 *                 node's text OR content-desc. Content-desc counts because an
 *                 icon button's label is its content-desc (the Settings icon on
 *                 Home is "Ajustes" in Spanish).
 *   screen        some node has resource-id "screen_<screen>". The bug garden
 *                 tags every screen's root that way.
 *   focused_label some node with focused="true" has the string in its text or
 *                 content-desc.
 *
 * Standalone on purpose: no imports from the collector, so it can be pointed
 * at a dump from any device without building anything.
 */
import { readFileSync } from "node:fs";

const [missionPath, dumpPath] = process.argv.slice(2);
if (!missionPath || !dumpPath) {
  console.error("usage: check-bench.mjs <mission.json> <dump.xml|->");
  process.exit(2);
}
const mission = JSON.parse(readFileSync(missionPath, "utf8"));
const xml = readFileSync(dumpPath === "-" ? 0 : dumpPath, "utf8");

const unescape = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, "&");

const nodes = [];
for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
  const a = {};
  for (const kv of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) a[kv[1]] = unescape(kv[2]);
  nodes.push({ text: a.text ?? "", desc: a["content-desc"] ?? "", id: a["resource-id"] ?? "", focused: a.focused === "true" });
}
if (nodes.length === 0) {
  console.log(`FAIL ${mission.id}: the dump has no nodes`);
  process.exit(1);
}

const check = mission.check ?? {};
const missing = [];
for (const t of check.text ?? []) {
  if (!nodes.some((n) => n.text.includes(t) || n.desc.includes(t))) missing.push(`text ${JSON.stringify(t)}`);
}
if (check.screen && !nodes.some((n) => n.id === `screen_${check.screen}`)) {
  const on = nodes.find((n) => n.id.startsWith("screen_"))?.id ?? "no tagged screen";
  missing.push(`screen ${check.screen} (on ${on})`);
}
if (check.focused_label && !nodes.some((n) => n.focused && (n.text.includes(check.focused_label) || n.desc.includes(check.focused_label)))) {
  missing.push(`focused ${JSON.stringify(check.focused_label)}`);
}

if (missing.length) {
  console.log(`FAIL ${mission.id}: missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`PASS ${mission.id}`);
