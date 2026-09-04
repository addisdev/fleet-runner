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
 */
import { which, run } from "./probe.js";

export type CapabilityFlags = { llamaBench: boolean; mlx: boolean };

/** The list, given the answers. Pure, so the ordering is testable. */
export function capabilitiesFrom(flags: CapabilityFlags): string[] {
  const caps = ["benchmark"];
  if (flags.llamaBench) caps.push("benchmark:llama.cpp");
  if (flags.mlx) caps.push("benchmark:mlx");
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

export async function probeCapabilities(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const [llamaBench, mlx] = await Promise.all([resolveLlamaBench(env), hasMlx(env)]);
  return capabilitiesFrom({ llamaBench: llamaBench !== null, mlx });
}
