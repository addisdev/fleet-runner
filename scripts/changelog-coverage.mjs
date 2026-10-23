#!/usr/bin/env node
/**
 * Every pull request in a release is in its changelog.
 *
 *   node scripts/changelog-coverage.mjs [--head <ref>] [--tag <vX.Y.Z>]
 *
 * Lists the pull requests merged into `develop` since the last `v*` tag and
 * fails, naming each one, if the changelog section being released does not
 * mention it as `#N` or `/pull/N`. A pull request labelled `no-changelog`, any
 * opened by Dependabot, and the release's own pull requests -- `release/*`
 * into `develop`, `develop` into `main` -- are exempt. The last were not, and
 * 0.9.0's `release/0.9.0` pull request (#98) failed its own `develop` -> `main`
 * check and had to be labelled by hand: a release is not a change to note.
 *
 * ## Why
 *
 * 0.8.0 shipped with notes that left out work merged before it was cut --
 * exploratory QA among it -- and nobody noticed until an audit read the
 * history against the notes a day later. The changelog had to be amended after
 * the release. A list of merged pull requests is cheap to compute and a human
 * reading a long `[Unreleased]` section is not a reliable diff.
 *
 * ## What "since the last tag" means
 *
 * The commits on `<head>`'s first-parent chain that the newest `v*` tag does
 * not contain. On a `release/*` branch cut from `develop`, and on the
 * `develop` -> `main` pull request, that chain is `develop`'s own history, so
 * its merge commits are exactly the pull requests merged into `develop` since
 * the tag. Both a merge commit (`Merge pull request #N from ...`) and a squash
 * merge (`Title (#N)`) are recognised.
 *
 * ## What "the section being released" means
 *
 * Everything from `## [Unreleased]` down to the heading of the last tag's
 * version. CONTRIBUTING.md has a release rename `[Unreleased]` to the new
 * version and add an empty `[Unreleased]` above it, and before that rename the
 * notes are all under `[Unreleased]`; this range is right either way.
 *
 * Labels and authors are read from the GitHub API with `gh` (GH_TOKEN in CI),
 * and only for the pull requests the changelog does not mention, so a
 * complete changelog needs no network at all.
 *
 * Plain Node, no dependencies, like scripts/version.mjs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXEMPT_LABEL = "no-changelog";
/** `dependabot[bot]` from the REST API, `app/dependabot` from `gh pr view`. */
export const isDependabot = (author) => /(^|\/)dependabot(-preview)?(\[bot\])?$/.test(author ?? "");

/** A pull request that is the release itself: `release/*` into anything, or `develop` into `main`. */
export const isReleasePr = ({ head, base } = {}) =>
  /^release\//.test(head ?? "") || (head === "develop" && (base === undefined || base === "main"));

/**
 * The branch a GitHub merge commit merged, from its subject
 * (`Merge pull request #98 from addisdev/release/0.9.0` -> `release/0.9.0`),
 * or null for a squash merge, whose subject does not say.
 */
export function headFromSubject(subject) {
  const m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  return m ? m[1] : null;
}

