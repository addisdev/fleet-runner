/**
 * The per-repo checkout cache.
 *
 * Cloning a repo of any size on every job turns a two-minute incremental build
 * into a ten-minute one, and does it over somebody's home internet. So a repo
 * is cloned once into the agent's data dir and thereafter fetched — which is
 * also what makes `ref` mean what it should: a fetch brings the remote's
 * current `main` down before the checkout, so a job asking for `main` builds
 * today's main and not the one that was current when the cache was seeded.
 *
 * Everything here is destructive to the working tree on purpose. The cache is
 * the agent's, not a person's: a build that left a modified file behind must
 * not silently become part of the next job's build, so the checkout resets hard
 * and cleans untracked files before it starts.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, type Run } from "./probe.js";
import { repoCacheName } from "./buildkinds.js";

/**
 * Where clones live. Separate from FLEET_CACHE_DIR's model cache only by
 * subdirectory, so one variable still moves everything off a small boot disk.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_CACHE_DIR ?? path.join(os.homedir(), ".cache", "fleet-runner-machine");
}

export function repoDirFor(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), "repos", repoCacheName(repo, (s) => createHash("sha256").update(s).digest("hex")));
}

/** A git invocation that never throws; the caller decides what a non-zero means. */
export async function git(cwd: string | null, args: string[], timeoutMs = 600_000): Promise<Run> {
  const full = cwd === null ? args : ["-C", cwd, ...args];
  return run("git", full, timeoutMs);
}

export type Checkout = { dir: string; sha: string; ref: string };

/**
 * Clones or updates `repo` and checks out `ref`, returning the resolved commit.
 *
 * The resolved sha is what the result row and the published build carry.
 * Recording the ref instead would make every nightly's artifact say `main`,
 * which names no code: two artifacts both labelled `main` cannot be told apart,
 * and `resolveLatestBuild` would hand a test a build nobody can map to a commit.
 */
export async function prepareCheckout(
  repo: string,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Checkout> {
  const dir = repoDirFor(repo, env);
  await mkdir(path.dirname(dir), { recursive: true });

  if (!existsSync(path.join(dir, ".git"))) {
    const cloned = await git(null, ["clone", "--no-checkout", repo, dir]);
    if (cloned.code !== 0) {
      throw new Error(`git clone failed: ${firstError(cloned)}`);
    }
  }

  // Fetch before resolving, so a branch name resolves to the remote's current
  // tip. --tags because a ref may be one, --prune so a deleted branch stops
  // resolving out of a stale remote-tracking ref and silently building code
  // that no longer exists upstream.
  const fetched = await git(dir, ["fetch", "--prune", "--tags", "--force", "origin"]);
  if (fetched.code !== 0 && !existsSync(path.join(dir, ".git"))) {
    throw new Error(`git fetch failed: ${firstError(fetched)}`);
  }

  const sha = await resolveRef(dir, ref);
  if (!sha) throw new Error(`ref '${ref}' does not resolve in ${repo}`);

  const checked = await git(dir, ["checkout", "--force", "--detach", sha]);
  if (checked.code !== 0) throw new Error(`git checkout ${ref} failed: ${firstError(checked)}`);
  // A previous build's outputs are not this build's inputs. -x so ignored
  // files go too: a stale node_modules or .gradle from a different toolchain is
  // exactly the thing that makes a build pass here and fail in CI.
  await git(dir, ["reset", "--hard"]);
  await git(dir, ["clean", "-xdff"]);
  if (existsSync(path.join(dir, ".gitmodules"))) {
    await git(dir, ["submodule", "update", "--init", "--recursive"]);
  }
  return { dir, sha, ref };
}

/**
 * A ref to a commit sha, trying the remote-tracking name before the bare one.
 *
 * `origin/main` first is deliberate: after a fetch, a stale local `main` still
 * exists and still resolves, and preferring it would build whatever was current
 * the last time this machine ran a job on this repo — the exact failure the
 * fetch was there to prevent.
 */
export async function resolveRef(dir: string, ref: string): Promise<string | null> {
  for (const candidate of [`origin/${ref}`, ref, `${ref}^{commit}`]) {
    const r = await git(dir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], 30_000);
    const sha = r.stdout.trim();
    if (r.code === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

/** The first line of stderr that says something, for an error row. */
function firstError(r: Run): string {
  const line = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line ?? `exit ${r.code}`;
}
