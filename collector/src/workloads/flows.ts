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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
 * Where Maestro writes a run's files: the flag, and what to look for under it.
 *
 * Maestro 1.x wrote `takeScreenshot: home` as `home.png` in the working
 * directory. 2.x (2.8.0 on ultra, 2026-11-20) writes it to
 * `~/.maestro/tests/<timestamp>/<flow name>/takeScreenshot/home.png` instead,
 * and a step that fails leaves `screenshots/step-NNN-<command>-<label>.png`
 * beside it. Nothing in the job's folders ever saw either, so a ui-test that
 * passed uploaded no visual proof and a locale sweep whose flow took eleven
 * shots reported "no screenshot captured".
 *
 * `--test-output-dir` pins the run's root to a folder this host picks. Under it
 * Maestro still adds `<timestamp>/<flow name>/` (TestDebugReporter, cli-2.8.0,
 * despite the help text saying "directly into it"), so the shots are found by
 * walking for the folder names rather than by building one path.
 */
export const MAESTRO_OUTPUT_FLAG = "--test-output-dir";
const SHOT_DIR = "takeScreenshot";
const FAILURE_DIR = "screenshots";

export type FlowShot = { file: string; name: string };
export type FlowShots = {
  /** The flow's own `takeScreenshot` images, by their file name (`ct1-01-first-screen.png`). */
  shots: FlowShot[];
  /** What Maestro captured at a failing step, named `screenshots/<file>`. */
  failures: FlowShot[];
};

/**
 * Every screenshot a Maestro run left under `root`, sorted by name.
 *
 * A PNG in a `takeScreenshot` folder is one of the flow's shots; one in a
 * `screenshots` folder is a failing step's. A PNG lying at the top of `root`
 * is the 1.x layout and counts as a shot too, so a host still on an old
 * Maestro keeps working. Anything else (the hierarchy dumps, logs,
 * `commands.json`, which holds every typed value including a test account's
 * password) is left alone and never uploaded.
 *
 * Two flows in one run can each take `home.png`; the second becomes
 * `home-2.png` rather than overwriting the first.
 */
export function collectFlowShots(root: string): FlowShots {
  const shots: FlowShot[] = [];
  const failures: FlowShot[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".png")) continue;
      const parent = path.basename(dir);
      if (parent === SHOT_DIR || dir === root) shots.push({ file: abs, name: e.name });
      else if (parent === FAILURE_DIR) failures.push({ file: abs, name: `${FAILURE_DIR}/${e.name}` });
    }
  };
  walk(root, 0);
  return { shots: dedupeNames(shots), failures: dedupeNames(failures) };
}

function dedupeNames(list: FlowShot[]): FlowShot[] {
  const seen = new Map<string, number>();
  const out = list.map((s) => {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return n === 1 ? s : { ...s, name: s.name.replace(/(\.png)$/i, `-${n}$1`) };
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copy a run's shots into `dest`: the flow's own at the top, a failing step's
 * under `dest/screenshots/`. Returns what was copied, with `file` pointing at
 * the copy.
 */
export function placeFlowShots(found: FlowShots, dest: string): FlowShots {
  mkdirSync(dest, { recursive: true });
  const put = (s: FlowShot): FlowShot => {
    const to = path.join(dest, s.name);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(s.file, to);
    return { file: to, name: s.name };
  };
  return { shots: found.shots.map(put), failures: found.failures.map(put) };
}

/**
 * Upload a ui-test run's screenshots, the flow's own first and then a failing
 * step's, each named `<prefix>-<name>` (`job-serial-ct1-01-first-screen.png`,
 * `job-serial-screenshots/step-010-….png`). Returns the shas that made it; a
 * shot that will not upload is logged and skipped, because the verdict is
 * still the verdict without it.
 */
export async function uploadFlowShots(
  root: string, prefix: string,
  upload: (file: string, name: string) => Promise<string>,
  log: (line: string) => void = () => {},
): Promise<{ shas: string[]; shots: number; failures: number }> {
  const { shots, failures } = collectFlowShots(root);
  const shas: string[] = [];
  for (const s of [...shots, ...failures]) {
    try {
      shas.push(await upload(s.file, `${prefix}-${s.name}`));
    } catch (e) {
      log(`could not upload ${s.name}: ${(e as Error).message}`);
    }
  }
  return { shas, shots: shots.length, failures: failures.length };
}

/**
 * Run one Maestro flow against one device, with its screenshots landing in
 * `cwd`.
 *
 * `takeScreenshot: home` ends up as `cwd/home.png` whatever Maestro version is
 * installed, so pointing `cwd` at a locale's folder is still what files a
 * flow's shots under the right locale without the flow knowing anything about
 * locales. A failing step's shot goes to `cwd/screenshots/`, out of the way of
 * callers that count the PNGs at the top. The rest of Maestro's output (logs,
 * hierarchy dumps, `commands.json` with every typed value) goes to a temp
 * folder that is deleted afterwards, rather than piling up in
 * `~/.maestro/tests` for two weeks.
 *
 * Returns the failure text, or null. A failing flow is not thrown, because
 * every caller wants to record it against one cell of a matrix and carry on
 * with the rest.
 */
/**
 * Maestro hands a flow every shell variable named `MAESTRO_*` (the night command
 * for HomeLake exports the demo household's invite that way, from a file on the
 * executor host). Maestro echoes the commands it runs, so a failed flow's text
 * would carry the value into the job's error and the finding; this blanks it.
 */
export function redactShellSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("MAESTRO_") && v && v.length >= 8 && !/^MAESTRO_(CLI|DRIVER|BIN|OUTPUT)/.test(k)) out = out.split(v).join(`<${k}>`);
  }
  return out;
}

export async function runFlow(
  t: Target, flow: string, cwd: string, env: Record<string, string>, timeoutMs: number,
  bin: string = MAESTRO,
): Promise<string | null> {
  mkdirSync(cwd, { recursive: true });
  const out = mkdtempSync(path.join(os.tmpdir(), "fleet-maestro-"));
  try {
    await exec(
      bin,
      ["--device", t.id, "test", MAESTRO_OUTPUT_FLAG, out,
       ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), flow],
      { timeout: timeoutMs, cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return null;
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    return redactShellSecrets(`${err.stdout ?? ""}${err.message ?? ""}`).trim().slice(-400) || "maestro failed";
  } finally {
    try { placeFlowShots(collectFlowShots(out), cwd); } catch { /* a copy that fails leaves the caller's own "no shots" check to say so */ }
    rmSync(out, { recursive: true, force: true });
  }
}