/** The release pull requests among merge commit subjects, by number, without asking GitHub. */
export function releasePrsFromSubjects(subjects) {
  const out = new Set();
  for (const s of subjects) {
    const head = headFromSubject(s);
    if (head && isReleasePr({ head })) out.add(Number(/#(\d+)/.exec(s)[1]));
  }
  return out;
}

/**
 * Pull request numbers from commit subjects, oldest first, without repeats.
 *
 * Only subjects that look like GitHub's own merge commits count. A commit that
 * merely mentions `#12` in passing ("revert the fix from #12") is not a pull
 * request being merged, and listing it would make the check cry wolf.
 */
export function prNumbersFromSubjects(subjects) {
  const seen = new Set();
  const out = [];
  for (const s of subjects) {
    const m = /^Merge pull request #(\d+) from /.exec(s) ?? /\(#(\d+)\)\s*$/.exec(s);
    if (!m) continue;
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.reverse();
}

/**
 * The text from `## [Unreleased]` to the heading for `sinceVersion`.
 *
 * Throws when either heading is missing: a changelog this cannot read is a
 * changelog this cannot check, and passing would be a lie.
 */
export function releasedSection(changelog, sinceVersion) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  if (start < 0) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading");
  const escaped = sinceVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const endRe = new RegExp(`^## \\[${escaped}\\]`);
  const end = lines.findIndex((l, i) => i > start && endRe.test(l));
  if (end < 0) {
    throw new Error(`CHANGELOG.md has no \`## [${sinceVersion}]\` heading below [Unreleased]`);
  }
  return lines.slice(start, end).join("\n");
}

/** Pull request numbers a section mentions, as `#N` or as a `/pull/N` link. */
export function mentionedNumbers(section) {
  const found = new Set();
  for (const m of section.matchAll(/(?:^|[^\w&])#(\d+)\b/g)) found.add(Number(m[1]));
  for (const m of section.matchAll(/\/pull\/(\d+)\b/g)) found.add(Number(m[1]));
  return found;
}

/**
 * The verdict, given everything already fetched.
 *
 * `meta` maps a pull request number to `{ labels: string[], author: string,
 * head?: string, base?: string }` for the ones that needed looking up; a
 * number with no entry is treated as unlabelled, so a lookup that failed fails
 * the check rather than excusing it. `release` holds the numbers already known
 * to be release pull requests from their merge commits.
 */
export function coverage({ merged, mentioned, meta = new Map(), release = new Set() }) {
  const missing = [];
  const exempt = [];
  for (const n of merged) {
    if (mentioned.has(n)) continue;
    const m = meta.get(n);
    if (release.has(n) || (m && isReleasePr(m))) {
      exempt.push({ number: n, why: "release" });
      continue;
    }
    if (m && (m.labels.includes(EXEMPT_LABEL) || isDependabot(m.author))) {
      exempt.push({ number: n, why: m.labels.includes(EXEMPT_LABEL) ? EXEMPT_LABEL : m.author });
      continue;
    }
    missing.push({ number: n, title: m?.title ?? "" });
  }
  return { missing, exempt };
}

/** The newest `v*` tag by version order, or null. */
export function newestTag(tags) {
  const parsed = tags
    .map((t) => ({ t, m: /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(t.trim()) }))
    .filter((x) => x.m);
  parsed.sort((a, b) => {
    for (let i = 1; i <= 3; i++) {
      const d = Number(b.m[i]) - Number(a.m[i]);
      if (d) return d;
    }
    // 1.0.0 is newer than 1.0.0-rc.1.
    if (!a.m[4] !== !b.m[4]) return a.m[4] ? 1 : -1;
    return (b.m[4] ?? "").localeCompare(a.m[4] ?? "", undefined, { numeric: true });
  });
  return parsed[0]?.t.trim() ?? null;
}

// --- the command ------------------------------------------------------------

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function prMeta(numbers) {
  const meta = new Map();
  for (const n of numbers) {
    try {
      const json = execFileSync(
        "gh",
        ["pr", "view", String(n), "--json", "labels,author,title,headRefName,baseRefName"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const pr = JSON.parse(json);
      meta.set(n, {
        labels: (pr.labels ?? []).map((l) => l.name),
        author: pr.author?.login ?? "",
        title: pr.title ?? "",
        head: pr.headRefName ?? "",
        base: pr.baseRefName ?? "",
      });
    } catch (e) {
      console.error(`  could not read #${n} from GitHub (${(e.stderr || e.message || "").toString().trim()}); treating it as unlabelled`);
    }
  }
  return meta;
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const head = flag("--head") ?? "HEAD";
  const tag = flag("--tag") ?? newestTag(git("tag", "--list", "v*").split("\n").filter(Boolean));
  if (!tag) {
    console.error("no v* tag in this checkout. In CI, check out with fetch-depth: 0 so the tags come too.");
    return 1;
  }
  const version = tag.replace(/^v/, "");

  const subjects = git("log", "--first-parent", "--format=%s", `${tag}..${head}`).split("\n").filter(Boolean);
  const merged = prNumbersFromSubjects(subjects);

  let section;
  try {
    section = releasedSection(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), version);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const mentioned = mentionedNumbers(section);
  const release = releasePrsFromSubjects(subjects);
  const unmentioned = merged.filter((n) => !mentioned.has(n) && !release.has(n));
  const { missing, exempt } = coverage({ merged, mentioned, meta: prMeta(unmentioned), release });

  console.log(`${merged.length} pull request(s) merged since ${tag}: ${merged.map((n) => `#${n}`).join(" ") || "none"}`);
  for (const e of exempt) console.log(`  exempt  #${e.number} (${e.why})`);
  if (missing.length === 0) {
    console.log(`every one is in the changelog between [Unreleased] and [${version}]`);
    return 0;
  }
  console.error(`\nnot mentioned in CHANGELOG.md between [Unreleased] and [${version}]:`);
  for (const m of missing) console.error(`  #${m.number}${m.title ? `  ${m.title}` : ""}`);
  console.error(
    `\nAdd each to the section being released (as #N or a /pull/N link), or label it ` +
      `\`${EXEMPT_LABEL}\` if nobody using Fleet Runner would notice it.`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
