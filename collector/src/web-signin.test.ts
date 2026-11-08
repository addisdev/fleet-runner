/**
 * The web sign-in checks: a manifest and a job must agree on signing in
 * before a browser launches, and nothing a secret touched leaves the host.
 */
import {
  debrisKind, shotsSigninEnv, shotsSigninProblem, webTestSigninEnv,
  SHOTS_EMAIL_VAR, SHOTS_PASSWORD_VAR, type WebCreds,
} from "./web-signin.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const SIGNIN = { path: "/", email: "#email", password: "#password", submit: "#go", waitFor: "#me" };
const CREDS: WebCreds = { account: "rider@example.invalid", password: "pw-not-real", emailVar: "E", passwordVar: "P" };

export function runWebSigninChecks(check: Check) {
  check("web signin: no signin, no credentials is fine", shotsSigninProblem({}, false) === null);
  check("web signin: signin with credentials is fine", shotsSigninProblem({ signin: SIGNIN }, true) === null);

  const vacuous = shotsSigninProblem({}, true);
  check("web signin: credentials with no signin block are refused (the vacuous green)",
    vacuous !== null && /no signin block/.test(vacuous), String(vacuous));

  const noAccount = shotsSigninProblem({ signin: SIGNIN }, false);
  check("web signin: a signin block with no account is refused and says how to name one",
    noAccount !== null && /suite\.credentials/.test(noAccount) && /Keychain/.test(noAccount), String(noAccount));

  const partial = shotsSigninProblem({ signin: { ...SIGNIN, submit: "" } }, true);
  check("web signin: an empty selector is named", partial === "shots.json signin.submit must be a non-empty string", String(partial));
  check("web signin: a non-object signin is refused", shotsSigninProblem({ signin: ["#email"] }, true) !== null);

  const env = shotsSigninEnv(CREDS);
  check("web signin: the capture spec gets the fixed env names",
    env[SHOTS_EMAIL_VAR] === CREDS.account && env[SHOTS_PASSWORD_VAR] === CREDS.password, JSON.stringify(Object.keys(env)));
  check("web signin: no credentials, no env", Object.keys(shotsSigninEnv(null)).length === 0);
  const wt = webTestSigninEnv(CREDS);
  check("web signin: web-test gets the names the job chose", wt.E === CREDS.account && wt.P === CREDS.password);

  check("web signin: a trace is withheld after signing in", debrisKind("shot-home/trace.zip", true) === "withhold");
  check("web signin: a video is withheld after signing in", debrisKind("shot-home/video.webm", true) === "withhold");
  check("web signin: a failure screenshot still uploads", debrisKind("shot-home/test-failed-1.png", true) === "upload");
  check("web signin: error-context.md is redacted, not dropped", debrisKind("shot-home/error-context.md", true) === "redact");
  check("web signin: signed out, everything uploads as before", debrisKind("shot-home/trace.zip", false) === "upload");
}
