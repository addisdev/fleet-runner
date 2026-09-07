/**
 * What this machine tells the collector it can run.
 *
 * The collector never hands an agent a workload it did not declare, and it
 * refuses to enqueue one no agent declares at all — so this probe is the whole
 * safety mechanism. A capability claimed here that the machine cannot actually
 * honour does not fail politely: it takes the job off the queue, away from a
 * machine that could have run it, and returns an error row instead of a
 * benchmark. So each probe below asks the question that the code would have
 * asked anyway — can I execute this binary, does this import work — rather
 * than anything cheaper.
 *
 * This module now answers only the machine's half of that: which binaries are
 * here, which imports work. Turning those answers into the declared list lives
 * in routes.ts, beside the dispatch table that has to honour them -- because
 * declaring a workload and being able to run it must be one act, and here they
 * were two.
 */
import { which, run } from "./probe.js";
import { KIND_BINARY } from "./buildkinds.js";
import { convertersAvailable, probeConverters } from "./converters.js";
import { loadAllowlist } from "./allowlist.js";
import { capabilitiesFrom, type CapabilityFlags } from "./routes.js";

// Re-exported because this is where callers and the tests have always looked
// for them, and because "what this machine can do" is still this module's
// subject. What moved to routes.ts is the mapping from an answer to a declared
// string, which had to sit beside the dispatch that honours it.
export { capabilitiesFrom, type CapabilityFlags };

/**
 * Where llama-bench is, or null.
 *
 * `FLEET_LLAMA_BENCH` names it outright, for the common case of a llama.cpp
 * build tree that was never installed onto PATH. Either way the file has to
 * exist and be executable by this user: a variable pointing at a path that was
 * deleted must read as "no llama.cpp", not as a declaration.
 */
export async function resolveLlamaBench(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const explicit = env.FLEET_LLAMA_BENCH;
  if (explicit) return which(explicit, env);
  return which("llama-bench", env);
}

/**
 * mlx_lm imports or it does not. Checking for the `mlx` package directory, or
 * for Apple silicon, would both answer a different question than the one the
 * workload asks.
 */
export async function hasMlx(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const python = env.FLEET_PYTHON ?? "python3";
  const r = await run(python, ["-c", "import mlx_lm"], 30_000);
  return r.code === 0;
}

/**
 * The build toolchains this machine actually has.
 *
 * `which` and nothing cheaper: the collector will hand this agent a build job
 * on the strength of these answers, and a `build:xcode` declared on a machine
 * with no Xcode takes an iOS build off the queue, away from the Mac that could
 * have run it, and returns an error row an hour later.
 *
 * Gradle is the one asymmetry: a repo with a `gradlew` wrapper needs no system
 * gradle at all, but a wrapper is a property of a repo and this is a statement
 * about a machine, so the system binary is what is asked about. A machine with
 * only wrappers under-declares, which costs a claim; the reverse would cost a
 * failed nightly.
 */
export async function probeBuildKinds(env: NodeJS.ProcessEnv = process.env): Promise<{
  gradle: boolean; xcodebuild: boolean; node: boolean;
}> {
  const [gradle, xcodebuild, node] = await Promise.all([
    which(KIND_BINARY.gradle, env),
    which(KIND_BINARY.xcode, env),
    which(KIND_BINARY.npm, env),
  ]);
  return { gradle: gradle !== null, xcodebuild: xcodebuild !== null, node: node !== null };
}

export async function probeCapabilities(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const [llamaBench, mlx, kinds, converters, allowlist, llamaServer] = await Promise.all([
    resolveLlamaBench(env),
    hasMlx(env),
    probeBuildKinds(env),
    probeConverters(env).then(convertersAvailable).catch(() => [] as string[]),
    loadAllowlist(env).then((a) => a.allowed.length > 0).catch(() => false),
    which("llama-server", env).then((p) => p !== null).catch(() => false),
  ]);
  return capabilitiesFrom({
    llamaBench: llamaBench !== null, mlx, ...kinds,
    converters, shellAllowlist: allowlist, llamaServer,
  });
}
