/**
 * Every workload directory, named in one file that a bundler can read.
 *
 * The registry finds workloads by listing this directory and importing each
 * `index.ts` by absolute path. That is the right thing when the executor is a
 * checkout -- adding a workload is adding a directory, and nothing else has to
 * be edited -- and it is impossible when the executor is a single bundled file,
 * because there is no directory to list and `import(someVariable)` is not
 * something esbuild can follow.
 *
 * So there are two lists, and the honest way to have two lists is to make them
 * fail loudly when they disagree. `npm test` compares this map against what the
 * disk walk finds, in both directions:
 *
 * - a directory missing from this map would work from a checkout and vanish
 *   from the bundle, which is a workload that exists on your machine and not on
 *   anybody else's
 * - an entry here with no directory would fail at import time, in the executor,
 *   the first time somebody enqueued it
 *
 * The `() => import(...)` values matter as much as the keys: a bundler follows a
 * literal specifier and gives each one its own chunk, so an executor that never
 * runs `upgrade-test` never loads it.
 */
import type { WorkloadRun } from "./types.js";

type Loader = () => Promise<{ run?: unknown }>;

export const BUNDLED: Record<string, Loader> = {
  install: () => import("./install/index.js"),
  "size-report": () => import("./size-report/index.js"),
  "upgrade-test": () => import("./upgrade-test/index.js"),
};

/** The names in this map, for the test that compares it with the disk walk. */
export function bundledNames(): string[] {
  return Object.keys(BUNDLED).sort();
}

/**
 * The `run` export of a bundled workload, or null if it is not one of them.
 *
 * Null rather than a throw: the caller's next move is the disk walk, and "not
 * in the bundle" is an ordinary answer in a checkout.
 */
export async function bundledRun(name: string): Promise<WorkloadRun | null> {
  const loader = BUNDLED[name];
  if (!loader) return null;
  const mod = await loader();
  if (typeof mod.run !== "function") {
    throw new Error(`bundled workload "${name}" does not export a run function`);
  }
  return mod.run as WorkloadRun;
}
