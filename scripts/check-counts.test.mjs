// node --test scripts/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, countCatalog, findMarkers, parseCount } from "./check-counts.mjs";

const CATALOG = `
const e = () => ({});
export const CATALOG: CatalogEntry[] = [
  e("benchmark", "device", ["device", "machine"], "Prefill (and) decode, [sic] {x}.", "device.md", benchmark),
  // e("commented-out", ...) is not an entry
  fromManifest(enrolManifest as Manifest, "host.md"),
  /* reserved("also-not", ...) */
  e("web-test", "host", ["host"], "Playwright \\"suites\\", one, two.", "host.md", webTest, { dangerous: true }),
  reserved("serve", "host", ["host"], "Serve a model."),
];
export const OTHER = [e("not-in-catalog")];
`;

test("counts shipped and reserved entries, ignoring comments and strings", () => {
  assert.deepEqual(countCatalog(CATALOG), { shipped: 3, reserved: 1 });
});

test("an entry it cannot classify is an error, not a skip", () => {
  assert.throws(() => countCatalog("export const CATALOG = [\n  e('a'),\n  ...others,\n];"), /cannot tell/);
  assert.throws(() => countCatalog("export const NOPE = [];"), /no `export const CATALOG`/);
});

test("the real catalog parses", () => {
  const src = readFileSync(new URL("../collector/src/workloads/catalog.ts", import.meta.url), "utf8");
  const { shipped, reserved } = countCatalog(src);
  assert.ok(shipped > 0 && reserved >= 0);
});

test("numbers in digits and in words", () => {
  assert.equal(parseCount("34"), 34);
  assert.equal(parseCount("Thirty-four"), 34);
  assert.equal(parseCount("thirty four"), 34);
  assert.equal(parseCount("twelve"), 12);
  assert.equal(parseCount("Forty"), 40);
  assert.equal(parseCount("thirty-odd"), null);
  assert.equal(parseCount("many"), null);
});

test("markers find the number after them, with its line", () => {
  const text = "# Title\n\nThe collector ships <!-- count:workloads -->34 workloads.\n" +
    "<!-- count:workloads -->Thirty-four workloads, and\n" +
    "<!-- count:workloads -->thirty workloads\n";
  const marks = findMarkers(text);
  assert.deepEqual(marks.map((m) => [m.value, m.line]), [[34, 3], [34, 4], [30, 5]]);
});

test("a disagreeing, unreadable or unknown marker is a problem", () => {
  const files = [
    { path: "README.md", text: "<!-- count:workloads -->34 here\n<!-- count:workloads -->28 there\n" },
    { path: "docs/x.md", text: "<!-- count:workloads -->many\n<!-- count:runners -->5\n" },
  ];
  const { problems, seen } = check(files, { workloads: 34 });
  assert.equal(seen, 4);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /README\.md:2: says 28, but there are 34 workloads/);
  assert.match(problems[1], /docs\/x\.md:1: "many" .* is not a number/);
  assert.match(problems[2], /unknown count "runners"/);
});

test("no markers at all fails, so a deleted marker cannot pass silently", () => {
  const { problems } = check([{ path: "README.md", text: "34 workloads" }], { workloads: 34 });
  assert.match(problems[0], /no <!-- count/);
});
