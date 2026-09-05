/**
 * The trust boundary for the `shell` workload.
 *
 * `POST /jobs` on the collector is unauthenticated by design — the README says
 * so outright — so anyone who can reach the collector can enqueue a job, and a
 * workload that runs an arbitrary script would hand them this machine. The
 * allowlist is what makes `shell` safe to declare: a file the machine's owner
 * maintains by hand, holding the sha256 of every script this machine is
 * willing to execute.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. The check happens on the sha the JOB NAMED, before anything is fetched.
 *    Downloading first and checking second would mean an unlisted script had
 *    already been pulled onto the machine, and the artifact store is writable
 *    by the same unauthenticated POST.
 * 2. Only an exact 64-hex match counts. No prefixes, no substrings: a sha that
 *    differs by one character is a different script.
 * 3. No allowlist is not an empty allowlist in name only — it means `shell` is
 *    never declared, so the collector cannot even offer this machine the job.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./git.js";

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Where the owner keeps the list. One place, overridable for testing and for
 *  operators who keep it under configuration management. */
export function allowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_SHELL_ALLOWLIST ?? path.join(dataDir(env), "shell-allowlist.txt");
}

/**
 * The shas in an allowlist file.
 *
 * `#` comments and blank lines are skipped, and anything after the sha on a
 * line is a note for whoever reads the file — a bare list of hashes with no
 * room to say what each one is would be a file nobody could maintain, and an
 * unmaintainable allowlist gets replaced with a wildcard.
 *
 * A line that is not a sha is DROPPED, not accepted loosely. The failure this
 * avoids is a typo'd or truncated hash silently becoming an entry that can
 * never match, which reads to the operator as "I listed it and it still
 * refuses" — so `entriesRejected` is reported alongside, and the workload says
 * so in its refusal.
 */
export function parseAllowlist(text: string | null | undefined): { allowed: string[]; rejected: string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const first = line.split(/\s+/)[0] ?? "";
    const candidate = first.toLowerCase();
    if (SHA256_RE.test(candidate)) {
      if (!allowed.includes(candidate)) allowed.push(candidate);
    } else {
      rejected.push(first.slice(0, 80));
    }
  }
  return { allowed, rejected };
}

/**
 * Is this sha one the owner listed?
 *
 * Case-insensitive because a hash pasted from `shasum` and one pasted from a
 * dashboard can differ in case and are the same hash; nothing else is
 * forgiven. A value that is not a well-formed sha256 is never allowed, which
 * matters because the job spec is attacker-controlled and `""` or `"*"` must
 * not become a match against anything.
 */
export function isAllowlisted(sha256: unknown, allowed: readonly string[]): boolean {
  if (typeof sha256 !== "string") return false;
  const candidate = sha256.trim().toLowerCase();
  if (!SHA256_RE.test(candidate)) return false;
  return allowed.includes(candidate);
}

/** The list on disk. A missing or unreadable file is an empty list, never a throw. */
export async function loadAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ allowed: string[]; rejected: string[]; file: string; exists: boolean }> {
  const file = allowlistPath(env);
  let text: string | null = null;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { allowed: [], rejected: [], file, exists: false };
  }
  return { ...parseAllowlist(text), file, exists: true };
}
