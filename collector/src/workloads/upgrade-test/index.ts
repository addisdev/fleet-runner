// upgrade-test: does the version users already have survive becoming this one?
//
// Almost no app project automates this, and it is the failure that actually
// loses people. A clean install passes every suite in the fleet; the path that
// breaks is the one nobody runs, where a real user with two years of data
// takes an update and the migration drops a table. By the time a crash report
// arrives, their data is gone.
//
// The sequence is the whole workload:
//
//   1. install the OLD build          — the version users are coming from
//   2. run the seed flow              — sign in, add a record, set a preference
//   3. install the NEW build OVER it  — no uninstall; that is the point
//   4. launch it                      — a migration that crashes on start
//                                        fails here, before any flow runs
//   5. run the verify flow            — assert the state is still there
//
// Step 3 is the one that has to be right. `adb install -r` and simctl's
// install both upgrade in place and keep the sandbox; an uninstall between the
// two would make this an install test with extra steps, and it would pass
// forever. `keep_data: false` exists only to produce a deliberate contrasting
// run when somebody suspects a migration, and it says so in the manifest.
//
// ## What each failure means, and why they are separate rows
//
// A failure at step 1 or 2 is the OLD build's problem and says nothing about
// the upgrade. A failure at step 3 is packaging: a signature mismatch, a
// downgraded versionCode. A failure at step 4 is a migration that crashes. A
// failure at step 5 is the interesting one — it upgraded, it launched, and the
// data is wrong. Each posts its own row naming the stage, because "upgrade-test
// failed" without the stage sends somebody to read the wrong logs.
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../../fleet-client.js";
import { driverNamed } from "../../drivers/index.js";
import { hasApp, launchApp } from "../device.js";
import { resolveFlow, runFlow } from "../flows.js";
import type { Job, Target, WorkloadCtx } from "../types.js";

/** Platforms whose artifact is a zipped bundle. Same rule as `install`. */
const BUNDLE_PLATFORMS = new Set(["ios", "tvos", "watchos", "visionos", "macos", "catalyst"]);

type Stage = "install-old" | "seed" | "upgrade" | "launch" | "verify";

/** Fetch an artifact and unpack it if the platform ships a bundle. */
async function installable(
  ctx: WorkloadCtx, dir: string, name: string, sha256: string, platform: string,
): Promise<string> {
  if (!BUNDLE_PLATFORMS.has(platform)) {
    const apk = path.join(dir, `${name}.apk`);
    await ctx.fetchArtifact(sha256, apk);
    return apk;
  }
  const zip = path.join(dir, `${name}.zip`);
  await ctx.fetchArtifact(sha256, zip);
  await exec("ditto", ["-x", "-k", zip, dir], { timeout: 120_000 });
  const appDir = readdirSync(dir).find((f) => f.endsWith(".app"));
  if (!appDir) throw new Error(`no .app bundle inside the ${platform} artifact zip`);
  return path.join(dir, appDir);
}

async function installOn(target: Target, file: string): Promise<void> {
  const driver = driverNamed(target.driver);
  if (!driver?.install) throw new Error(`no installer for ${target.id} (driver ${target.driver ?? "none"})`);
  await driver.install(target, file);
}

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const app = job.app;
  if (!app) throw new Error("upgrade-test needs an app ref for the NEW build");
  const params = job.params ?? {};
  const fromSha = typeof params.from_sha256 === "string" ? params.from_sha256 : null;
  const fromBuild = typeof params.from_build === "string" ? params.from_build : null;
  if (!fromSha && !fromBuild) {
    throw new Error(
      "upgrade-test needs params.from_build (or params.from_sha256): the version users are coming FROM. " +
      "Without one this is an install test, which every other suite already covers",
    );
  }
  if (!fromSha) {
    // Resolving a build NAME to a hash is the collector's job — it owns
    // publish ordering — and it does that at enqueue time for `app.sha256`.
    // There is no second resolver here on purpose: a workload that guessed
    // which artifact "1.4.0" meant could pick a different one than the
    // dashboard shows.
    throw new Error(
      `params.from_build "${fromBuild}" was not resolved to a hash. Pass params.from_sha256, ` +
      "or enqueue with a chain that resolves it — the executor deliberately does not resolve build names",
    );
  }

  const platform = app.platform ?? "android";
  const keepData = params.keep_data !== false;
  const appId = typeof params.app_id === "string" ? params.app_id : job.suite?.app_id;
  const seedFlow = typeof params.seed_flow === "string" ? params.seed_flow : null;
  const verifyFlow = typeof params.verify_flow === "string" ? params.verify_flow : null;

  const targets = await ctx.selectTargets(job, (await ctx.listTargets()).filter((t) => t.platform === platform));
  if (targets.length === 0) throw new Error(`no ${platform} targets matched this job`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-upgrade-"));
  const oldFile = await installable(ctx, path.join(dir, "old"), `${app.name}-old`, fromSha, platform);
  const newFile = await installable(ctx, path.join(dir, "new"), `${app.name}-new`, app.sha256, platform);
  const budgetS = ctx.leaseBudgetS(job, 900);

  let allOk = true;
  for (const target of targets) {
    let stage: Stage = "install-old";
    let error: string | null = null;
    try {
      await installOn(target, oldFile);

      if (seedFlow) {
        stage = "seed";
        const failure = await runFlow(
          target, resolveFlow(seedFlow), path.join(dir, "seed", target.id),
          appId ? { APP_ID: appId } : {}, budgetS * 1000 / 4,
        );
        // A seed failure is the OLD build's problem and says nothing about the
        // upgrade. Reported as its own stage so nobody reads it as one.
        if (failure) throw new Error(`the seed flow failed on the OLD build: ${failure}`);
      }

      stage = "upgrade";
      if (!keepData) {
        // Only ever on request. See the manifest: this makes the test measure
        // nothing, and exists to produce a contrasting run.
        if (appId && target.platform === "android") {
          await exec((await import("../device.js")).ADB, ["-s", target.id, "uninstall", appId], { timeout: 60_000 })
            .catch(() => { /* not installed is fine */ });
        }
      }
      await installOn(target, newFile);

      stage = "launch";
      if (appId) {
        if (!(await hasApp(target, appId))) throw new Error(`${appId} is not installed after the upgrade`);
        // A migration that crashes on first start fails here, before any flow
        // runs, which is a much clearer report than a flow timing out.
        await launchApp(target, appId);
      }

      if (verifyFlow) {
        stage = "verify";
        const failure = await runFlow(
          target, resolveFlow(verifyFlow), path.join(dir, "verify", target.id),
          appId ? { APP_ID: appId } : {}, budgetS * 1000 / 4,
        );
        if (failure) throw new Error(`state did not survive the upgrade: ${failure}`);
      }
    } catch (e) {
      error = (e as Error).message.slice(0, 400);
      allOk = false;
    }

    await ctx.postResult({
      job_id: job.job_id,
      device_id: target.id,
      iter: 0,
      ok: error === null,
      error: error ?? undefined,
      // Which step it got to. "upgrade-test failed" without this sends
      // somebody to read the wrong logs.
      upgrade: {
        stage: error === null ? "done" : stage,
        from_sha256: fromSha,
        to_sha256: app.sha256,
        kept_data: keepData,
      },
    });
    ctx.log(
      `upgrade-test ${app.name} ${fromSha.slice(0, 8)} -> ${app.build} on ${target.id}: ` +
      (error === null ? "ok" : `FAILED at ${stage} — ${error}`),
    );
  }

  await ctx.postResult({
    job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk,
  });
}
