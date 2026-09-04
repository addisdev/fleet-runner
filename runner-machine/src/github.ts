/**
 * Commit statuses for `report_to.github_status`.
 *
 * The target is `owner/repo@sha`, the same string the collector's own
 * `reportStatus` parses. The token is NEVER read from the job spec: the
 * collector refuses specs containing the word "token" by design, and a runner
 * that accepted one would make that refusal pointless — anyone able to enqueue
 * a job would be able to hand this machine a credential and have it used. It
 * comes from this machine's own environment or it does not exist.
 *
 * The context is `fleet-runner/build`, not `fleet-runner`. The collector posts
 * the terminal status under `fleet-runner` from its own token when a final row
 * arrives, and GitHub keys a commit's statuses by context — sharing one would
 * mean two writers racing over a single check, with the loser's verdict simply
 * gone. A separate context is two checks that each say what its writer knows:
 * the collector's says the job finished, this one says the build did, and the
 * `pending` this one posts at claim is a state the collector cannot post at all
 * because it does not know when work actually started.
 */

export const STATUS_CONTEXT = "fleet-runner/build";
export type StatusState = "pending" | "success" | "failure" | "error";

export type StatusTarget = { owner: string; repo: string; sha: string };

/**
 * Parses `owner/repo@sha`.
 *
 * The sha must look like one. A target of `owner/repo@main` would post a status
 * against a ref GitHub resolves at request time, so the check would land on
 * whatever the branch tip is when the build finishes rather than on the commit
 * that was built — which on a busy branch is a green tick against somebody
 * else's commit.
 */
export function parseStatusTarget(target: string | undefined | null): StatusTarget | null {
  if (!target) return null;
  const m = /^([^/\s]+)\/([^@\s]+)@([0-9a-fA-F]{7,40})$/.exec(target.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], sha: m[3].toLowerCase() };
}

/** The token, from this machine's environment only. Null means "do not post". */
export function statusToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.FLEET_GITHUB_TOKEN || env.GITHUB_TOKEN || null;
}

export function githubApi(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FLEET_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
}

/**
 * Posts one commit status. Answers what happened rather than throwing: a build
 * is not failed by GitHub being unreachable, and a status that could not be
 * posted is a line in the agent's log, not an error row.
 */
export async function postCommitStatus(
  target: string | undefined | null,
  state: StatusState,
  description: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ posted: boolean; detail: string }> {
  const parsed = parseStatusTarget(target);
  if (!parsed) return { posted: false, detail: target ? `bad github_status target: ${target}` : "no github_status target" };
  const token = statusToken(env);
  if (!token) return { posted: false, detail: "no token in this machine's environment; status not posted" };

  try {
    const res = await fetch(`${githubApi(env)}/repos/${parsed.owner}/${parsed.repo}/statuses/${parsed.sha}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      // GitHub truncates a description over 140 characters; truncating here
      // means the visible text ends where this code chose rather than wherever
      // a compiler diagnostic happened to be.
      body: JSON.stringify({ state, context: STATUS_CONTEXT, description: description.slice(0, 140) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { posted: res.ok, detail: `github responded ${res.status}` };
  } catch (e) {
    return { posted: false, detail: `github unreachable: ${(e as Error).message}` };
  }
}
