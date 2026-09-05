/**
 * Scrubbing secrets out of text that is about to become an artifact.
 *
 * The same rule as the collector's `redact` in collector/src/secrets.ts, and
 * deliberately a re-implementation rather than an import — this agent depends
 * on the protocol, not on the collector's source tree, exactly as
 * `protocol.ts` and `collector.ts` do.
 *
 * The `shell` workload is why this exists here. A script from the artifact
 * store runs with a minimal environment, but "minimal" is a list this file
 * maintains and a script can still print something it was handed; the captured
 * output is uploaded to a store anyone on the dashboard can download, so a
 * token that reaches it has leaked no matter how carefully it was fetched.
 */

/**
 * Environment variable names whose VALUES must never reach an artifact.
 *
 * Matched on the name, because the value of a token is by definition
 * unrecognisable. `_KEY` rather than `KEY` so that `KEYBOARD_LAYOUT` and
 * friends do not turn a common word into a redaction pattern.
 */
export const SECRET_ENV_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY)(_|$)|_KEY$/i;

/**
 * Remove secret values from text bound for the artifact store.
 *
 * Values shorter than four characters are skipped: a two-character "secret"
 * matches half of any log, and a log that is mostly `[redacted]` is a log
 * nobody can read — which is its own failure, since the log is the answer to
 * "why did this script fail".
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}

/** The values in this process's environment that must not be published. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 4) continue;
    if (SECRET_ENV_RE.test(name)) values.push(value);
  }
  // Longest first, so a token that contains a shorter one is not left with a
  // recognisable prefix after the shorter match has already been replaced.
  return values.sort((a, b) => b.length - a.length);
}
