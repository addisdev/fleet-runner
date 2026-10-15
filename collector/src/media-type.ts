/**
 * What an artifact's bytes are, from the bytes and the name it was uploaded
 * under.
 *
 * The store is content-addressed and kept no media type, so every reader
 * guessed: the MCP server sniffed PNG and JPEG magic numbers itself, and the
 * dashboard assumed. Recording one at upload means it is decided once, by the
 * party holding the most evidence -- the first chunk and the filename -- and
 * served with the bytes ever after.
 */

const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  zip: "application/zip",
  apk: "application/vnd.android.package-archive",
  ipa: "application/octet-stream",
  gz: "application/gzip",
  tgz: "application/gzip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  gguf: "application/octet-stream",
};

/** A media type a client asked for, if it is shaped like one. */
export function cleanMediaType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v) && v.length <= 100 ? v : null;
}

export function sniffMediaType(head: Uint8Array, name?: string | null): string {
  const b = head;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (b.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (b.length >= 3 && starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (b.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  if (b.length >= 5 && starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (b.length >= 2 && starts(0x1f, 0x8b)) return "application/gzip";

  const ext = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  // A zip is also an APK, an IPA, an xcresult bundle and a docx; the name says which.
  if (b.length >= 4 && starts(0x50, 0x4b, 0x03, 0x04)) return (ext && BY_EXTENSION[ext]) ?? "application/zip";
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];

  const sample = b.subarray(0, 4096);
  const text = sample.length > 0 && sample.every((c) => c === 9 || c === 10 || c === 13 || c >= 32);
  if (!text) return "application/octet-stream";
  const start = Buffer.from(sample).toString("utf8").trimStart();
  if (start.startsWith("{") || start.startsWith("[")) return "application/json";
  if (start.startsWith("<?xml") || start.startsWith("<testsuite")) return "application/xml";
  if (/^<!doctype html|^<html/i.test(start)) return "text/html";
  return "text/plain";
}

/** Whether a media type is one an agent can be shown as text. */
export const isTextual = (mediaType: string) =>
  mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml";
