/**
 * The `build` workload: check out a ref, build it, publish the product.
 *
 * The three things this has to get right, in order of how badly they go wrong:
 *
 * 1. A failed build must not look like a build that did not run. Every exit
 *    path posts a final row; a failure carries the failing task or scheme in
 *    `error` and the full log as an artifact, so "why is the nightly red" is
 *    answerable from the dashboard rather than by ssh-ing to the machine.
 * 2. The lease must survive the build. `build` is in the collector's
 *    LONG_LEASE_WORKLOADS, but a lease is renewed by beacons, not by being
 *    long — so the log is tailed and a beacon goes out every 30 s while the
 *    compiler works.
 * 3. A published build must be findable. The collector has no publish endpoint:
 *    POST /artifacts carrying `x-artifact-app` IS the publish, and the
 *    `publish_seq` it stamps is what `resolveLatestBuild` orders by when a
 *    schedule asks for `"sha256": "latest"`.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, stringParam } from "../protocol.js";
import { beacon } from "../telemetry.js";
import { run } from "../probe.js";
import { prepareCheckout } from "../git.js";
import { planBuild, isBuildKind, BUILD_KINDS, XCODEGEN, PACK_DIR, type BuildPlan } from "../buildkinds.js";
import { LogTail, lastMeaningfulLine, failureLine } from "../logtail.js";
import { postCommitStatus } from "../github.js";
import * as JobCancellation from "../cancellation.js";

/** How often the log tail turns into a lease-renewing beacon. */
export const BUILD_BEACON_MS = 30_000;
/** Ceiling on one build, so a hung compiler fails as a build rather than as a swept lease. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

type ReportTo = { github_status?: string };

export async function runBuild(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const log = (m: string) => console.log(`[${deviceId}] build ${job.job_id}: ${m}`);
  const statusTarget = (job as JobSpec & { report_to?: ReportTo }).report_to?.github_status;

  const fail = async (error: string, artifacts?: string[], metrics?: Metrics) => {
    log(`failed: ${error}`);
    await postCommitStatus(statusTarget, "failure", error, env).then((r) => log(`github status: ${r.detail}`));
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor, error,
      ...(artifacts?.length ? { artifacts } : {}),
      ...(metrics ? { metrics } : {}),
    });
  };

  const repo = stringParam(job.params, "repo");
  const ref = stringParam(job.params, "ref") ?? "main";
  const kindRaw = stringParam(job.params, "kind");
  if (!repo) return fail("build needs params.repo");
  if (!isBuildKind(kindRaw)) {
    return fail(`build needs params.kind, one of ${BUILD_KINDS.join(", ")} (got ${kindRaw ?? "nothing"})`);
  }
  const kind = kindRaw;

  // Pending goes out before anything slow happens, which is the whole value of
  // it: a commit whose check has been pending for eight minutes is a commit
  // somebody knows is being built.
  await postCommitStatus(statusTarget, "pending", `building ${ref} on ${deviceId}`, env)
    .then((r) => log(`github status: ${r.detail}`));

  let checkout;
  try {
    checkout = await prepareCheckout(repo, ref, env);
  } catch (e) {
    return fail(`checkout failed: ${(e as Error).message}`);
  }
  const shortSha = checkout.sha.slice(0, 12);
  log(`checked out ${ref} at ${shortSha} in ${checkout.dir}`);

  let plan: BuildPlan;
  try {
    plan = planBuild(kind, job.params, checkout.dir, await containerFlags(kind, checkout.dir));
  } catch (e) {
    return fail((e as Error).message);
  }

  // A generated project has to exist before xcodebuild is told to open it, and
  // an absolute xcodegen is not fussiness: a bare `xcodegen` is not reliably on
  // a launchd agent's PATH and fails by doing nothing, so new files never
  // compile and the build succeeds against yesterday's project.
  if (kind === "xcode" && existsSync(path.join(checkout.dir, "project.yml"))) {
    const gen = await run(XCODEGEN, ["generate", "--spec", path.join(checkout.dir, "project.yml")], 300_000);
    if (gen.code !== 0) {
      return fail(`xcodegen failed: ${(gen.stderr || gen.stdout).split("\n")[0] || `exit ${gen.code}`}`);
    }
    // The project only just appeared, so the container flags have to be redone.
    plan = planBuild(kind, job.params, checkout.dir, await containerFlags(kind, checkout.dir));
  }

  const logDir = path.join(checkout.dir, ".fleet-logs");
  await mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${safeName(job.job_id)}.log`);
  await rm(logFile, { force: true });

  const t0 = Date.now();
  const outcome = await spawnWithBeacons(plan, logFile, job, client, deviceId, log);
  const buildS = Math.round((Date.now() - t0) / 100) / 10;

  if (outcome.cancelled) {
    log("cancelled");
    await postCommitStatus(statusTarget, "error", "cancelled", env);
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor, error: "cancelled",
      metrics: compact<Metrics>({ build_s: buildS }),
    });
    return;
  }

  if (outcome.code !== 0) {
    // The log IS the answer to a failed build, so it is uploaded before the row
    // that references it. Uploaded without app headers: a log is not a build,
    // and publishing it under the app's name would make it the thing a nightly
    // asking for "latest" picks up.
    const logRef = await uploadQuietly(client, logFile, `${safeName(job.job_id)}-build.log`, log);
    const named = failureLine(outcome.tail) ?? `${plan.target} failed`;
    return fail(
      `${plan.kind} ${plan.target} failed (exit ${outcome.code ?? "signal " + (outcome.signal ?? "?")}): ${named}`,
      logRef ? [logRef] : undefined,
      compact<Metrics>({ build_s: buildS }),
    );
  }

  // An npm build's product is a tarball, and `npm pack` is what makes one. The
  // build script leaves a directory behind; a directory is not something the
  // artifact store can hold, and publishing one file out of a dist/ would
  // publish a fragment of a build as if it were the build.
  if (plan.kind === "npm" && !stringParam(job.params, "artifact")) {
    const packDir = path.join(checkout.dir, PACK_DIR);
    await mkdir(packDir, { recursive: true });
    const packed = await run("npm", ["pack", "--pack-destination", packDir, checkout.dir], 600_000);
    if (packed.code !== 0) {
      const logRef = await uploadQuietly(client, logFile, `${safeName(job.job_id)}-build.log`, log);
      return fail(
        `npm ${plan.target} built but npm pack failed: ${(packed.stderr || packed.stdout).split("\n").find(Boolean) ?? `exit ${packed.code}`}`,
        logRef ? [logRef] : undefined,
        compact<Metrics>({ build_s: buildS }),
      );
    }
  }

  // Product.
  let product: string | null;
  try {
    product = await findProduct(plan, job, t0);
  } catch (e) {
    return fail(`build succeeded but locating the product failed: ${(e as Error).message}`);
  }
  if (!product) {
    const logRef = await uploadQuietly(client, logFile, `${safeName(job.job_id)}-build.log`, log);
    return fail(
      `${plan.kind} ${plan.target} produced no artifact under ${plan.productDirs.join(", ")}` +
        " (set params.artifact to the path if it is elsewhere)",
      logRef ? [logRef] : undefined,
      compact<Metrics>({ build_s: buildS }),
    );
  }

  // A .app is a directory, and the job schema says iOS artifacts are zips of
  // the bundle. ditto keeps the symlinks and the permission bits a plain zip
  // loses, which is the difference between a bundle that launches and one that
  // does not.
  let upload = product;
  let cleanup: string | null = null;
  if ((await stat(product)).isDirectory()) {
    upload = `${product}.zip`;
    const zipped = await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", product, upload], 900_000);
    if (zipped.code !== 0) {
      return fail(`zipping ${path.basename(product)} failed: ${(zipped.stderr || "").split("\n")[0] || `exit ${zipped.code}`}`);
    }
    cleanup = upload;
  }

  const bytes = (await stat(upload)).size;
  const appName = stringParam(job.params, "app") ?? defaultAppName(repo, kind);
  const build = stringParam(job.params, "build") ?? shortSha;
  let sha256: string;
  try {
    const up = await client.uploadArtifact(upload, path.basename(upload), {
      app: appName, build, platform: plan.platform,
    });
    sha256 = up.sha256;
  } catch (e) {
    return fail(`upload failed: ${(e as Error).message}`, undefined, compact<Metrics>({ build_s: buildS, artifact_bytes: bytes }));
  } finally {
    if (cleanup) await rm(cleanup, { force: true }).catch(() => {});
  }

  log(`published ${appName} ${build} -> ${sha256} (${bytes} bytes)`);
  await postCommitStatus(statusTarget, "success", `${plan.kind} ${plan.target} built in ${buildS}s`, env)
    .then((r) => log(`github status: ${r.detail}`));
  await client.postResult({
    schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
    iter: 0, final: true, ok: true, device: descriptor,
    metrics: compact<Metrics>({ build_s: buildS, artifact_bytes: bytes }),
    artifacts: [sha256],
    // Not in the result schema, and deliberately so: the collector stores the
    // whole payload, and a build row that cannot say which commit it built is
    // not traceable to anything. Named `build` to match the artifact's.
    build: { app: appName, build, sha256, commit: checkout.sha, ref: checkout.ref, repo, kind: plan.kind },
  });
}

/**
 * Runs the build, tailing its log into a beacon every 30 s.
 *
 * The beacon is the lease renewal — that is the entire reason for the tail —
 * and its answer is also how a cancellation gets in: an explicit
 * `lease_renewed: false` kills the child, whereas an unreachable collector
 * throws and is swallowed, because a flaky network must never kill a build.
 */
