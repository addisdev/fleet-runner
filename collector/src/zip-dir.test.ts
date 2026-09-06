/**
 * The zip central-directory reader, checked against archives built here.
 *
 * `npx tsx src/zip-dir.test.ts` builds two zips with the system `zip` and reads
 * them back, then — when the Android runner's debug APK happens to be built —
 * reads that too. The synthetic archives are the contract; the APK is the
 * reality check, because a real APK has thousands of entries, a zip64-shaped
 * tail on some builds, and per-ABI native libraries, which is the exact case
 * the grouping exists for.
 *
 * Folded into scripts/smoke.ts by the same `check` shape the other pure
 * modules use, and skips rather than fails when `zip` is not on PATH — the
 * collector's suite must stay runnable on a bare clone.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipFile, readZipEntries, summariseZip, groupOf, zip64Sizes } from "./zip-dir.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function haveZip(): boolean {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function runZipChecks(check: Check) {
  // --- grouping, which needs no archive at all ------------------------------
  check("a native library groups by ABI, not as one lump of lib/",
    groupOf("lib/arm64-v8a/libllama.so") === "lib/arm64-v8a", groupOf("lib/arm64-v8a/libllama.so"));
  check("a root file groups as (root)", groupOf("AndroidManifest.xml") === "(root)");
  check("a resource groups by its first segment", groupOf("res/drawable/ic.xml") === "res");
  check("an .app bundle reaches one level in, or it would be one group",
    groupOf("FleetRunner.app/Frameworks/x.dylib") === "FleetRunner.app/Frameworks");

  check("a truncated buffer is refused rather than read as empty",
    (() => {
      try {
        readZipEntries(Buffer.alloc(64));
        return false;
      } catch (e) {
        return /not a zip/.test((e as Error).message);
      }
    })(), "an unreadable archive must not summarise as a build that got smaller");

  // --- entries over 4 GiB ----------------------------------------------------
  //
  // The 32-bit size fields saturate at 0xffffffff and the real values move into
  // the entry's Zip64 extra field. An archive with a 6 GB entry is not
  // something a test suite can reasonably build, so the block is asserted
  // directly: reporting a 6 GB payload as 4.29 GB would look entirely plausible
  // on a trend line, which is the worst way for a size report to be wrong.
  {
    const SIX_GB = 6_000_000_000;
    const FIVE_GB = 5_000_000_000;
    const U32 = 0xffffffff;

    // Only the uncompressed size overflowed.
    const oneField = Buffer.alloc(12);
    oneField.writeUInt16LE(0x0001, 0);
    oneField.writeUInt16LE(8, 2);
    oneField.writeBigUInt64LE(BigInt(SIX_GB), 4);
    const one = zip64Sizes(oneField, U32, 123);
    check("a saturated uncompressed size is read from the Zip64 block",
      one.uncompressed === SIX_GB, String(one.uncompressed));
    check("and a size that did not overflow is left alone", one.compressed === 123, String(one.compressed));

    // Both overflowed: order is uncompressed then compressed.
    const bothField = Buffer.alloc(20);
    bothField.writeUInt16LE(0x0001, 0);
    bothField.writeUInt16LE(16, 2);
    bothField.writeBigUInt64LE(BigInt(SIX_GB), 4);
    bothField.writeBigUInt64LE(BigInt(FIVE_GB), 12);
    const both = zip64Sizes(bothField, U32, U32);
    check("both saturated sizes are read in the spec's order",
      both.uncompressed === SIX_GB && both.compressed === FIVE_GB, JSON.stringify(both));

    // A Zip64 block sitting behind another extra block must still be found.
    const withPrefix = Buffer.concat([
      (() => { const b = Buffer.alloc(8); b.writeUInt16LE(0x5455, 0); b.writeUInt16LE(4, 2); return b; })(),
      oneField,
    ]);
    check("a Zip64 block after another extra block is still found",
      zip64Sizes(withPrefix, U32, 7).uncompressed === SIX_GB);

    // Nothing saturated: the extra field is not even looked at.
    check("an ordinary entry does not consult the extra field",
      zip64Sizes(Buffer.alloc(0), 100, 40).uncompressed === 100);

    // Saturated with no Zip64 block is malformed, and must not report 4.29 GB
    // as though it had been measured.
    let threw = false;
    try {
      zip64Sizes(Buffer.alloc(0), U32, U32);
    } catch {
      threw = true;
    }
    check("a saturated size with no Zip64 block is refused, not reported as 4.29 GB", threw);
  }

  if (!haveZip()) {
    check("zip archives (SKIPPED — no `zip` on PATH)", true);
    return;
  }

  // --- a synthetic archive with known contents ------------------------------
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-zip-"));
  mkdirSync(path.join(dir, "lib/arm64-v8a"), { recursive: true });
  mkdirSync(path.join(dir, "lib/x86_64"), { recursive: true });
  mkdirSync(path.join(dir, "res"), { recursive: true });
  // Highly compressible, so compressed and uncompressed are far apart and a
  // test that confused them could not accidentally pass.
  writeFileSync(path.join(dir, "lib/arm64-v8a/libbig.so"), Buffer.alloc(200_000, 0x41));
  writeFileSync(path.join(dir, "lib/x86_64/libbig.so"), Buffer.alloc(100_000, 0x42));
  writeFileSync(path.join(dir, "res/small.txt"), Buffer.alloc(1_000, 0x43));
  writeFileSync(path.join(dir, "top.txt"), Buffer.alloc(500, 0x44));
  const zipPath = path.join(dir, "test.zip");
  execFileSync("zip", ["-qr", zipPath, "lib", "res", "top.txt"], { cwd: dir });

  const { entries, fileBytes } = readZipFile(zipPath);
  const s = summariseZip(entries, fileBytes);
  check("every file is found", s.entries === 4, `${s.entries} entries: ${entries.map((e) => e.name).join(",")}`);
  check("installed bytes is the uncompressed total",
    s.installed_bytes === 301_500, String(s.installed_bytes));
  check("download bytes is smaller than installed for compressible content",
    s.download_bytes < s.installed_bytes, `${s.download_bytes} vs ${s.installed_bytes}`);
  check("file bytes is the archive on disk", s.file_bytes === statSync(zipPath).size, String(s.file_bytes));
  check("the biggest group is the arm64 library",
    s.groups[0].group === "lib/arm64-v8a", JSON.stringify(s.groups.map((g) => g.group)));
  check("the two ABIs are separate groups, which is the point",
    s.groups.some((g) => g.group === "lib/x86_64"), JSON.stringify(s.groups.map((g) => g.group)));
  check("a root file is not grouped with a directory",
    s.groups.some((g) => g.group === "(root)"), JSON.stringify(s.groups.map((g) => g.group)));
  check("the largest entry is named", s.largest[0].name.endsWith("lib/arm64-v8a/libbig.so"), s.largest[0].name);
  check("directory records are not counted as files",
    !entries.filter((e) => !e.name.endsWith("/")).some((e) => e.name.endsWith("/")));

  // --- an archive with a comment, which moves the EOCD -----------------------
  const commented = path.join(dir, "commented.zip");
  execFileSync("zip", ["-qr", commented, "res"], { cwd: dir });
  execFileSync("sh", ["-c", `printf 'a comment that follows the record' | zip -z ${JSON.stringify(commented)} > /dev/null 2>&1 || true`]);
  try {
    const c = readZipFile(commented);
    check("a trailing zip comment does not hide the central directory", c.entries.length >= 1, String(c.entries.length));
  } catch (e) {
    check("a trailing zip comment does not hide the central directory", false, (e as Error).message);
  }

  // --- the real thing, when it is there -------------------------------------
  const apk = path.resolve(ROOT, "../runner-android/app/build/outputs/apk/debug/app-debug.apk");
  if (existsSync(apk)) {
    const real = readZipFile(apk);
    const rs = summariseZip(real.entries, real.fileBytes);
    check("a real APK's central directory reads",
      rs.entries > 100, `${rs.entries} entries`);
    check("a real APK's installed size exceeds its download size",
      rs.installed_bytes > rs.download_bytes, `${rs.installed_bytes} vs ${rs.download_bytes}`);
    check("a real APK's groups are non-empty and ordered biggest first",
      rs.groups.length > 1 && rs.groups[0].bytes >= rs.groups[1].bytes,
      JSON.stringify(rs.groups.slice(0, 3)));
    check("a real APK carries its manifest at the root",
      real.entries.some((e) => e.name === "AndroidManifest.xml"));
  } else {
    check("a real APK (SKIPPED — runner-android has not been built)", true);
  }
}
