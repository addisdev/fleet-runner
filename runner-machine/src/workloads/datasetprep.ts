/**
 * The `dataset-prep` workload: download an image set, resize it, drop the
 * duplicates, write a manifest, and publish the zip the eval workloads read.
 *
 * The output is not this file's invention. The Android runner's
 * VisionEvalEngine opens `manifest.json` at the zip root and walks
 * `items[].file` / `items[].label`, so that layout is a contract with code in
 * another repo — which is why the shape is built by `recipes.ts` and asserted
 * in the tests instead of being assembled inline here.
 *
 * Two things this adds beyond "unzip and hand it over":
 *
 * 1. **The licence travels with the data.** The plant set is CC-BY-SA, which
 *    is exactly why its images move through the artifact store rather than
 *    being committed. A prepared zip whose manifest has lost the attribution
 *    is a zip whose eval numbers can never be published, and by the time
 *    anyone notices, the provenance is a URL somebody half-remembers. So a
 *    prep with no licence is refused before a single image is resized.
 * 2. **The download is content-addressed on `source_url`.** Re-preparing the
 *    same set with a different recipe, or after a crash, must not pull
 *    gigabytes over somebody's home internet again.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, intParam, stringParam } from "../protocol.js";
import { dataDir } from "../git.js";
import { run, which } from "../probe.js";
import { Beaconer, lastMeaningful } from "../beaconing.js";
import {
  buildManifest, effectiveLicense, loadRecipe, outputName, type Recipe,
} from "../recipes.js";
import {
  magickResizeArgs, parseSipsDims, resolveResizer, sipsDimArgs, sipsResizeArgs, type Resizer,
} from "../images.js";

export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
/** A download that has not finished in two hours is a download that will not. */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** The cache key. The URL and nothing else: the same URL is the same set. */
export function cacheKey(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32);
}

