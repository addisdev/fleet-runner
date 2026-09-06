/**
 * The rule every probe in this repo obeys: answer, or answer null. Never throw.
 *
 * A descriptor is built by shelling out to seven different tools across three
 * operating systems, and on any given machine some of them are missing, some
 * need a permission nobody granted, and some print something new after an OS
 * update. If any one of those could take down registration, the agent would be
 * a machine-specific script rather than something you can drop on a laptop.
 * So the failure of a probe is a null field, which is honest, and the failure
 * of every probe is a descriptor of nulls, which still registers.
 */
import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export type Run = { code: number | null; stdout: string; stderr: string };

/** Runs a command and never throws: a missing binary is `code: null`. */
export function run(cmd: string, args: string[], timeoutMs = 8000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number"
        ? ((err as { code: number }).code)
        : err ? null : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** stdout of a command that exited 0, trimmed; null for anything else. */
export async function out(cmd: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  const r = await run(cmd, args, timeoutMs);
  if (r.code !== 0) return null;
  const s = r.stdout.trim();
  return s === "" ? null : s;
}

/** File contents, or null if it does not exist or cannot be read. */
export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Wraps any probe so a thrown error becomes null. */
export async function orNull<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Resolves an executable the way a shell would, without a shell.
 *
 * Used by the capability probes, where the answer decides what this agent
 * tells the collector it can run — so "is it on PATH" has to mean "is there a
 * file there that this user can execute", not "does the name look plausible".
 */
export async function which(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (bin.includes(path.sep) || bin.includes("/")) {
    return (await executable(bin, env)) ? path.resolve(bin) : null;
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? pathExts(env) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (await executable(candidate, env)) return candidate;
    }
  }
  return null;
}

/** The extensions Windows will run, lower-cased. */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Can this user run that file?
 *
 * Two different questions on two families, and asking the POSIX one on Windows
 * gets the wrong answer in the dangerous direction.
 *
 * On POSIX it is the execute bit, which is what `X_OK` tests.
 *
 * On Windows there is no execute bit at all: `fs.access(X_OK)` succeeds for any
 * file the user can read, so a text file would answer "yes, executable". What
 * actually decides whether Windows will run something is its EXTENSION being in
 * PATHEXT. Testing permission there means `FLEET_LLAMA_BENCH` pointing at a
 * README resolves as a llama-bench, and the agent then declares
 * `benchmark:llama.cpp` — taking those jobs off the queue from a machine that
 * could have run them, and returning an error row an hour later. That is the
 * exact failure the capability probes exist to prevent, and the Windows CI job
 * added in this wave is what surfaced it.
 */
async function executable(file: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await access(file, constants.F_OK);
      return pathExts(env).includes(path.extname(file).toLowerCase());
    }
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First capture group of the first matching line, or null. */
export function firstMatch(text: string | null, re: RegExp): string | null {
  if (!text) return null;
  const m = re.exec(text);
  return m?.[1]?.trim() || null;
}

/**
 * Finite number or null — the only way a number reaches a descriptor.
 *
 * Null, undefined, empty string and whitespace are rejected before the
 * conversion, because `Number(null)` and `Number("")` are both 0 and this
 * function's whole job is to sit between a probe that found nothing and a
 * field that would then read as a machine with zero RAM at zero percent
 * battery.
 */
export function finite(n: unknown): number | null {
  if (n === null || n === undefined) return null;
  if (typeof n === "string" && n.trim() === "") return null;
  if (typeof n === "boolean") return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}
