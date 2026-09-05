/**
 * Reading a zip's central directory, without a dependency.
 *
 * An APK is a zip and an iOS artifact is a zip of a .app, so "how big is this
 * build, and what is big inside it" is a question about a zip. Three ways to
 * answer it were available and two are worse:
 *
 * Shelling out to `unzip -l` works on the two hosts this fleet has and not on
 * Windows, and it means parsing a human-readable table whose column widths
 * change with the longest filename in the archive.
 *
 * Adding a zip library means adding a dependency to a collector whose deploy
 * story is "rebuildable over SSH with nobody at the keyboard", for sixty lines
 * of well-specified structure.
 *
 * So: the central directory, read from the end of the file. It is the only part
 * of a zip that lists every entry with both its compressed and uncompressed
 * size, which is exactly the pair a size report needs — the uncompressed number
 * is what lands on the device, the compressed one is what a user downloads, and
 * quoting one when somebody meant the other is the usual way a size report
 * misleads.
 *
 * The iOS runner has `MiniZip.swift` for the same reason on the other side.
 */
import { readFileSync, statSync } from "node:fs";

export type ZipEntry = {
  name: string;
  /** Bytes on disk after installation. */
  uncompressed: number;
  /** Bytes in the archive, which is roughly what a user downloads. */
  compressed: number;
};

/** "End of central directory" record signature, and the fields we need from it. */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
/** Zip64 locator and record, for archives past the 4 GiB / 65535-entry limits. */
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

/**
 * Find the end-of-central-directory record.
 *
 * It is at the end of the file, but a zip comment can follow it, so the last
 * 64 KiB + 22 bytes have to be scanned backwards for the signature. Searching
 * backwards rather than forwards matters: the signature can legitimately occur
 * inside compressed data, and the LAST one is the real record.
 */
function findEocd(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return null;
}

/**
 * Every entry in the archive.
 *
 * Throws with a reason rather than returning a partial list: a size report
 * built from half an archive is worse than no size report, because it looks
 * exactly like a build that got smaller.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd === null) throw new Error("not a zip: no end-of-central-directory record in the last 64 KiB");

  let entryCount = buf.readUInt16LE(eocd + 10);
  let cenOffset = buf.readUInt32LE(eocd + 16);

  // Zip64. The 32-bit fields saturate at 0xffff / 0xffffffff and the real
  // values live in a separate record; an APK with more than 65535 entries is
  // unusual but a .app bundle zip with one is not.
  if (entryCount === 0xffff || cenOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        entryCount = Number(buf.readBigUInt64LE(z64 + 32));
        cenOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = cenOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`zip central directory ended after ${i} of ${entryCount} entries`);
    }
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, compressed, uncompressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipFile(file: string): { entries: ZipEntry[]; fileBytes: number } {
  return { entries: readZipEntries(readFileSync(file)), fileBytes: statSync(file).size };
}

export type SizeGroup = { group: string; bytes: number; download_bytes: number; entries: number };

export type SizeSummary = {
  /** The archive on disk. What CI publishes and what an artifact store holds. */
  file_bytes: number;
  /** Everything unpacked. Roughly what the build occupies once installed. */
  installed_bytes: number;
  /** The sum of compressed entries: closer to what a user waits for. */
  download_bytes: number;
  entries: number;
  /** Biggest-first, so the answer to "why did it grow" is the top of the list. */
  groups: SizeGroup[];
  largest: ZipEntry[];
};

/**
 * Which bucket an entry belongs to.
 *
 * Native libraries are grouped per ABI rather than lumped into `lib/`, because
 * that is the single most common answer to "why is this APK 40 MB" and the one
 * a flat top-level grouping hides: `lib/` being huge tells you nothing you did
 * not know, while `lib/arm64-v8a` being 18 MB of it tells you what to split.
 *
 * Everything else groups by its first path segment, which is what the platforms
 * themselves organise by.
 */
export function groupOf(name: string): string {
  const parts = name.split("/");
  if (parts[0] === "lib" && parts.length > 2) return `lib/${parts[1]}`;
  if (parts.length === 1) return "(root)";
  // A .app zip has everything under `Foo.app/`, which would make one group of
  // the whole archive. Reach one level in when that is the shape.
  if (parts[0].endsWith(".app") && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

export function summariseZip(entries: ZipEntry[], fileBytes: number, topN = 10): SizeSummary {
  const groups = new Map<string, SizeGroup>();
  for (const e of entries) {
    // Directory records have a trailing slash and zero size; counting them
    // inflates the entry count with things that are not files.
    if (e.name.endsWith("/")) continue;
    const key = groupOf(e.name);
    const g = groups.get(key) ?? { group: key, bytes: 0, download_bytes: 0, entries: 0 };
    g.bytes += e.uncompressed;
    g.download_bytes += e.compressed;
    g.entries += 1;
    groups.set(key, g);
  }
  const files = entries.filter((e) => !e.name.endsWith("/"));
  return {
    file_bytes: fileBytes,
    installed_bytes: files.reduce((a, e) => a + e.uncompressed, 0),
    download_bytes: files.reduce((a, e) => a + e.compressed, 0),
    entries: files.length,
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
    largest: [...files].sort((a, b) => b.uncompressed - a.uncompressed).slice(0, topN),
  };
}