/** http(s) only. A `file:` source would let an unauthenticated job read this disk. */
export function parseSourceUrl(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error("dataset-prep needs params.source_url");
  const s = v.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`params.source_url is not a URL: ${s.slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`params.source_url must be http or https (got ${u.protocol})`);
  }
  return s;
}

export async function runDatasetPrep(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (m: string) => console.log(`[${deviceId}] dataset-prep ${job.job_id}: ${m}`);
  const fail = async (error: string, metrics?: Metrics) => {
    log(`failed: ${error}`);
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor, error,
      ...(metrics ? { metrics } : {}),
    });
  };

  // Everything that can be refused without touching the network, first.
  let sourceUrl: string;
  let recipe: Recipe;
  let license: string;
  try {
    sourceUrl = parseSourceUrl(job.params?.source_url);
    recipe = await loadRecipe(job.params?.recipe, env);
    license = effectiveLicense(recipe, job.params?.license);
  } catch (e) {
    return fail((e as Error).message);
  }

  const resizer = await resolveResizer(env);
  if (!resizer) return fail("dataset-prep needs sips (macOS) or ImageMagick; neither resolves on this machine");
  const zipper = await which("zip", env);
  if (!zipper) return fail("dataset-prep needs `zip` to publish the prepared set");

  const beaconer = new Beaconer(client, deviceId, job.job_id);
  const key = cacheKey(sourceUrl);
  const cacheDir = path.join(dataDir(env), "datasets", key);
  const staging = path.join(cacheDir, "prepared", safe(job.job_id));
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  await mkdir(staging, { recursive: true });

  try {
    // --- download, content-addressed on the URL ---------------------------
    let extracted: string;
    try {
      extracted = await fetchAndExtract(sourceUrl, cacheDir, log);
    } catch (e) {
      return fail(`fetching ${sourceUrl} failed: ${(e as Error).message}`);
    }

    // --- the images, in a stable order ------------------------------------
    const limit = intParam(job.params, "max_items", 0);
    const all = (await walkImages(extracted)).sort();
    if (all.length === 0) return fail(`${sourceUrl} contained no images (looked for ${IMAGE_EXTS.join(", ")})`);
    const chosen = limit > 0 ? all.slice(0, limit) : all;
    log(`${all.length} image(s) found, preparing ${chosen.length} at ${recipe.size}px`);

    // --- resize, then deduplicate on the PREPARED bytes -------------------
    //
    // Deduplicating after the resize rather than before is the whole point: a
    // scraped set is full of the same photograph at three resolutions and two
    // JPEG qualities, which are different files and identical evidence.
    // Scoring a model twice on one image is how an eval set quietly weights
    // whatever was duplicated most.
    const seen = new Map<string, string>();
    const kept: string[] = [];
    const keptNames: string[] = [];
    let duplicates = 0;
    let failedImages = 0;

    for (const rel of chosen) {
      if (!(await beaconer.maybe())) {
        return fail("cancelled");
      }
      const src = path.join(extracted, rel);
      const tmp = path.join(staging, `.staging-${kept.length}.jpg`);
      const ok = await resizeOne(resizer, src, tmp, recipe.size);
      if (!ok) {
        failedImages += 1;
        continue;
      }
      const digest = await sha256File(tmp);
      const first = seen.get(digest);
      if (first !== undefined) {
        duplicates += 1;
        await rm(tmp, { force: true }).catch(() => {});
        continue;
      }
      seen.set(digest, rel);
      kept.push(rel);
      keptNames.push(tmp);
    }
    if (kept.length === 0) {
      return fail(`every one of the ${chosen.length} image(s) failed to resize; is ${resizer.bin} working?`);
    }

    // Names are assigned only once the final count is known, so the padding
    // width is right and the numbering has no gaps where a duplicate was.
    const names = kept.map((_, i) => outputName(i, kept.length));
    for (const [i, tmp] of keptNames.entries()) {
      await rename(tmp, path.join(staging, names[i]!));
    }

    // --- manifest ---------------------------------------------------------
    let manifestJson: string;
    try {
      const labelling = recipe.labels(kept.map(toPosix));
      const manifest = buildManifest({ recipe, source: sourceUrl, license, names, labelling });
      manifestJson = JSON.stringify(manifest, null, 1);
    } catch (e) {
      return fail(`recipe '${recipe.id}' could not label the set: ${(e as Error).message}`);
    }
    await writeFile(path.join(staging, "manifest.json"), manifestJson, "utf8");

    // --- zip and publish --------------------------------------------------
    const zipFile = path.join(cacheDir, `${safe(job.job_id)}.zip`);
    await rm(zipFile, { force: true }).catch(() => {});
    // `-X` drops the extra attributes that make an otherwise identical zip
    // differ byte for byte; `.` from inside the staging dir puts manifest.json
    // at the zip ROOT, which is where VisionEvalEngine looks for it.
    const zipped = await run(zipper, ["-q", "-r", "-X", zipFile, "."], 60 * 60 * 1000);
    if (zipped.code !== 0) {
      return fail(`zipping the prepared set failed: ${lastMeaningful(zipped.stderr || zipped.stdout) || `exit ${zipped.code}`}`, undefined);
    }

    const bytes = (await stat(zipFile)).size;
    let sha256: string;
    try {
      const up = await client.uploadArtifact(zipFile, `${recipe.id}-${kept.length}.zip`);
      sha256 = up.sha256;
    } catch (e) {
      return fail(`upload failed: ${(e as Error).message}`, compact<Metrics>({ items: kept.length, artifact_bytes: bytes }));
    }

    log(`published ${kept.length} item(s) as ${sha256} (${bytes} bytes; ${duplicates} duplicate(s), ${failedImages} unreadable)`);
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: true, device: descriptor,
      metrics: compact<Metrics>({ items: kept.length, artifact_bytes: bytes }),
      artifacts: [sha256],
      // Not in the result schema, deliberately, exactly as build's `build`
      // block: the collector stores a result's whole payload, and a prepared
      // set whose row cannot say what licence it carries is a row that puts
      // the attribution back where it was — nowhere anyone will look.
      dataset: {
        recipe: recipe.id, source: sourceUrl, license, sha256,
        items: kept.length, duplicates, unreadable: failedImages, size: recipe.size,
      },
    });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The extracted archive for a URL, downloading it only if the cache is cold.
 *
 * The blob is written to a `.part` and renamed, so an interrupted download can
 * never be mistaken for a complete one on the next run — the same discipline
 * `fetchArtifact` uses for its hash check.
 */
async function fetchAndExtract(sourceUrl: string, cacheDir: string, log: (m: string) => void): Promise<string> {
  const extracted = path.join(cacheDir, "extracted");
  if (existsSync(path.join(cacheDir, ".complete"))) {
    log("cache hit; not downloading");
    return extracted;
  }
  await mkdir(cacheDir, { recursive: true });
  const blob = path.join(cacheDir, "source.bin");
  if (!existsSync(blob)) {
    log(`downloading ${sourceUrl}`);
    const part = `${blob}.part`;
    const r = await run("curl", ["-fsSL", "--retry", "3", "-o", part, sourceUrl], DOWNLOAD_TIMEOUT_MS);
    if (r.code !== 0) {
      await rm(part, { force: true }).catch(() => {});
      throw new Error(lastMeaningful(r.stderr || r.stdout) || `curl exited ${r.code}`);
    }
    await rename(part, blob);
  }

  await rm(extracted, { recursive: true, force: true }).catch(() => {});
  await mkdir(extracted, { recursive: true });
  const isTar = /\.(tar\.gz|tgz|tar)$/i.test(new URL(sourceUrl).pathname);
  const r = isTar
    ? await run("tar", ["-xf", blob, "-C", extracted], DOWNLOAD_TIMEOUT_MS)
    : await run("unzip", ["-q", "-o", blob, "-d", extracted], DOWNLOAD_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`extracting failed: ${lastMeaningful(r.stderr || r.stdout) || `exit ${r.code}`}`);
  await writeFile(path.join(cacheDir, ".complete"), sourceUrl, "utf8");
  return extracted;
}

/** Every image under a directory, as paths relative to it. */
export async function walkImages(root: string, rel = "", depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
    const child = rel === "" ? e.name : path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await walkImages(root, child, depth + 1)));
    else if (IMAGE_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) out.push(child);
  }
  return out;
}

/** One image, center-cropped to a square. False when the tool could not read it. */
async function resizeOne(resizer: Resizer, src: string, dst: string, size: number): Promise<boolean> {
  if (resizer.kind === "magick") {
    const r = await run(resizer.bin, magickResizeArgs(src, dst, size), 120_000);
    return r.code === 0 && existsSync(dst);
  }
  // sips has no gravity flag, so the crop can only be centred by controlling
  // what goes into it — which needs the source's dimensions first.
  const dims = parseSipsDims((await run(resizer.bin, sipsDimArgs(src), 60_000)).stdout);
  if (!dims) return false;
  const r = await run(resizer.bin, sipsResizeArgs(src, dst, size, dims), 120_000);
  return r.code === 0 && existsSync(dst);
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

const toPosix = (p: string) => p.split(path.sep).join("/");
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
