/**
 * scripts/check-counts.mjs reads the catalog right.
 *
 * That script counts shipped workloads by reading catalog.ts as text, so it can
 * run on every pull request without `npm ci` and check the numbers the README
 * and the docs state by hand. Reading TypeScript as text is a guess about its
 * shape; this imports the real CATALOG and fails if the guess and the truth
 * disagree, so a refactor of catalog.ts cannot quietly turn the docs check into
 * a check of the wrong number.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/workloads/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const truth = CATALOG.filter((w) => w.status !== "reserved").length;
const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/check-counts.mjs"), "--json"], { encoding: "utf8" });
const parsed = (JSON.parse(out) as { workloads: number }).workloads;

if (parsed !== truth) {
  console.error(`  FAIL  scripts/check-counts.mjs counts ${parsed} shipped workloads; CATALOG has ${truth}`);
  process.exit(1);
}
console.log(`  ok    scripts/check-counts.mjs and CATALOG agree: ${truth} shipped workloads`);
