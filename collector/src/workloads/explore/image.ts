/**
 * The pixel work the loop needs, done in-process with pngjs.
 *
 * Four jobs, all small:
 *
 *   - shrink a screenshot before it goes to the model, because a 1080x2400
 *     phone screen is 2.6 megapixels and the vendor's own Android runs were
 *     576x1280 (0.74 MP). Every image token is prompt time on every later step.
 *   - a perceptual hash, so "the screen did not change" and "this is the same
 *     screen as last night" can be asked without comparing bytes (a clock in
 *     the status bar changes the bytes every minute).
 *   - a blank-screen test: one colour edge to edge, which is what a screen that
 *     failed to render looks like.
 *   - a JPEG for the dashboard's live view, which is an MJPEG stream.
 *
 * Nothing here is clever. The downscale is a box filter, which is the right
 * filter for shrinking by a large factor and needs no library; the hash is a
 * difference hash over a 9x8 grey thumbnail.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";

const run = promisify(execFile);

type Raster = { width: number; height: number; data: Buffer };

export function decodePng(png: Buffer): Raster {
  const p = PNG.sync.read(png);
  return { width: p.width, height: p.height, data: p.data };
}

/** Average the source pixels that fall into each destination pixel. RGBA in, RGBA out. */
export function boxResize(src: Raster, w: number, h: number): Raster {
  const out = Buffer.alloc(w * h * 4);
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * The screenshot the model sees: at most `maxPixels`, aspect kept.
 *
 * Returns the original bytes untouched when it already fits, so a model that
 * wants full resolution (set maxPixels high) gets exactly what the device
 * produced. Coordinates are unaffected either way: the model answers in
 * 0-1000, which means the same point at any size.
 */
export function shrinkForModel(png: Buffer, maxPixels: number): { png: Buffer; width: number; height: number } {
  const src = decodePng(png);
  const px = src.width * src.height;
  if (px <= maxPixels) return { png, width: src.width, height: src.height };
  const k = Math.sqrt(maxPixels / px);
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const small = boxResize(src, w, h);
  const out = new PNG({ width: w, height: h });
  small.data.copy(out.data);
  return { png: PNG.sync.write(out), width: w, height: h };
}

/** 64-bit difference hash as 16 hex characters. */
export function dhash(png: Buffer): string {
  const t = boxResize(decodePng(png), 9, 8);
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = lum(t, x, y), b = lum(t, x + 1, y);
      bits += a > b ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const lum = (r: Raster, x: number, y: number) => {
  const i = (y * r.width + x) * 4;
  return 0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2];
};

/** Bits that differ between two dhashes; 0 is identical, under ~5 is "the same screen". */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Is this screen one flat colour?
 *
 * Measured on a 64-pixel-wide thumbnail with the top and bottom 6% cut off,
 * because the status and navigation bars are drawn by the system and are not
 * blank when the app is. A standard deviation of luminance under 3 (of 255) is
 * a screen nobody could read anything on.
 */
export function isBlank(png: Buffer): { blank: boolean; stddev: number } {
  const src = decodePng(png);
  const w = 64, h = Math.max(8, Math.round((64 * src.height) / src.width));
  const t = boxResize(src, w, h);
  const y0 = Math.floor(h * 0.06), y1 = Math.ceil(h * 0.94);
  let n = 0, sum = 0, sq = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const v = lum(t, x, y);
      n++; sum += v; sq += v * v;
    }
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return { blank: stddev < 3, stddev: Math.round(stddev * 10) / 10 };
}

/**
 * A JPEG for the live view, via sips (every executor host is a Mac).
 * Null when sips is missing or fails: the live view is a convenience and must
 * never cost a step.
 */
export async function toJpeg(png: Buffer, quality = 55): Promise<Buffer | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-jpeg-"));
  try {
    const src = path.join(dir, "f.png"), dst = path.join(dir, "f.jpg");
    writeFileSync(src, png);
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", "960", src, "--out", dst],
      { timeout: 10_000 });
    return readFileSync(dst);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
