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
| `fleetr whoami` | Which collector, its auth mode, who you are to it and your scopes |
| `fleetr login [--url U] [--token T]` · `fleetr logout [--url U]` | Save a token for a collector (from `--token` or stdin), or forget it |

Which collector: `--url`, then `FLEET_RUNNER_URL`, then `FLEET_URL`, then
`~/.fleet/config.json`. Which token: `--token`, then `FLEET_RUNNER_TOKEN`, then
`FLEET_TOKEN`, then what `fleetr login` saved for that URL. `FLEET_SOURCE`
overrides the `source` recorded on jobs (`cli` by default), for example
`FLEET_SOURCE=ci` in a workflow.

## The skill

```bash
fleet skill install                 # into ~/.cursor, ~/.claude, ~/.codex skills, whichever exist
fleet skill install --target DIR    # or a project's own skills directory
fleet skill show
```

A short file telling an agent the order to call things in (devices,
workloads, validate, run, wait, artifacts), what each verdict and exit code
means, and what not to do: report a skip as a pass, pin someone else's device,
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
`fleet_artifact`, `fleet_whoami`. Each carries read-only and destructive
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
