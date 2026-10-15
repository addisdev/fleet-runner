/**
 * The installers copy a release's directories by name rather than replacing the
 * install directory, because the install directory is also FLEET_HOME and holds
 * the fleet's data. So a directory build.mjs adds to the bundle is dropped on
 * install unless both installers name it too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FLEET } from "./helpers.js";

const read = (rel: string) => readFileSync(path.join(FLEET, rel), "utf8");

function bundleEntries(): string[] {
  const src = read("build.mjs");
  const names = new Set<string>();
  for (const m of src.matchAll(/path\.join\(OUT, "([a-z-]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*\["[^"]+", "([a-z-]+)"\],?$/gm)) names.add(m[1]);
  return [...names].sort();
}

function shEntries(): string[] {
  const m = /for entry in ([a-z -]+); do/.exec(read("../install.sh"));
  assert.ok(m, "install.sh: the `for entry in ...` copy loop was not found");
  return m[1].trim().split(/\s+/).sort();
}

function ps1Entries(): string[] {
  const m = /foreach \(\$entry in @\(([^)]*)\)\)/.exec(read("../install.ps1"));
  assert.ok(m, "install.ps1: the `foreach ($entry in @(...))` copy loop was not found");
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]).sort();
}

test("build.mjs's top-level entries are found", () => {
  assert.ok(bundleEntries().includes("bin"), bundleEntries().join(" "));
});

test("install.sh copies every directory the bundle has", () => {
  assert.deepEqual(shEntries(), bundleEntries());
});

test("install.ps1 copies every directory the bundle has", () => {
  assert.deepEqual(ps1Entries(), bundleEntries());
});
