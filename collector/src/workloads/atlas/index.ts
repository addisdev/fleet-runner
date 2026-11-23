// atlas: every screen of an app on one version, from the app's own screen walk.
//
// The lab does not learn each app's screens. Every app here already has a walk
// that visits them (a UI test in screenshot mode, run by a script in its repo),
// so the app's recipe names that command and the pattern its PNGs follow, and
// this workload runs it on one device, files the shots under the atlas's names
// (src/atlas.ts), diffs them against an earlier version, and copies the set to
// the NAS. The point is that one capture per version then serves the PR's
// `Lab:` line, the store screenshots, promo frames, the version diff and the
// largest-text overflow check, instead of each being captured on its own.
//
// One device per platform, on purpose: the atlas is a record of the app, not a
// device matrix. A job wanting both platforms is two jobs (they may run on
// different hosts, and the index merges them).
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { capturePlatform, diffDir, diffVersions, loadRecipe, storeAtlas, versionDir } from "../../atlas.js";
import { NoTargetsError } from "../../fleet-client.js";
import type { Job, WorkloadCtx } from "../types.js";

const home = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const p = (job.params ?? {}) as Record<string, unknown>;
  const checkout = typeof p.checkout === "string" ? home(p.checkout) : "";
  if (!checkout) throw new Error("atlas needs params.checkout: the app's repository on this host");
  if (!existsSync(checkout)) throw new Error(`params.checkout ${checkout} does not exist on ${ctx.host}`);
  const version = typeof p.version === "string" ? p.version : "";
  if (!version) throw new Error("atlas needs params.version: the version folder to file into");
  const recipeFile = path.join(checkout, typeof p.recipe === "string" ? p.recipe : "atlas.json");
  if (!existsSync(recipeFile)) throw new Error(`no recipe at ${recipeFile}; set params.recipe`);
  const recipe = loadRecipe(recipeFile);
  const platform = String(p.platform ?? job.app?.platform ?? "ios");
  if (!recipe.platforms[platform]) {
    throw new Error(`${path.basename(recipeFile)} has no platform ${platform} (it has ${Object.keys(recipe.platforms).join(", ")})`);
  }
  const root = home(typeof p.root === "string" ? p.root : "~/atlas");
  versionDir(root, recipe.app, version); // checks the names before anything runs
  if (typeof p.baseline === "string") versionDir(root, recipe.app, p.baseline);

  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new NoTargetsError(`no ${platform} targets matched this job`);
  const granted = job.targets?.exclusive ? await ctx.locks.acquire(job.job_id, targets.map((t) => t.id)) : null;
  const target = targets.find((t) => !granted || granted.has(t.id));

  let ok = false;
  try {
    if (!target) {
      await ctx.postResult({ job_id: job.job_id, device_id: targets[0].id, iter: 0, ok: true, error: "skipped: every matching device is held by another job" });
      ok = true;
      return;
    }
    const work = mkdtempSync(path.join(os.tmpdir(), "fleet-atlas-"));
    const r = await capturePlatform({
      recipe, platform, checkout, root, version, device: target.id, work,
      log: (l) => ctx.log(l),
      onTick: () => { ctx.postBeacon(job.job_id, target.id, {}).catch(() => {}); },
    });
    const artifacts: Record<string, string> = {};
    const metrics: Record<string, number> = { shots: r.entries.length, screens: new Set(r.entries.map((e) => e.screen)).size, capture_s: r.captureS };
    const notes: string[] = [];
    if (r.exit !== 0) notes.push(`the walk exited ${r.exit}`);
    if (r.leftOut.length) notes.push(`${r.leftOut.length} files the recipe does not name were left out`);
    if (r.index) {
      artifacts.index = await ctx.uploadArtifact(path.join(r.dir, "index.json"), `atlas-${recipe.app}-${version}-index.json`);
      artifacts.sheet = await ctx.uploadArtifact(path.join(r.dir, "index.html"), `atlas-${recipe.app}-${version}-index.html`);
      if (typeof p.baseline === "string") {
        const bdir = versionDir(root, recipe.app, p.baseline);
        if (existsSync(path.join(bdir, "index.json"))) {
          const out = diffDir(root, recipe.app, p.baseline, version);
          const d = diffVersions(bdir, r.dir, out, { thresholdPct: typeof p.threshold_pct === "number" ? p.threshold_pct : undefined, only: platform });
          metrics.changed = d.counts.changed + d.counts.resized + d.counts.new + d.counts.gone;
          artifacts.diff = await ctx.uploadArtifact(path.join(out, "diff.json"), `atlas-${recipe.app}-${p.baseline}-${version}-diff.json`);
        } else {
          notes.push(`no ${p.baseline} in ${root} to diff against`);
        }
      }
      if (typeof p.store === "string") {
        const s = await storeAtlas(r.dir, recipe.app, version, p.store, typeof p.catalog === "string" ? p.catalog : undefined);
        notes.push(`stored at ${s.dest} (${s.verified} verified)`);
      }
    }
    ok = r.entries.length > 0 && r.exit === 0;
    await ctx.postResult({
      job_id: job.job_id, device_id: target.id, iter: 0, ok, metrics, artifacts,
      ...(notes.length ? { error: (r.entries.length === 0 ? "the walk wrote no shots; " : "") + notes.join("; ") } : {}),
    });
    ctx.log(`atlas ${recipe.app} ${version} ${platform}: ${r.entries.length} shots in ${r.captureS} s${notes.length ? ` (${notes.join("; ")})` : ""}`);
  } finally {
    if (granted) await ctx.locks.release(job.job_id);
    await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok });
  }
}
