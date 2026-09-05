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
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../../fleet-client.js";
import { ADB } from "../device.js";
import type { Job, WorkloadCtx } from "../types.js";

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const app = job.app;
  if (!app) throw new Error("install job needs an app ref");
  const platform = app.platform ?? "android";
  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-"));
  let installable: string;
  if (platform === "android") {
    installable = path.join(dir, `${app.name}.apk`);
    await ctx.fetchArtifact(app.sha256, installable);
  } else {
    // iOS artifacts are zips of the .app bundle (a directory can't be a raw artifact).
    const zip = path.join(dir, `${app.name}.zip`);
    await ctx.fetchArtifact(app.sha256, zip);
    await exec("ditto", ["-x", "-k", zip, dir], { timeout: 120_000 });
    const appDir = readdirSync(dir).find((f) => f.endsWith(".app"));
    if (!appDir) throw new Error("no .app bundle inside iOS artifact zip");
    installable = path.join(dir, appDir);
  }

  let allOk = true;
  for (const target of targets) {
    let ok = true;
    let error: string | undefined;
    try {
      if (platform === "android") {
        await exec(ADB, ["-s", target.id, "install", "-r", installable], { timeout: 120_000 });
      } else if (target.kind === "device") {
        await exec("xcrun", ["devicectl", "device", "install", "app", "--device", target.id, installable], { timeout: 300_000 });
      } else {
        await exec("xcrun", ["simctl", "install", target.id, installable], { timeout: 120_000 });
      }
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