async function spawnWithBeacons(
  plan: BuildPlan,
  logFile: string,
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  log: (m: string) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; cancelled: boolean; tail: string }> {
  const sink = createWriteStream(logFile, { flags: "a" });
  const child = spawn(plan.cmd, plan.args, {
    cwd: plan.cwd,
    // Merged, because a compiler's diagnostics go to stderr and its progress to
    // stdout, and reading them apart loses which came first.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", TERM: "dumb" },
  });
  child.stdout.pipe(sink, { end: false });
  child.stderr.pipe(sink, { end: false });

  const tail = new LogTail(logFile);
  const recent: string[] = [];
  let cancelled = false;
  let finished = false;

  const timeoutMs = Number(job.params?.timeout_s) > 0 ? Number(job.params?.timeout_s) * 1000 : DEFAULT_TIMEOUT_MS;
  const killer = setTimeout(() => {
    if (!finished) {
      log(`timed out after ${Math.round(timeoutMs / 1000)}s; killing`);
      child.kill("SIGKILL");
    }
  }, timeoutMs);

  const ticker = setInterval(() => {
    void (async () => {
      const lines = await tail.read();
      // Bounded: a Gradle build prints hundreds of thousands of lines and the
      // only ones this needs are the last few, for the beacon and the error row.
      for (const l of lines) {
        recent.push(l);
        if (recent.length > 400) recent.shift();
      }
      const line = lastMeaningfulLine(lines);
      if (line) log(line);
      try {
        const renewed = await client.postBeacon({
          schema: SCHEMA, kind: "beacon", job_id: job.job_id, device_id: deviceId, beacon: await beacon(),
        });
        if (!renewed) {
          cancelled = true;
          JobCancellation.cancel(job.job_id);
          log("lease not renewed; killing the build");
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }
      } catch {
        // An unreachable collector is not a cancellation.
      }
      if (JobCancellation.isCancelled(job.job_id) && !cancelled) {
        cancelled = true;
        child.kill("SIGTERM");
      }
    })();
  }, BUILD_BEACON_MS);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  finished = true;
  clearInterval(ticker);
  clearTimeout(killer);
  sink.end();
  for (const l of await tail.close()) {
    recent.push(l);
    if (recent.length > 400) recent.shift();
  }
  return { ...exit, cancelled, tail: recent.join("\n") };
}

