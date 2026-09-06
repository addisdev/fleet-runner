/**
 * Running a Maestro flow, for the workloads that drive a UI.
 *
 * Here rather than in a workload's own directory for exactly the reason
 * `device.ts` gives: something other than one workload calls it. `ui-test`,
 * `app-soak`, `locale-shots`, `a11y-audit` and now `upgrade-test` all run
 * flows, and a second definition of "where do flows live and what is a safe
 * name" is a second place for a path-traversal bug to be fixed once.
 *
 * executor.ts imports these back, so the handlers still waiting to move keep
 * calling the same functions they always did.
 */
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "../fleet-client.js";
import type { Target } from "./types.js";

/**
 * Where the flow files live.
 *
 * `examples/flows` rather than `flows`: develop moved them under examples/ when
 * the documentation site landed, and this module was extracted from executor.ts
 * before that. A stale default here would not fail loudly — `resolveFlow` would
 * report "flow not found" for a flow that is right there, which reads as a
 * typo in the job spec rather than as a path this file got wrong.
 */
export const FLOWS_DIR = process.env.FLEET_FLOWS_DIR ?? path.resolve("examples/flows");

/**
 * Maestro, or wherever this host keeps it. A LaunchAgent's PATH is not a login
 * shell's, which is the same reason ADB_BIN exists.
 */
export const MAESTRO = process.env.MAESTRO_BIN ?? path.join(os.homedir(), ".maestro/bin/maestro");

/**
 * A flow path under FLOWS_DIR, refusing escapes the way the web specs do.
 *
 * `POST /jobs` is unauthenticated by design, so a flow NAME arrives from
 * anywhere on the LAN. `../../etc/something` must not resolve, and the check is
 * on the RESOLVED path so that encoded and nested forms of `..` are covered by
 * the same test rather than by a blocklist.
 */
export function resolveFlow(name: string): string {
  const root = path.resolve(FLOWS_DIR);
  const flow = path.resolve(root, name);
  if (flow !== root && !flow.startsWith(root + path.sep)) throw new Error(`the flow ${name} escapes the flows dir`);
  if (!existsSync(flow)) throw new Error(`flow not found: ${flow}`);
  return flow;
}

/**
 * Run one Maestro flow against one device, with `cwd` set to where its
 * screenshots should land.
 *
 * The cwd is the whole mechanism: `takeScreenshot: home` inside a flow writes
 * `home.png` relative to the working directory, so pointing the working
 * directory at this locale's folder is what files a flow's shots under the
 * right locale without the flow knowing anything about locales.
 *
 * Returns the failure text, or null. A failing flow is not thrown, because
 * every caller wants to record it against one cell of a matrix and carry on
 * with the rest.
 */
export async function runFlow(
  t: Target, flow: string, cwd: string, env: Record<string, string>, timeoutMs: number,
): Promise<string | null> {
  mkdirSync(cwd, { recursive: true });
  try {
    await exec(
      MAESTRO,
      ["--device", t.id, "test", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), flow],
      { timeout: timeoutMs, cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return null;
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    return `${err.stdout ?? ""}${err.message ?? ""}`.trim().slice(-400) || "maestro failed";
  }
}
