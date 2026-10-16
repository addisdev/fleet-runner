---
name: fleet-runner
description: Run app UI flows, installs, benchmarks and web checks on real devices (phones, tablets, TVs, watches, Macs) in the Fleet Runner device lab, through its fleet_* MCP tools or the `fleetr` command. Use when a change needs proof on hardware rather than a simulator, when asked to test a build on a device, or to read a lab job's verdict, screenshots or logs. Not for GitHub Actions runners or CI queues (that is the fleet-cockpit skill).
---
<!-- fleet-runner skill: installed by `fleet skill install`; the generated blocks come from fleet/src/skill.ts -->

# Fleet Runner device lab

A collector queues jobs; real devices claim the ones they can run and report
a verdict, metrics and artifacts. Every way in calls the same API
(`/api/v1`), so the answers match. Use the MCP tools if this session has
them, otherwise the command.

**Which "fleet".** This skill is the device lab: the `fleetr` command
(`fleet` is the same program), collector on port 8788, tools named `fleet_*`
such as `fleet_run` and `fleet_devices`. If a `fleet` command answers with
runner or CI verdicts, or lives on port 7878, it is a different tool. Always
type `fleetr`, and set `FLEET_RUNNER_URL` rather than `FLEET_URL` when you need
to point it somewhere: `FLEET_RUNNER_URL` and `FLEET_RUNNER_TOKEN` win over
the shared names.

<!-- generated:tools -->
| MCP tool | Command | Scope | Changes anything |
|---|---|---|---|
| `fleet_devices` | `fleetr devices` | read | no |
| `fleet_workloads` | `fleetr workloads [NAME]` | read | no |
| `fleet_validate` | `fleetr run ... --validate` | run | no |
| `fleet_run` | `fleetr run WORKLOAD ...` | run | yes |
| `fleet_job` | `fleetr job ID / fleetr wait ID` | read | no |
| `fleet_cancel` | `fleetr cancel ID` | run | yes, destructive |
| `fleet_retry` | `fleetr retry ID` | run | yes |
| `fleet_results` | `fleetr results` | read | no |
| `fleet_flaky` | `fleetr flaky` | read | no |
| `fleet_artifact` | `fleetr artifact SHA [--out FILE]` | read | no |
| `fleet_whoami` | `fleetr whoami` | read | no |
<!-- /generated:tools -->

Add `--json` to any command when you will parse the output: stdout is then
exactly the API's answer, and progress goes to stderr.

## Order

1. `fleetr whoami` once: which collector, and what you may do there. With
   auth on and no token, stop and ask the user to run `fleetr login`.
2. `fleetr devices` (`fleet_devices`): what is online. Nothing online means
   nothing will run; say so instead of queueing.
3. `fleetr workloads NAME` (`fleet_workloads name=NAME`): the workload's
   parameters and an example spec that validates. Start from the example.
4. `fleetr run WORKLOAD ... --validate` (`fleet_validate`): fix every problem
   it names, and check which devices it would land on.
5. `fleetr run WORKLOAD ...` (`fleet_run`): queues, waits and prints the
   verdict. For a long job, `--no-wait` (`wait: false`) and then step 6.
6. `fleetr wait ID` (`fleet_job` with `wait_s`): block until it finishes.
7. `fleetr artifact SHA --out DIR` (`fleet_artifact`): screenshots, logs and
   reports named in the summary. Look at the screenshot before describing a UI
   failure.

## Verdicts and exit codes

A job's `verdict` is one of `passed`, `failed`, `mixed` (some devices passed),
`skipped`, `cancelled`, or, while unfinished, `queued`, `waiting` (on another
job) or `running`. `fleetr run`, `job`, `wait` and `retry --wait` exit with:

<!-- generated:exits -->
- **0** passed: every device ran it and passed.
- **1** failed, mixed or cancelled: read `failing_step` and `error` before doing anything else.
- **2** usage error or invalid spec: fix the flags or the spec; `--validate` names each problem.
- **3** still running when `--timeout` ran out: `fleetr wait ID` picks it up again.
- **4** skipped: the job was claimed but reported `skipped:` instead of running (the app is not installed, the device was locked by another job, no attached device matched a host job, the host was under memory pressure, no Roku password on the host). Never report this as a pass. A spec nothing can run is refused before it runs instead: exit 2 from validation, or 5 when the collector refuses it at enqueue.
- **5** refused or unreachable: no permission, unknown workload or job, or no collector. Report it; do not work around it.
<!-- /generated:exits -->

## Rules

- **Skipped is not passed.** Report it as "did not run" with the reason.
- **Target a pool or a match, not a device id**, unless the user named the
  device: other people's jobs are pinned to devices too. `--pool P` or
  `--match "os ~ 'android' && ram_mb >= 4000"`.
- **Retry at most once, and only after reading the error.** A failure that
  repeats on the same device and build is the app, not the lab;
  `fleetr flaky` shows tests known to flip.
- **Wait with `fleetr wait` or `fleet_job wait_s`**, never a loop of
  `fleetr job` or `sleep`.
- **Cancel only jobs you started.** A 403 `forbidden` on cancel or retry means
  someone else's job: leave it.
- **Never run the `shell` workload** unless the user asked for it by name. The
  remote connector refuses it regardless.
- **Do not start, stop or reconfigure the lab** (`fleet up`, `fleet service`,
  `fleet config`): those belong to whoever runs it.
- **`unauthorized` or `forbidden`: report it.** Do not look for another token,
  and do not call the collector's unversioned routes (`/jobs`, `/api/jobs`)
  with curl to get around it.

## When it does not work

- `unreachable`: check `fleetr whoami`; the collector may be on another
  machine (`FLEET_RUNNER_URL=http://host:8788`).
- Queued and never claimed: no live device matches. `--validate` lists the
  candidates; an empty list means the targets or the workload's capability
  match nothing online.
- `invalid_spec`: the error lists each field. Unknown top-level fields are
  refused, so a typo is an error rather than a silently ignored setting.
