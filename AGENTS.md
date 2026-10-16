# Working on Fleet Runner

Notes for coding agents changing this repository. To *use* the device lab
from an agent, see [`skills/fleet-runner/SKILL.md`](skills/fleet-runner/SKILL.md)
(`fleet skill install` puts it where Cursor, Claude Code and Codex look).

## Layout

| Path | What |
|---|---|
| `collector/` | The brain: Fastify + `node:sqlite`, the queue, the dashboard (`dash/`), the host executor |
| `collector/src/workloads/explore/` | Exploratory QA: a vision model drives an app from mission cards (`collector/examples/missions/`); see `docs/explore/internals.md` |
| `collector/src/api/v1/` | The control API. `routes.ts` is the single route table: it registers the routes, generates `openapi.json` and the typed client |
| `collector/src/client/` | The generated client (`api.gen.ts`) and its transport. The CLI and the MCP server use nothing else |
| `fleet/` | The `fleet` / `fleetr` command: runs a brain or a runner, plus the work commands, `fleet mcp` and the remote gateway |
| `desktop/` | A Tauri menu-bar app around `fleet`. A front door, not a runner; compiled in CI on macOS and launched in CI on Linux (`desktop/ci/launch-smoke.sh`), never run on a Mac |
| `runner-machine/`, `runner-android/`, `runner-ios/`, `runner-roku/`, `collector/runner-web/` | Runners. They speak the runner protocol (`/devices/register`, `/devices/:id/next-job`, `/results`), not `/api/v1` |
| `skills/fleet-runner/` | The agent skill. Its tables are generated |
| `bug-garden/` | An Android fixture app with twenty planted defects, for scoring exploratory QA |
| `docs/` | The mkdocs site. Built with `--strict`, so a broken link fails CI |

## Suites

Run the one for what you touched; [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

- `cd collector && npm test`: about five minutes; starts its own collector on a temp database.
- `cd fleet && npm test`: CLI, MCP and gateway tests against a real collector.
- `cd runner-machine && npm test`: about a second.

## Rules

- **Change the API in the route table only.** Add or edit the entry in
  `collector/src/api/v1/routes.ts`, then `npm run gen:api` in `collector/`.
  Never hand-edit `openapi.json` or `api.gen.ts`; the suite fails when they
  drift.
- **The CLI and the MCP tools stay thin.** If one needs data the API does not
  return, add it to the API. A tool that stitches three calls together is an
  endpoint that is missing.
- **Every new error has a code.** Errors are `{error:{code,message,hint?}}`
  with `code` from the `ErrorCode` union; the hint says what to do next.
- **Do not change the runner protocol's shape.** Shipped phones and TVs speak
  it and cannot be updated in lockstep. New fields are optional; nothing is
  removed.
- **A new metric goes in `collector/schemas/result.schema.json`** in the same
  change that emits it.
- **A tool or exit code change: `npm run skill:gen` in `fleet/`.**
- Branch from `develop`; add a `CHANGELOG.md` line under `[Unreleased]` for
  anything user-visible.
