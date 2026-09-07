#!/usr/bin/env node
/**
 * One version across every component.
 *
 *   node scripts/version.mjs            # print what each component says
 *   node scripts/version.mjs check      # exit 1 if any of them disagree
 *   node scripts/version.mjs set 0.5.0  # write it everywhere
 *
 * ## Why this exists
 *
 * The changelog's first paragraph says it plainly:
 *
 *   > One version covers all four components. They ship no shared code, only a
 *   > JSON protocol -- and that protocol is the thing that changes, so it is the
 *   > thing the version tracks.
 *
 * Nothing enforced it. At the time this was written the changelog was at 0.4.0,
 * the collector and the desktop agent both said 0.1.0, the Android runner said
 * 0.2.0, and the iOS runner said `1.0` -- not because anybody chose 1.0, but
 * because `GENERATE_INFOPLIST_FILE` supplies that when no target sets
 * `MARKETING_VERSION`, and no target did.
 *
 * That number is not decoration. Every agent sends `app_ver` in its descriptor
 * on every registration, so it is the field you read when a device starts
 * behaving differently from the one beside it, and it is what a `targets.match`
 * would select on to keep a job away from a runner too old to run it. Four
 * components claiming four unrelated versions makes that field useless.
 *
 * ## No package.json at the root, on purpose
 *
 * This is plain Node with no dependencies, because the repository root is not a
 * package and should not become one to hold a script. Four components, four
 * `npm install`s, and a root package.json would immediately start collecting
 * dependencies that belong to one of them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "VERSION");

/**
 * Where a version lives, and how to read and write it.
 *
 * Every entry is a regex with one capture group rather than a parser, and each
 * one is anchored to enough surrounding text that it cannot match something
 * else in the same file. A pattern that stops matching has to be a failure
 * rather than a silent skip, or this check quietly stops checking -- which is
 * the same trap the workload-icon check in collector/scripts/test.ts documents.
 */
const SITES = [
  { file: "collector/package.json", re: /("version":\s*")([^"]+)(")/ },
  { file: "collector/dash/package.json", re: /("version":\s*")([^"]+)(")/ },
  { file: "runner-machine/package.json", re: /("version":\s*")([^"]+)(")/ },
  // The descriptor's `app_ver`, which is what the collector actually stores.
  { file: "runner-machine/src/descriptor.ts", re: /(export const APP_VER = ")([^"]+)(")/ },
  // The browser runner is one HTML file with no build step, so its version is a
  // constant in the page rather than anything derived.
  { file: "collector/runner-web/index.html", re: /(const APP_VER = ")([^"]+)(")/ },
  { file: "runner-android/app/build.gradle.kts", re: /(versionName = ")([^"]+)(")/ },
  // Three Apple targets share one source tree and each needs its own
  // MARKETING_VERSION; the pattern is global below.
  { file: "runner-ios/project.yml", re: /(MARKETING_VERSION: ")([^"]+)(")/g },
];

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

/** Every version string a file declares. More than one only for project.yml. */
function versionsIn(site) {
  const src = read(site.file);
  const found = site.re.global
    ? [...src.matchAll(site.re)].map((m) => m[2])
    : [(src.match(site.re) ?? [])[2]].filter((v) => v !== undefined);
  if (found.length === 0) {
    throw new Error(`${site.file}: no version matched ${site.re} -- this script needs updating`);
  }
  return found;
}

function declared() {
  return SITES.map((site) => ({ file: site.file, versions: versionsIn(site) }));
}

function wanted() {
  const raw = readFileSync(VERSION_FILE, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw)) {
    throw new Error(`VERSION holds ${JSON.stringify(raw)}, which is not a semantic version`);
  }
  return raw;
}

function set(next) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
    console.error(`not a semantic version: ${next}`);
    process.exit(2);
  }
  writeFileSync(VERSION_FILE, `${next}\n`);
  for (const site of SITES) {
    const file = path.join(ROOT, site.file);
    const src = readFileSync(file, "utf8");
    // Checked before writing: a pattern that no longer matches would leave the
    // file untouched and report success, which is exactly the drift this exists
    // to prevent.
    versionsIn(site);
    writeFileSync(file, src.replace(site.re, `$1${next}$3`));
    console.log(`  ${site.file}`);
  }
  // Android's versionCode is an integer the Play Store orders by and cannot be
  // derived from a semantic version without inventing a scheme; it is bumped by
  // hand and deliberately not touched here.
  console.log(`\nset to ${next}. runner-android's versionCode is not derived from this and was left alone.`);
}

const [, , cmd, arg] = process.argv;

if (cmd === "set") {
  if (!arg) {
    console.error("usage: node scripts/version.mjs set <version>");
    process.exit(2);
  }
  set(arg);
} else {
  const want = wanted();
  const rows = declared();
  let bad = false;
  console.log(`VERSION says ${want}\n`);
  for (const { file, versions } of rows) {
    for (const v of versions) {
      const ok = v === want;
      if (!ok) bad = true;
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${v.padEnd(12)} ${file}`);
    }
  }
  if (cmd === "check") {
    if (bad) {
      console.error(
        "\nComponents disagree about the version. `node scripts/version.mjs set " +
          want +
          "` writes VERSION everywhere, or edit VERSION if the number itself is what changed.",
      );
      process.exit(1);
    }
    console.log("\nversion: ALL PASS");
  }
}
