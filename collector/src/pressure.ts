/**
 * Whether this host is too busy to take on a heavy job.
 *
 * An executor on a shared Mac runs `xcodebuild`, Maestro and browsers, and the
 * owner of that Mac has a rule for it: above a load of about 50, or under about
 * 2 GB of free swap, add no work -- because swap fills, macOS starts killing
 * test hosts and simulators, and the failures that follow look like the code
 * is broken when it is not. That rule was written for people and their agents.
 * This is the executor keeping it too, now that agents can ask the lab for a
 * run on that same Mac at any moment.
 *
 * **Opt-in, per host.** `FLEET_MAX_LOAD` and `FLEET_MIN_FREE_SWAP_MB` are
 * unset by default, so a dedicated machine -- the brain, a lab Mac -- is not
 * second-guessed. A host that is somebody's workstation sets them.
 *
 * **A refusal is a skip with the numbers in it**, not a queued job that runs
 * whenever the pressure lifts. An agent that asked a question gets an answer
 * now -- "not on this Mac, it is at load 228" -- rather than a result an hour
 * later into a session that has moved on.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Pressure = { load1: number; freeSwapMb: number | null };

/** "total = 10240.00M  used = 8909.88M  free = 1330.12M  (encrypted)" -> 1330 */
export function parseDarwinSwap(text: string): number | null {
  const m = /free\s*=\s*([\d.]+)([MG])/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === "G" ? n * 1024 : n);
}

/** The SwapFree line of /proc/meminfo, in MB. */
export function parseLinuxSwap(meminfo: string): number | null {
  const m = /^SwapFree:\s+(\d+)\s+kB/m.exec(meminfo);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

export async function readPressure(): Promise<Pressure> {
  const load1 = os.loadavg()[0];
  let freeSwapMb: number | null = null;
  try {
    if (process.platform === "darwin") {
      freeSwapMb = parseDarwinSwap((await run("sysctl", ["-n", "vm.swapusage"], { timeout: 5_000 })).stdout);
    } else if (process.platform === "linux") {
      const { readFile } = await import("node:fs/promises");
      freeSwapMb = parseLinuxSwap(await readFile("/proc/meminfo", "utf8"));
    }
  } catch {
    // Unknown is not "full". A host that cannot say is judged on load alone.
  }
  return { load1, freeSwapMb };
}

/**
 * The reason to refuse, or null to go ahead. Pure, so the thresholds can be
 * tested without a loaded machine.
 */
export function pressureReason(p: Pressure, env: NodeJS.ProcessEnv = process.env): string | null {
  const maxLoad = Number(env.FLEET_MAX_LOAD);
  const minSwap = Number(env.FLEET_MIN_FREE_SWAP_MB);
  const reasons: string[] = [];
  if (Number.isFinite(maxLoad) && maxLoad > 0 && p.load1 > maxLoad) {
    reasons.push(`load ${p.load1.toFixed(1)} is over ${maxLoad}`);
  }
  // Zero is a real reading -- swap exhausted -- so it is compared, not skipped.
  if (Number.isFinite(minSwap) && minSwap > 0 && p.freeSwapMb !== null && p.freeSwapMb < minSwap) {
    reasons.push(`${p.freeSwapMb} MB of swap free is under ${minSwap} MB`);
  }
  return reasons.length ? `this host is under pressure (${reasons.join("; ")}), so it is taking no heavy work` : null;
}
