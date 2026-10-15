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
fleetr artifact <sha256> --out ./artifacts
```

- `--json` on every command prints the API's answer and nothing else; progress
  goes to stderr.
- The exit code is the verdict: **0** passed, **1** failed (or mixed,
  cancelled), **2** usage error or invalid spec, **3** still running when
  `--timeout` ran out, **4** skipped (nothing ran), **5** refused or
  unreachable. So `fleetr run ... && deploy` means what it says.
- `fleetr run` takes a workload and flags (`--device`, `--pool`, `--match`,
  `--app`, `--param key=value`, `--fanout`) or a whole spec (`--spec FILE`,
  `-` for stdin), and validates before it queues.

Which collector: `--url`, then `FLEET_RUNNER_URL`, then `FLEET_URL`, then
`~/.fleet/config.json`. Which token: `--token`, then `FLEET_RUNNER_TOKEN`, then
`FLEET_TOKEN`, then what `fleetr login` saved for that URL.

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

Add `"--url", "http://host:8788"` to the args to point at another collector.
Tools: `fleet_devices`, `fleet_workloads`, `fleet_validate`, `fleet_run`,
`fleet_job`, `fleet_cancel`, `fleet_retry`, `fleet_results`, `fleet_flaky`,
`fleet_artifact`, `fleet_whoami`. Each carries read-only and destructive
annotations and, where it returns a summary, an output schema. Screenshots come
back as images. Jobs, workloads, devices and artifacts are also readable as
resources (`fleet://job/{id}` and so on).

`fleet_run` waits for the verdict by default (up to 15 minutes locally); pass
`wait: false` and follow with `fleet_job` for anything longer.

## The remote gateway

For people and chat clients that cannot run `fleet`, the gateway serves the
same tools over MCP's Streamable HTTP transport behind your identity
provider's OAuth. Jobs started through it are recorded as the person who
started them. Setup, the IdP registration and what it refuses:
[Authentication and the remote MCP gateway](deploy/auth.md#the-remote-mcp-gateway).
