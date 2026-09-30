// install: put a build on every device this job selected.
//
// The simplest workload in the fleet, and the one everything else depends on —
// a ui-test, a drain and a cold-start all assume somebody installed the build
// first. It fetches the artifact once, on the host, and pushes the same file to
// each target rather than downloading per device.
//
// One result row per device, failures included, then a final row that is ok
// only if every install was. A device that refused the install is a result, not
// an exception: the other nine phones installed it and the job should say so.
//
// How it installs is no longer this file's business. It used to hold the
// three-way branch between `adb install`, `devicectl device install app` and
// `simctl install`, keyed on the app's platform and the target's kind — which
// meant adding a platform meant editing a workload that has nothing to do with
// platforms. The target now names the driver that found it, and the driver
// installs. Adding tvOS took zero lines here.
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, NoTargetsError } from "../../fleet-client.js";
import { driverNamed } from "../../drivers/index.js";
import type { Job, WorkloadCtx } from "../types.js";

/**
 * Platforms whose artifact is a zipped bundle rather than a single file.
 *
 * Every Apple platform ships a `.app`, which is a directory, and a directory
 * cannot be an artifact — so the store holds a zip and this unpacks it. The
 * list is by platform rather than by driver because it is a fact about the
 * BUILD, not about how the device is reached: the same zip installs onto a
 * simulator through simctl and onto hardware through devicectl.
 */
const BUNDLE_PLATFORMS = new Set(["ios", "tvos", "watchos", "visionos", "macos", "catalyst"]);

/**
 * Fetch a build once and return the path a driver installs from: the `.apk`
 * itself, or the `.app` unpacked from an Apple platform's zip.
 *
 * Exported because `ui-test` needs it too. A ui-test that names a build has to
 * test THAT build, not whatever happened to be installed on the phone already.
 */
export async function prepareInstallable(
  app: NonNullable<Job["app"]>,
  fetchArtifact: WorkloadCtx["fetchArtifact"],
): Promise<string> {
  const platform = app.platform ?? "android";
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-"));
  if (BUNDLE_PLATFORMS.has(platform)) {
    const zip = path.join(dir, `${app.name}.zip`);
    await fetchArtifact(app.sha256, zip);
    await exec("ditto", ["-x", "-k", zip, dir], { timeout: 120_000 });
    const appDir = readdirSync(dir).find((f) => f.endsWith(".app"));
    if (!appDir) throw new Error(`no .app bundle inside the ${platform} artifact zip`);
    return path.join(dir, appDir);
  }
  const apk = path.join(dir, `${app.name}.apk`);
  await fetchArtifact(app.sha256, apk);
  return apk;
}

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const app = job.app;
  if (!app) throw new Error("install job needs an app ref");
  const platform = app.platform ?? "android";
  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new NoTargetsError(`no ${platform} targets matched this job`);

  const installable = await prepareInstallable(app, ctx.fetchArtifact);

  let allOk = true;
  for (const target of targets) {
    let ok = true;
    let error: string | undefined;
    try {
      const driver = driverNamed(target.driver);
      // A target with no driver, or a driver that cannot install, is a result
      // row rather than a thrown error: the other targets in this job still
      // have an answer coming, and "nothing here can install onto that" is
      // information the operator wants next to the device it is about.
      if (!driver) throw new Error(`no driver named '${target.driver ?? "(none)"}' for ${target.id}`);
      if (!driver.install) throw new Error(`the ${driver.name} driver cannot install builds`);
      await driver.install(target, installable);
    } catch (e) {
      ok = false;
      allOk = false;
      error = (e as Error).message.slice(0, 300);
    }
    await ctx.postResult({ job_id: job.job_id, device_id: target.id, iter: 0, ok, error });
    ctx.log(`install ${app.name}@${app.build} on ${target.id} (${platform}): ${ok ? "ok" : "FAILED"}`);
  }
  await ctx.postResult({ job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk });
}
