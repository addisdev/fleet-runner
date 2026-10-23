// node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coverage,
  headFromSubject,
  isDependabot,
  isReleasePr,
  mentionedNumbers,
  newestTag,
  prNumbersFromSubjects,
  releasedSection,
  releasePrsFromSubjects,
} from "./changelog-coverage.mjs";

test("merge commits and squash merges both count; passing mentions do not", () => {
  const subjects = [
    "Merge pull request #91 from addisdev/ci/never-run-list",
    "Release notes for 0.9.0",
    "Fix the thing (#90)",
    "Revert the fix from #12",
    "Merge branch 'develop' into feature",
    "Merge pull request #88 from addisdev/docs/0.8-catchup",
    "Merge pull request #91 from addisdev/ci/never-run-list",
  ];
  // git log is newest first; the list comes back oldest first, once each.
  assert.deepEqual(prNumbersFromSubjects(subjects), [88, 90, 91]);
});

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.9.0] — 2026-11-01

### Added

- **A thing.** ([#90](https://github.com/addisdev/fleet-runner/pull/90))
- **Another**, see #91.
- Not a PR: &#93; or issue#94.

## [0.8.0] — 2026-10-15

- **Old.** #88
`;

test("the section runs from [Unreleased] down to the last tag's heading", () => {
  const s = releasedSection(CHANGELOG, "0.8.0");
  assert.match(s, /^## \[Unreleased\]/);
  assert.match(s, /## \[0\.9\.0\]/);
  assert.doesNotMatch(s, /Old\./);
});

test("a changelog without the headings is an error, not a pass", () => {
  assert.throws(() => releasedSection("# Changelog\n", "0.8.0"), /Unreleased/);
  assert.throws(() => releasedSection("## [Unreleased]\n- x\n", "0.8.0"), /0\.8\.0/);
  // 0.8.0 must not match 0.8.01 or 0x8y0.
  assert.throws(() => releasedSection("## [Unreleased]\n## [0x8y0]\n", "0.8.0"), /0\.8\.0/);
});

test("#N and /pull/N are mentions; HTML entities and word#N are not", () => {
  const m = mentionedNumbers(releasedSection(CHANGELOG, "0.8.0"));
  assert.deepEqual([...m].sort(), [90, 91]);
});

test("missing PRs are listed; no-changelog and Dependabot are exempt", () => {
  const meta = new Map([
    [92, { labels: ["no-changelog"], author: "addisdev", title: "CI tweak" }],
    [93, { labels: [], author: "app/dependabot", title: "Bump x" }],
    [94, { labels: ["docs"], author: "addisdev", title: "Forgotten" }],
  ]);
  const { missing, exempt } = coverage({
    merged: [88, 90, 91, 92, 93, 94, 95],
    mentioned: new Set([90, 91, 88]),
    meta,
  });
  assert.deepEqual(missing.map((m) => m.number), [94, 95]);
  assert.equal(missing[0].title, "Forgotten");
  assert.deepEqual(exempt.map((e) => e.number), [92, 93]);
});

test("Dependabot is recognised however the API spells it", () => {
  for (const a of ["dependabot[bot]", "app/dependabot", "dependabot"]) assert.ok(isDependabot(a), a);
  for (const a of ["addisdev", "not-dependabot-really", ""]) assert.ok(!isDependabot(a), a);
});

test("the newest tag is chosen by version, not by string order", () => {
  assert.equal(newestTag(["v0.7.2", "v0.10.0", "v0.9.1"]), "v0.10.0");
  assert.equal(newestTag(["v1.0.0-rc.1", "v1.0.0", "v0.9.0"]), "v1.0.0");
  assert.equal(newestTag(["v1.0.0-rc.2", "v1.0.0-rc.10", "v0.9.0"]), "v1.0.0-rc.10");
  assert.equal(newestTag(["latest", "nightly"]), null);
});

test("the release's own pull requests are exempt, from the merge subject or from GitHub", () => {
  // 0.9.0: #98 was release/0.9.0 into develop and failed the develop -> main check.
  const subjects = [
    "Merge pull request #98 from addisdev/release/0.9.0",
    "Merge pull request #97 from addisdev/feat/dash-v1-client",
    "Merge pull request #80 from addisdev/develop",
    "Release 0.9.1 (#101)",
  ];
  assert.equal(headFromSubject(subjects[0]), "release/0.9.0");
  assert.equal(headFromSubject(subjects[3]), null);
  assert.deepEqual([...releasePrsFromSubjects(subjects)].sort(), [80, 98]);

  // A squash-merged release PR is only known from GitHub's head and base.
  const meta = new Map([
    [101, { labels: [], author: "addisdev", title: "Release 0.9.1", head: "release/0.9.1", base: "develop" }],
    [102, { labels: [], author: "addisdev", title: "Back-merge", head: "develop", base: "feat/x" }],
  ]);
  const { missing, exempt } = coverage({
    merged: [97, 98, 80, 101, 102],
    mentioned: new Set([97]),
    meta,
    release: releasePrsFromSubjects(subjects),
  });
  assert.deepEqual(exempt.map((e) => [e.number, e.why]), [[98, "release"], [80, "release"], [101, "release"]]);
  assert.deepEqual(missing.map((m) => m.number), [102]);
});

test("a release pull request is release/* into anything, or develop into main", () => {
  assert.ok(isReleasePr({ head: "release/0.9.0", base: "develop" }));
  assert.ok(isReleasePr({ head: "develop", base: "main" }));
  assert.ok(!isReleasePr({ head: "develop", base: "feat/x" }));
  assert.ok(!isReleasePr({ head: "feat/release-notes", base: "develop" }));
  assert.ok(!isReleasePr({}));
});
