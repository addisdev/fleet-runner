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
 * `benchmark` is unconditional because the synthetic backend is in this repo
 * and needs nothing installed. That is the point of the synthetic backend: a
 * machine with no ML toolchain at all is still a useful fleet member.
 *
 * The two `benchmark:<backend>` pairings are statements about the toolchain
 * this machine has, readable from a `targets.match` expression
 * (`capabilities ~ 'benchmark:llama.cpp'`) — they do not narrow what the queue
 * offers, because declaring `benchmark` outright already means "every backend
 * this agent was built with". `benchmark:mlx` is therefore honest about the
 * machine and NOT a claim that a workload exists: there is no MLX backend in
 * this repo yet, and an mlx-backed job is refused with an error row the way
 * the iOS runner refuses llama.cpp when its framework is missing.
 *
 * `self-check` is unconditional for the same reason `benchmark` is: it shells
 * out to whatever is installed and reports a skipped check for whatever is
 * not, so a machine that can answer none of its questions still answers "I
 * could not", which is the reading the alert engine needs.
 *
 * `build` is the one capability that is BOTH a claim and a label. The
 * `build:<kind>` entries are toolchain statements like the benchmark pairings,
 * but bare `build` is what the collector's claim path actually matches on — a
 * build job carries its kind in `params`, where `capabilityMatches` cannot
 * see it, so without the bare entry a machine with the whole toolchain
 * installed would sit there declaring three kinds and never claim a build.
 */
import { which, run } from "./probe.js";
import { KIND_BINARY } from "./buildkinds.js";

export type CapabilityFlags = {
  llamaBench: boolean;
  mlx: boolean;
  gradle: boolean;
  xcodebuild: boolean;
  node: boolean;
};

/** The list, given the answers. Pure, so the ordering is testable. */
export function capabilitiesFrom(flags: CapabilityFlags): string[] {
  const caps = ["benchmark"];
  if (flags.llamaBench) caps.push("benchmark:llama.cpp");
  if (flags.mlx) caps.push("benchmark:mlx");
  // Bare `build` is what the collector's claim path matches on: a job spec has
  // no place to put a build kind that `capabilityMatches` would read — its
  // `backend` is a closed enum of inference runtimes — so `build:gradle` alone
  // would be a machine that can build and never claims a build. It is declared
  // when at least one kind resolves, which is the honest statement: this
  // machine can build something. The `build:<kind>` labels then say WHICH,
  // readable from a targets.match expression, exactly as the benchmark
  // pairings are.
  const kinds: string[] = [];
  if (flags.gradle) kinds.push("build:gradle");
  if (flags.xcodebuild) kinds.push("build:xcode");
  if (flags.node) kinds.push("build:npm");
  if (kinds.length > 0) caps.push("build", ...kinds);
  // self-check needs nothing installed: it shells out to whatever is there and
  // reports a skipped check for whatever is not. A machine that cannot answer
  // any of its questions still answers "I could not", which is the whole point.
  caps.push("self-check");
  return caps;
}

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
  const [llamaBench, mlx, kinds] = await Promise.all([
    resolveLlamaBench(env),
    hasMlx(env),
    probeBuildKinds(env),
  ]);
  return capabilitiesFrom({ llamaBench: llamaBench !== null, mlx, ...kinds });
}
