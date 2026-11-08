/**
 * Signing in for the web workloads (`web-shots`, `web-test`).
 *
 * The rule is the one secrets.ts sets out for the phone suites: the job names
 * the ACCOUNT in `suite.credentials`, and the executor resolves the password
 * from its own login Keychain. Before this, both web paths ignored
 * `suite.credentials` while the collector accepted it, so a spec that asked to
 * sign in captured the signed-out page and passed: green and vacuous. These
 * checks make the two halves agree before a browser launches.
 */
import { extname } from "node:path";

/** What resolveCredentials hands back. The password never leaves this host. */
export type WebCreds = { account: string; password: string; emailVar: string; passwordVar: string };

/**
 * The env names the generic capture spec reads. Fixed rather than taken from
 * `email_var`: `_shots/capture.spec.ts` is shared by every site, so it cannot
 * read a name each job picks.
 */
export const SHOTS_EMAIL_VAR = "SHOTS_SIGNIN_EMAIL";
export const SHOTS_PASSWORD_VAR = "SHOTS_SIGNIN_PASSWORD";

/** shots.json `signin`: how the capture spec signs in, as selectors. */
export type ShotsSignin = {
  path: string; email: string; password: string; submit: string; waitFor: string;
};

const SIGNIN_FIELDS = ["path", "email", "password", "submit", "waitFor"] as const;

/**
 * Why this manifest and this job cannot sign in honestly, or null if they can.
 *
 * Both mismatches are refused, not warned: a manifest that signs in with no
 * account fails every page at the form, and an account with nothing in the
 * manifest to use it is the vacuous green this file exists to end.
 */
export function shotsSigninProblem(manifest: { signin?: unknown }, hasCreds: boolean): string | null {
  const s = manifest.signin;
  if (s === undefined) {
    return hasCreds
      ? "the job names suite.credentials but shots.json has no signin block, so nothing would sign in"
      : null;
  }
  if (!s || typeof s !== "object" || Array.isArray(s)) return "shots.json signin must be an object";
  for (const f of SIGNIN_FIELDS) {
    const v = (s as Record<string, unknown>)[f];
    if (typeof v !== "string" || v.trim() === "") return `shots.json signin.${f} must be a non-empty string`;
  }
  if (!hasCreds) {
    return "shots.json signs in, but the job names no suite.credentials " +
      '(add suite.credentials: { account: "<email>" }; the password comes from the executor\'s Keychain)';
  }
  return null;
}

/** Env for the shared capture spec. */
export function shotsSigninEnv(creds: WebCreds | null): Record<string, string> {
  return creds ? { [SHOTS_EMAIL_VAR]: creds.account, [SHOTS_PASSWORD_VAR]: creds.password } : {};
}

/** Env for a site's own web-test suite, under the names the job gave. */
export function webTestSigninEnv(creds: WebCreds | null): Record<string, string> {
  return creds ? { [creds.emailVar]: creds.account, [creds.passwordVar]: creds.password } : {};
}

const TEXT_DEBRIS = new Set([".md", ".json", ".txt", ".log"]);

/**
 * What Playwright left behind that may be uploaded after a signed-in run.
 *
 * A trace records every action's arguments, so trace.zip holds the password
 * typed into the form; a video can show it being typed. Neither can be
 * redacted after the fact, so neither is uploaded when a secret was in play.
 * Screenshots are kept (a password field renders as dots), and text files go
 * up only after `redact`.
 */
export function debrisKind(name: string, signedIn: boolean): "upload" | "redact" | "withhold" {
  if (!signedIn) return "upload";
  const ext = extname(name).toLowerCase();
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") return "upload";
  if (TEXT_DEBRIS.has(ext)) return "redact";
  return "withhold";
}
