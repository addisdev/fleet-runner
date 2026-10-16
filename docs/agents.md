# AI agents and automation

Four ways in, one API underneath. The CLI and both MCP servers call the
[control API](api.md#control-api-apiv1) through the same generated client, so
they return the same answers and fail with the same error codes.

| You are | Use |
|---|---|
| A coding agent (Cursor, Claude Code, Codex) on a machine with `fleet` | The CLI, plus the skill |
| A coding agent that prefers tools to shell commands | `fleet mcp` over stdio |
| A chat client, or anyone without `fleet` installed | The remote gateway, `fleet mcp --http` |
| A script or CI job | The CLI with `--json`, or the HTTP API directly |

## The CLI

`fleetr` and `fleet` are the same program. The skill and these docs use
`fleetr` because other tools also answer to `fleet`.

```bash
fleetr devices                                  # what is online
fleetr workloads benchmark                      # params and an example spec
fleetr run benchmark --pool phones --validate   # check without queueing
fleetr run benchmark --pool phones              # queue, wait, print the verdict
mkdir -p artifacts && fleetr artifact <sha256> --out ./artifacts
```

`--out` is a directory only if it already exists (and has no extension in its
name); then the file lands there under the artifact's own name. Otherwise it is
the file name to write. `--out -` writes to stdout.

- `--json` on every command prints the API's answer and nothing else; progress
  goes to stderr.
- The exit code is the verdict: **0** passed, **1** failed (or mixed,
  cancelled), **2** usage error or invalid spec, **3** still running when
  `--timeout` ran out, **4** skipped (nothing ran), **5** refused or
  unreachable. So `fleetr run ... && deploy` means what it says.
- `fleetr run` takes a workload and flags, or a whole spec (`--spec FILE`,
  `-` for stdin) that the flags then add to, and validates before it queues.
  Validation is the control API's, so an unknown top-level field in the spec
  is an error.

| `fleetr run` flag | |
|---|---|
| `--device ID` · `--pool P` · `--match EXPR` | `targets.device_id`, `.pool`, `.match` |
| `--target k=v` | Any other `targets` field; repeatable, dotted keys nest |
| `--exclusive` | `targets.exclusive: true` |
| `--app NAME` | `app.name`, with `--build` and `--sha256` (both default `latest`) and `--platform` |
| `--param k=v` | A workload param; repeatable, dotted keys nest, values parsed as JSON where they parse |
| `--fanout` | One child job per matching device |
| `--backend B` · `--priority N` · `--id JOB_ID` | The spec fields of the same names; `--id` is an idempotency key |
| `--validate` | Validate, print where it would land, and stop |
| `--no-validate` | Skip the dry run and let the enqueue refuse it instead |
| `--no-wait` | Print the job id and exit 0 |
| `--timeout S` | How long to wait for the verdict; default 1800. Exit 3 if it runs out |

| Other commands | |
|---|---|
| `fleetr devices [--all] [--platform P] [--pool P]` | Online devices, or the whole shelf |
| `fleetr workloads [NAME] [--available]` | What the fleet can run; NAME prints the params schema and an example spec |
| `fleetr job ID` · `fleetr wait ID [--timeout S]` | The verdict now, or when it finishes (default 1800 s); exits with the verdict |
| `fleetr cancel ID [--reason R]` | Cancel; cascades over a fan-out and fails whatever waited on it |
| `fleetr retry ID [--device ID] [--pool P] [--wait]` | Run again under a new id; `--wait` waits and exits with the verdict |
| `fleetr results [JOB] [--device] [--workload] [--job] [--failures] [--limit N]` | Result rows, final rows only unless a job is named; default 20 |
| `fleetr flaky [--device ID] [--app NAME]` | Builds that both passed and failed on one device |
| `fleetr findings [--app A] [--state open\|triaged\|all] [--verdict V] [--check C] [--since 24h] [--limit N] [--page N]` | What night QA found, newest sighting first; default 50 per page |
| `fleetr finding ID [--flow FILE\|-]` | One finding: steps, evidence, regression test, verdict history. `--flow` writes its Maestro (or tvloop) replay flow; `-` or no file is stdout |
| `fleetr verdict ID real\|duplicate\|not-a-bug\|agent-mistake\|fixed\|reopen [--note T] [--duplicate-of ID]` | Judge a finding. `fixed` only after `real`, once a fix has merged; exit 5 (`conflict`) otherwise |
| `fleetr whoami` | Which collector, its auth mode, who you are to it and your scopes |
| `fleetr login [--url U] [--token T]` · `fleetr logout [--url U]` | Save a token for a collector (from `--token` or stdin), or forget it |

Which collector: `--url`, then `FLEET_RUNNER_URL`, then `FLEET_URL`, then
`~/.fleet/config.json`. Which token: `--token`, then `FLEET_RUNNER_TOKEN`, then
`FLEET_TOKEN`, then what `fleetr login` saved for that URL. `FLEET_SOURCE`
overrides the `source` recorded on jobs (`cli` by default), for example
`FLEET_SOURCE=ci` in a workflow.

## A morning brief

`fleetr findings --since 24h --json` is the input for a scheduled agent
session that starts from last night's findings. This repository does not build
that session; it makes the input exist, in a shape that will not change
without a version note in the changelog:

```json
{
  "items": [
    {
      "id": 42, "app": "greenfolio", "build": "1.4 (12)", "platform": "android",
      "device_id": "R58M...", "job_id": "explore-...", "mission_id": "add-a-plant",
      "check": "crash", "severity": "high",
      "title": "Crash: java.lang.NullPointerException", "detail": "...",
      "screen": "02c1db49ee", "screen_name": "Add plant",
      "steps": ["On \"My plants\":", "  Tap \"Add plant\"", "..."],
      "replay": { "kind": "maestro", "sha256": "...", "attempts": 2, "reproduced": 2 },
      "replay_label": "reproduced 2/2",
      "artifacts": { "shot": "...", "sheet": "...", "trajectory": "...", "replay": "..." },
      "first_seen": "2026-10-15T02:14:09Z", "last_seen": "2026-10-15T02:14:09Z",
      "seen_count": 1, "builds_seen": ["1.4 (12)"],
      "verdict": null, "verdict_note": null, "verdict_at": null, "duplicate_of": null,
      "status": "open", "issue": null, "regression": null
    }
  ],
  "page": 1, "per_page": 50, "total": 1, "pages": 1
}
```

The rules for reading it:

- `since` filters on **last seen**, so a finding first seen a week ago that
  came back last night is in the list; `first_seen` tells them apart.
- `verdict: null` is open: nobody has judged it, or a regression test
  reopened it (`fleetr finding ID` shows a `regressed on build ...` line).
- `agent_mistake` and `not_a_bug` are not bugs in the app.
- `replay_label` is the evidence: `reproduced 2/2` is solid, `flaky 1/2` is
  weaker, `crash log` means the platform's crash log is the evidence.
- `regression` is `null`, or the state of the test it became: `candidate`
  (real), `active` (fixed, in the nightly) or `retired`.
- The list envelope is the control API's; `--page N` and `--limit N` page it,
  and `total` says how many match. The Finding schema in `openapi.json` is the
  full contract.

Then `fleetr finding ID --flow repro.yaml` gives the flow to reproduce it with
(`maestro test repro.yaml`, or `fleetr run ui-test` with it in a flows
directory), and once a fix has merged, `fleetr verdict ID fixed --note "PR
#123"` makes it a regression test in the app's nightly.

## The skill

```bash
fleet skill install                 # into ~/.cursor, ~/.claude, ~/.codex skills, whichever exist
fleet skill install --target DIR    # or a project's own skills directory
fleet skill show
```

A short file telling an agent the order to call things in (devices,
workloads, validate, run, wait, artifacts), what each verdict and exit code
means, how to read a finding (`agent_mistake` is not a bug; never mark one
`fixed` without a fix merged), and what not to do: report a skip as a pass, pin someone else's device,
retry a failure without reading it, poll in a loop, or run `shell`. Its tool
and exit-code tables are generated from the code and checked by the test
suite, so they cannot fall behind the binary.

## MCP over stdio

```json
{
  "mcpServers": {
    "fleet-runner": { "command": "fleet", "args": ["mcp"] }
  }
}
```

Add `"--url", "http://host:8788"` to the args to point at another collector,
and `"--token", "fr_..."` if it has tokens on (or set `FLEET_RUNNER_TOKEN` in
the server's `env`; a saved `fleetr login` for that URL also works).
Tools: `fleet_devices`, `fleet_workloads`, `fleet_validate`, `fleet_run`,
`fleet_job`, `fleet_cancel`, `fleet_retry`, `fleet_results`, `fleet_flaky`,
`fleet_artifact`, `fleet_findings`, `fleet_finding`, `fleet_verdict`,
`fleet_whoami`. `fleet_finding` returns the replay flow's text inline when it
is 16 KiB or less (nearly always); `fleet_verdict` is the one findings tool
that changes anything, and needs the `run` scope. Each carries read-only and destructive
annotations and, where it returns a summary, an output schema. Screenshots come
back as images. Jobs, workloads, devices and artifacts are also readable as
resources (`fleet://job/{id}` and so on).

`fleet_run` waits for the verdict by default: `timeout_s` defaults to 900
(15 minutes) locally and is capped at 3600; through the remote gateway it
defaults to 45 s and is capped at 55. Pass `wait: false` and follow with
`fleet_job`, whose `wait_s` holds the call up to 120 s (55 remotely; default 0,
answer now).

## The remote gateway

For people and chat clients that cannot run `fleet`, the gateway serves the
same tools over MCP's Streamable HTTP transport behind your identity
provider's OAuth. Jobs started through it are recorded as the person who
started them. Setup, the IdP registration and what it refuses:
[Authentication and the remote MCP gateway](deploy/auth.md#the-remote-mcp-gateway).
