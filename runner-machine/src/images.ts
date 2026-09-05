/**
 * Resizing an eval image to the shape the on-device models expect.
 *
 * The eval sets this fleet ships are "center-crop, resize 224, RGB" — that
 * string is in the plant-ID manifest and both runners' preprocessing assumes
 * it. Getting it wrong is not a crash: it is a model that scores four points
 * lower for a reason nobody can see, because a letterboxed image and a
 * center-cropped one are both 224×224 JPEGs.
 *
 * So the arithmetic is here, pure and tested, and the two resizers this agent
 * knows about are only ever handed the numbers it produces.
 */
import { which } from "./probe.js";

export type Resizer = { kind: "sips" | "magick"; bin: string };

/**
 * The intermediate size a center-crop needs: scale so the SHORT edge is
 * `size`, then take the middle `size`×`size`.
 *
 * Scaling the LONG edge to `size` instead — which is what `sips -Z` does on
 * its own, and the obvious one-liner — leaves the short edge under `size` and
 * forces a pad. A padded image is a smaller subject surrounded by background
 * the model has to look past, which is a different picture from the one the
 * eval set was scored on.
 */
export function resizeToShortEdge(w: number, h: number, size: number): { width: number; height: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`cannot resize an image reported as ${w}×${h}`);
  }
  const scale = size / Math.min(w, h);
  return {
    // Ceil, not round: a rounded-down edge lands one pixel short of `size` and
    // the crop that follows then has to pad the very row it was avoiding.
    width: Math.max(size, Math.ceil(w * scale)),
    height: Math.max(size, Math.ceil(h * scale)),
  };
}

/** `sips -g pixelWidth -g pixelHeight` output to numbers. */
export function parseSipsDims(text: string | null): { w: number; h: number } | null {
  if (!text) return null;
  const w = /pixelWidth:\s*(\d+)/.exec(text)?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(text)?.[1];
  if (!w || !h) return null;
  const dims = { w: Number(w), h: Number(h) };
  return dims.w > 0 && dims.h > 0 ? dims : null;
}

export function sipsDimArgs(src: string): string[] {
  return ["-g", "pixelWidth", "-g", "pixelHeight", src];
}

/**
 * sips: resample to the short-edge size, then crop the middle, in one call.
 *
 * `-c h w` on sips is a CENTERED crop, which is the whole reason the resample
 * has to come first — sips has no gravity flag, so the only way to choose what
 * survives the crop is to control what goes into it.
 */
export function sipsResizeArgs(
  src: string,
  dst: string,
  size: number,
  dims: { w: number; h: number },
): string[] {
  const fit = resizeToShortEdge(dims.w, dims.h, size);
  return [
    "-s", "format", "jpeg",
    "-s", "formatOptions", "high",
    "--resampleHeightWidth", String(fit.height), String(fit.width),
    "-c", String(size), String(size),
    src, "--out", dst,
  ];
}

/**
 * ImageMagick: the same two operations, and it needs no dimension probe
 * because `^` means "fit the SHORT edge" and `-extent` with a center gravity
 * is the crop.
 */
export function magickResizeArgs(src: string, dst: string, size: number): string[] {
  return [src, "-resize", `${size}x${size}^`, "-gravity", "center", "-extent", `${size}x${size}`, "-quality", "90", dst];
}

/**
 * The resizer this machine has, or null.
 *
 * sips first because it is on every Mac and needs nothing installed; magick
 * because a Linux box that has it can prepare a set the same way. A machine
 * with neither must not declare `dataset-prep` — a "prepared" set whose images
 * are still 4000 px wide is one the phone runners will resize themselves,
 * inconsistently and at eval time, which is exactly the variable this workload
 * exists to remove.
 */
export async function resolveResizer(env: NodeJS.ProcessEnv = process.env): Promise<Resizer | null> {
  const sips = await which("sips", env);
  if (sips) return { kind: "sips", bin: sips };
  for (const name of ["magick", "convert"]) {
    const bin = await which(name, env);
    if (bin) return { kind: "magick", bin };
  }
  return null;
}
