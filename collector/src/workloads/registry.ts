/**
 * The loader. Finds workloads by looking, not by being told.
 *
 * A directory next to this file with a `manifest.json` and an `index.ts` in it
 * IS a workload — there is no list to add a name to, which is the whole point:
 * the register-it-here line is exactly the line that put every workload author
 * into a merge conflict with every other workload author.
 *
 * Two rules the scan follows, both of them about not making a bad day worse:
 *
 * 1. A broken workload is skipped, loudly, and the executor keeps running.
 *    A manifest with a typo in it must not stop a host from claiming the
 *    twelve jobs that have nothing to do with it. The complaint goes to the
 *    log, and the job that actually wanted that workload fails with the reason
 *    on its own result row.
 *
 * 2. The scan happens once, at startup, but the module is imported lazily on
 *    first use. Knowing what exists is cheap and worth doing before any job
 *    arrives (so a stranger's typo is visible immediately rather than at 3am
 *    when the nightly hits it); loading the code is not, since a host may go
 *    weeks without ever being handed a web-test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkloadManifest, WorkloadRun } from "./types.js";

// Resolved from this module, not from cwd: the executor is started by a
// LaunchAgent whose working directory is not this repo, and `path.resolve` on a
// relative name would find nothing there. fileURLToPath rather than stripping
// "file://" by hand — this repo lives under a path with a space in it, and the
// URL form percent-encodes it.
const WORKLOADS_DIR = path.dirname(fileURLToPath(import.meta.url));

const CAPABILITIES = new Set(["devices", "browsers", "network"]);

export type LoadedWorkload = {
  manifest: WorkloadManifest;
  /** Absolute path to the module, for the dynamic import and for error messages. */
  entry: string;
};

/** Why a directory that looked like a workload is not one, or null if it is. */
function manifestProblem(name: string, m: unknown): string | null {
  if (typeof m !== "object" || m === null) return "manifest.json is not an object";
  const o = m as Record<string, unknown>;
  // The name is duplicated between the directory and the manifest on purpose:
  // the directory is what a person sees and the manifest is what is served to
  // the dashboard, and a workload answering to two names is the kind of bug
  // that is only ever found by someone whose job did not run.
  if (o.name !== name) return `manifest.json says name ${JSON.stringify(o.name)}, but the directory is ${JSON.stringify(name)}`;
  if (typeof o.capability !== "string" || !CAPABILITIES.has(o.capability)) {
    return `capability must be one of ${[...CAPABILITIES].join(", ")}, not ${JSON.stringify(o.capability)}`;
  }
  if (typeof o.description !== "string" || o.description.length === 0) return "description is missing";
  if (o.executor !== "host" && o.executor !== "device") return "executor must be \"host\" or \"device\"";
  if (typeof o.params !== "object" || o.params === null) return "params must be a JSON Schema object";
  if (typeof o.example !== "object" || o.example === null) return "example must be a spec object";
  return null;
}

/**
 * Every workload directory that parses, keyed by name.
 *
 * `onProblem` rather than a throw or a bare console.log: the executor has its
 * own prefixed logger and this module should not decide what the complaint
 * looks like, and a test wants to assert on the complaints rather than read
 * them.
 */
export function discoverWorkloads(
  onProblem: (msg: string) => void = () => {},
  dir: string = WORKLOADS_DIR,
): Map<string, LoadedWorkload> {
  const found = new Map<string, LoadedWorkload>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    onProblem(`cannot read the workloads directory (${(e as Error).message}); no workloads are loadable`);
    return found;
  }
  for (const e of entries) {
    // Files next to the directories — types.ts, this file, the tests — are the
    // shared plumbing, not workloads.
    if (!e.isDirectory()) continue;
    const manifestPath = path.join(dir, e.name, "manifest.json");
    let manifest: WorkloadManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkloadManifest;
    } catch (err) {
      onProblem(`workload "${e.name}" has no readable manifest.json (${(err as Error).message}); skipping it`);
      continue;
    }
    const problem = manifestProblem(e.name, manifest);
    if (problem) {
      onProblem(`workload "${e.name}" has an invalid manifest.json: ${problem}; skipping it`);
      continue;
    }
    found.set(manifest.name, { manifest, entry: path.join(dir, e.name, "index.js") });
  }
  return found;
}

/**
 * The `run` a workload exports, imported on first use.
 *
 * The `.js` in the entry path is deliberate and is what NodeNext wants: under
 * tsx it resolves to the neighbouring index.ts, and after a build it resolves
 * to the emitted index.js. pathToFileURL rather than importing the raw path,
 * again because of the space in this repo's path — a bare absolute path in a
 * dynamic import is interpreted as a URL on some platforms and silently fails
 * to resolve.
 */
export async function loadRun(w: LoadedWorkload): Promise<WorkloadRun> {
  const mod = (await import(pathToFileURL(w.entry).href)) as { run?: unknown };
  if (typeof mod.run !== "function") {
    throw new Error(`workload "${w.manifest.name}" does not export a run function from ${w.entry}`);
  }
  return mod.run as WorkloadRun;
}