/** Which container flags xcodebuild needs, and whether gradle has a wrapper. */
async function containerFlags(kind: string, dir: string) {
  if (kind === "gradle") return { hasGradlew: existsSync(path.join(dir, "gradlew")) };
  if (kind !== "xcode") return {};
  const entries = await readdir(dir).catch(() => [] as string[]);
  const workspace = entries.find((e) => e.endsWith(".xcworkspace"));
  const project = entries.find((e) => e.endsWith(".xcodeproj"));
  return {
    hasWorkspace: workspace ? path.join(dir, workspace) : null,
    hasProject: project ? path.join(dir, project) : null,
  };
}

/**
 * The file the build produced.
 *
 * `params.artifact` wins outright, because a repo whose product is somewhere
 * unusual should say so rather than have this guess. Otherwise the plan's
 * directories are walked and the newest matching file wins, restricted to
 * files this build touched: an APK left over from a build three weeks ago is
 * still an APK, and publishing it as the product of today's build is the
 * quietest possible way to ship stale code.
 */
export async function findProduct(plan: BuildPlan, job: JobSpec, startedMs: number): Promise<string | null> {
  const explicit = stringParam(job.params, "artifact");
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(plan.cwd, explicit);
    return existsSync(p) ? p : null;
  }

  let best: { file: string; mtime: number } | null = null;
  for (const rel of plan.productDirs) {
    const root = path.join(plan.cwd, rel);
    if (!existsSync(root)) continue;
    for await (const file of walk(root, plan.productExts)) {
      const st = await stat(file).catch(() => null);
      if (!st) continue;
      // 5 s of slack: a bundle's directory mtime can predate the spawn by a
      // moment when the toolchain writes into an existing one.
      if (st.mtimeMs + 5000 < startedMs) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs };
    }
    if (best) return best.file;
  }
  return null;
}

/** Depth-limited walk that stops descending into a matched bundle directory. */
async function* walk(dir: string, exts: string[], depth = 0): AsyncGenerator<string> {
  if (depth > 8) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const matches = exts.some((x) => e.name.toLowerCase().endsWith(x));
    if (matches) {
      yield full;
      // A .app is a directory full of files; descending into it would yield
      // its own nested bundles as if they were the product.
      continue;
    }
    if (e.isDirectory()) yield* walk(full, exts, depth + 1);
  }
}

/** An upload whose failure must not replace the error it was meant to explain. */
async function uploadQuietly(
  client: CollectorClient,
  file: string,
  name: string,
  log: (m: string) => void,
): Promise<string | null> {
  try {
    if (!existsSync(file) || (await stat(file)).size === 0) return null;
    const { sha256 } = await client.uploadArtifact(file, name);
    log(`build log uploaded as ${sha256}`);
    return sha256;
  } catch (e) {
    log(`build log upload failed: ${(e as Error).message}`);
    return null;
  }
}

/** `github.com/addisdev/greenfolio` + gradle -> `greenfolio-android`. */
export function defaultAppName(repo: string, kind: string): string {
  const base = (repo.replace(/\/+$/, "").split(/[/\\:]/).pop() ?? "app").replace(/\.git$/i, "");
  const suffix = kind === "gradle" ? "-android" : kind === "xcode" ? "-ios" : "";
  return `${base}${suffix}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
