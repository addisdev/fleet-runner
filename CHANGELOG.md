# Changelog

Notable changes to Fleet Runner. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

One version covers every component. They ship no shared code, only a JSON
protocol — and that protocol is the thing that changes, so it is the thing the
version tracks. A release note says which components moved. The wire protocol
itself is `"schema": 1` and stays there until something breaks compatibility,
independently of the version below.

Since 0.5.0 that is enforced rather than asserted: `VERSION` at the repository
root is the source, `scripts/version.mjs` writes it into all thirteen places, and
a CI job fails when they disagree.

## [Unreleased]

### Added

- **A pull request's build no longer becomes the nightly's `latest`.**
  `ci-upload` always tagged an upload with its app, and `ci-enqueue` did
  whenever the spec named one, so the next nightly asking for `latest` tested
  an unmerged branch. An upload can now carry `x-artifact-channel: pr`, which
  `"sha256": "latest"` never resolves to; both scripts send it when
  `GITHUB_EVENT_NAME` is `pull_request` (or with `--channel pr`). The pull
  request's own job still names its build by hash. Builds uploaded before this
  count as merged builds, and the same bytes republished from main come off the
  channel. The `/api/v1` artifact document shows it as `channel: pr|main`
  since #96.
- **`FLEET_PEER_TOKENS`: the brain switcher can read a peer with tokens on.**
  The peers proxy sent no token, so a peer running `FLEET_AUTH=tokens`
  answered 401 through it. Each peer's URL now maps to a `read` token that
  peer issued, sent only to that peer.
- **An explore night admitted late runs short instead of not at all.**
  `scripts/explore-night.ts` now knows when the night ends: `--until`
  (default 07:30, ultra's night-queue stop) or the job's own `max_minutes`,
  read from the night queue's manifest for `$NIGHT_JOB`, whichever is first.
  When the specs ask for more than is left, each gets a proportional share,
  the workload runs its highest-priority cards in it, and the result says so
  on an `ok` row: `short night: ran 3 of 7 cards: 40 minutes left of the 60
  asked`. Under 15 minutes (`--min-minutes`) the night is posted as a skip
  rather than started. New metrics `explore_cards_planned` and
  `explore_minutes` record what the device was given. The night queue's own
  admission wait (120 minutes behind a CI job on 10-14) is outside this
  repository and unchanged. Not yet seen on a real night.
- **`explore-night.ts --dry-run`** opens the tunnel, runs the build and time
  checks against the live brain and prints the plan, without enqueueing,
  posting, warming or booting anything.
- **A job that ran nothing now has a status of its own: `skipped`.** A runner
  that could not run a job says `ok: true` with an error beginning `skipped:`,
  and the queue closed that as `done`, so the job list, the status counts and
  the digest counted it as a pass: `nightly-tvloop-hardware` and three explore
  jobs a night "passed" in two seconds for two weeks while testing nothing.
  The queue now closes it as `skipped`, with the reason in `last_error`; a host
  row of plain `ok: true` over device rows that all skipped counts the same,
  and a fan-out family where no child ran is `skipped`. `skipped` is accepted
  by the `status` filter of `GET /api/jobs` and `GET /api/v1/jobs`, counted in
  the status facets, `GET /metrics` and the Overview (`skipped 24h`, beside
  done rather than in it), drawn as a grey chip on the dashboard, and given its
  own line in the morning digest. The v1 summary's verdict, `fleetr`'s exit 4
  and the MCP verdict were already `skipped` and are unchanged. A database
  opened by this release is migrated once: every `done` job with a `skipped:`
  result is re-labelled by the same rule. Result rows are not touched.
- **A job waiting on a skipped job skips too.** A skipped build produced no
  artifact, so the install behind it had nothing to install; it used to be
  promoted and run against whatever was already on the phone. It now skips
  with `last_error` `dependency <id> skipped`, the whole way down the chain,
  and a job enqueued behind an already-skipped one is skipped on arrival. A
  failed dependency still fails its waiters, and wins over a skipped one.
- **A `schedule-skipping` alert.** A schedule whose last three runs
  (`FLEET_ALERT_SKIP_STREAK`) all skipped raises one alert naming the reason it
  keeps giving, for example "nightly-tvloop-hardware has skipped 3 runs in a
  row: no Roku developer password on this host", and resolves on the first run
  that is not a skip. The tvloop nightly needed it for two weeks.
- **Simulator rows are forgotten after a week offline.** The lease sweep deletes
  a row whose descriptor says `kind` or `soc` is `simulator` once it has been
  offline for `FLEET_SIMULATOR_TTL_DAYS` (default 7), because simulators are
  recreated under new UUIDs and never come back; the live brain listed thirteen
  of them. Real devices and Android emulators are never forgotten, a row that
  holds a lock is left alone, and results and beacons are kept. `POST
  /jobs/sweep` reports what it forgot.
- **A changelog coverage check for releases.** On a `release/*` pull request,
  and on `develop` into `main`, `changelog coverage` in `ci.yml` lists every
  pull request merged into `develop` since the last tag and fails, naming
  each, if the section being released does not mention it as `#N` or a
  `/pull/N` link. 0.8.0's notes left out work that had shipped in it and had
  to be amended the day after; this is the check that would have caught it.
  Label a pull request `no-changelog` to exempt it; Dependabot's are exempt.
  The logic is `scripts/changelog-coverage.mjs`, with unit tests.
  ([#89](https://github.com/addisdev/fleet-runner/pull/89))
- **The documented workload count is checked.** The README and the docs said
  28 while the catalog grew to 34. Each hand-written count is now marked
  `<!-- count:workloads -->34`, and `repo scripts` in `ci.yml` fails on any
  pull request, docs-only ones included, when a marked number disagrees with
  the shipped entries in `collector/src/workloads/catalog.ts`. The collector's
  suite checks that reading against the real `CATALOG`. ([#89](https://github.com/addisdev/fleet-runner/pull/89))
- **Findings are in the control API.** `/api/v1` had 22 routes and none was
  findings, so a coding agent could run a job but not read the bug list night
  QA wrote for it. `GET /api/v1/findings` (filter by `app`, `state`,
  `verdict`, `check`, `since`, which takes `24h` as well as ISO 8601),
  `GET /api/v1/findings/{id}` (the steps in words, the evidence as links, the
  replay flow inline up to 16 KiB, the regression test, the verdict history)
  and `POST /api/v1/findings/{id}/verdict` (scope `run`, audited). The legacy
  `/api/findings` routes call the same functions and gained the same filters
  and fields. ([#96](https://github.com/addisdev/fleet-runner/pull/96))
- **`fleetr findings`, `fleetr finding`, `fleetr verdict`, and three MCP
  tools.** "What did last night find in GreenFolio, and give me the Maestro
  flow" is now one call: `fleetr findings --app greenfolio --since 24h`, then
  `fleetr finding ID --flow repro.yaml`; `fleet_findings`, `fleet_finding`
  (flow text inline) and `fleet_verdict` (not read-only, scope `run`) do the
  same over MCP. `fleetr findings --since 24h --json` is the input a scheduled
  agent session can start from; its shape is documented in docs/agents.md.
  The skill has a section on reading a finding: the replay count first,
  `agent_mistake` is not a bug, and never `fixed` without a fix merged. ([#96](https://github.com/addisdev/fleet-runner/pull/96))
- **A fixed finding becomes a regression test.** A new verdict, `fixed`, comes
  only after `real` (a 409 otherwise). Marking a finding real copies its replay
  flow into a new `regressions` table as a candidate; fixed makes it active;
  duplicate, not a bug or agent's mistake retire it. A nightly `ui-test` with
  `params.regressions: "<app>"` pulls the app's active flows from the
  collector at run time and runs each after its own flow, so a finding marked
  fixed today is in tonight's run without anyone editing a schedule. For a
  crash or ANR finding on Android the executor reads `logcat -b crash` and
  `am_anr` around the flow; a new crash of the package is `reproduced`, fails
  the row and reopens the finding (verdict cleared, seen once more, the build
  added, a `regressed on build ...` line in its new verdict history). Every
  other check can only be asserted as "replays without error", and the docs
  and each run's detail say so; a failing flow fails the row but reopens
  nothing. GitHub issues are only ever created, never read back, so closing
  one does not mark a finding fixed. The dashboard has a **Fixed** button
  (<kbd>f</kbd>) and a regression panel. A database opened by this release
  rebuilds the findings table once to allow `fixed` and backfills one history
  row per existing verdict. Not yet run on a real nightly: covered by the
  suite against fake crash readings and a fake Maestro. ([#96](https://github.com/addisdev/fleet-runner/pull/96))
- **The Findings page reads and judges through `/api/v1`.** Its list, detail
  and verdict calls go through the generated client, so its types are the API's
  and a dashboard verdict is the same call as `fleetr verdict`. `GET
  /api/findings`, `GET /api/findings/{id}` and `POST
  /api/findings/{id}/verdict` now carry `Deprecation` and a successor `Link`;
  `/api/findings/precision`, `/digest` and `/issues` have no v1 counterpart and
  do not. The v1 list carries `facets` (every app and check, and open/triaged
  counts) like the device and job lists, and the v1 verdict keeps the
  `FLEET_DASH_TOKEN` speed bump the older route had. Part of #83. ([#96](https://github.com/addisdev/fleet-runner/pull/96))

### Changed

- **Explore loads its model at 45% free memory, not 65%.** ultra's resident
  models alone hold it near 56% free, so the shelf's default bar meant no
  explore night could load Holo4 (~25 GB); 10-15's garden night skipped for
  it. The night manifests pass `WARM_MIN_FREE_PCT=45` to the warm-up; the
  shelf's default for everything else is unchanged, and it still refuses
  under memory pressure. ([#95](https://github.com/addisdev/fleet-runner/pull/95))
- **`ci-enqueue` speaks `/api/v1` and exits like `fleetr run`.** It polled the
  deprecated `GET /jobs/:id` and exited 0 on `done`, which includes a job that
  skipped and tested nothing, and it sent no token, so it failed against a
  collector with tokens on. It now enqueues with `POST /api/v1/jobs`, waits
  with `/wait`, and exits 0 passed, 1 failed, 2 invalid spec, 3 still running,
  4 skipped, 5 refused or unreachable. A workflow that read exit 1 as "timed
  out" now sees 3.
- **`ci-enqueue` and `ci-upload` send `FLEET_RUNNER_TOKEN` (or
  `FLEET_TOKEN`) as a bearer token.** `ci-upload` read only
  `FLEET_DASH_TOKEN`, even when the collector needed an `agent` token there.
  `FLEET_DASH_TOKEN` is still sent as `x-fleet-token`. `ci-upload` exits 5
  rather than 1 when the upload is refused or the collector is unreachable.
- **The example jobs are checked the way `/api/v1` checks a spec.**
  `check-examples.ts` used the loose `job.schema.json`, so an example could
  pass the check and be refused by the API it documents. It now runs the API's
  strict schema and each workload's params manifest, imported rather than
  copied. All 37 pass.
- **Explore's `CHECK_NAMES` lists only checks something raises.** `regression`,
  `agent_stuck` and `leash` were accepted by `POST /findings` and raised by
  nothing; they are refused now. A refused action is on the mission's steps,
  not a finding. Stored findings are not touched, and reading does not
  validate the name.
- **The desktop app is versioned with everything else.** `scripts/version.mjs`
  now writes `desktop/src-tauri/Cargo.toml` and `tauri.conf.json` (they said
  0.5.0), so the CI version check covers them. Both say 0.8.0.
- **The explore docs' three diagrams are drawn, not generated.** The night,
  one mission's sequence and the code map were mermaid blocks; they are now
  figures in `docs/figures/` rendered to PNG like the rest
  (`explore-night`, `explore-step`, `explore-code`). The docs workflow fails on
  a mermaid fence under `docs/`, and `mkdocs.yml` no longer configures one.
- **The workloads figure shows all 34 shipped workloads.** It had 28; `enrol`,
  `explore`, `upgrade-test`, `size-report`, `tvloop` and `llm-eval` are added.
- **`devices.png` is the new device drawings, and there is a `findings.png`.**
  Both are captured read-only from a running brain by the new
  `npm run shoot:live`, filtered to what was online and to the `bug-garden`
  fixture app; docs/brand.md says why a throwaway collector cannot make them.
- **Explore nights that need tonight's build skip, not fail, when there is
  none.** With `--fresh-build` (now on `fleet-explore-apple` and
  `fleet-explore-tv`), the night checks through the tunnel that the brain has
  a build of each app published tonight before it warms the model or boots a
  simulator. If not, the job is posted to the brain as `ok: true`, `skipped:
  no greenfolio-ios build for tonight (fleet-explore-builds did not run, ...)`,
  and the command exits 0: ultra's night queue has no skip exit code, and a
  missing upstream build is not this job's failure. `nightly-builds.sh` now
  uploads an unchanged build again (the brain ignores the duplicate bytes and
  stamps it published), so a quiet day on `develop` does not look like a
  missed build.
- **The model warm-up moved inside the night command.** The four night-queue
  manifests ran `shelf.sh warm pilot &&` before `explore-night.ts`, so a
  warm-up the shelf refused ended the job with `exit 1` before any check ran.
  `explore-night.ts --warm "<cmd>"` runs it after the build and time checks,
  retries a refusal for memory every minute for up to `--warm-wait` minutes
  (default 10), and then posts the night as `skipped: the model would not
  load, no room on this host: ...`. Any other warm-up failure is posted as a
  failure with its last line. The manifests in
  `collector/deploy/explore/night/` need copying to `~/night/recurring/` on
  ultra.
- **The explore docs' three diagrams are drawn, not generated.** The night,
  one mission's sequence and the code map were mermaid blocks; they are now
  figures in `docs/figures/` rendered to PNG like the rest
  (`explore-night`, `explore-step`, `explore-code`). The docs workflow fails on
  a mermaid fence under `docs/`, and `mkdocs.yml` no longer configures one.
  ([#90](https://github.com/addisdev/fleet-runner/pull/90))
- **The workloads figure shows all 34 shipped workloads.** It had 28; `enrol`,
  `explore`, `upgrade-test`, `size-report`, `tvloop` and `llm-eval` are added. ([#90](https://github.com/addisdev/fleet-runner/pull/90))
- **`devices.png` is the new device drawings, and there is a `findings.png`.**
  Both are captured read-only from a running brain by the new
  `npm run shoot:live`, filtered to what was online and to the `bug-garden`
  fixture app; docs/brand.md says why a throwaway collector cannot make them.
  ([#90](https://github.com/addisdev/fleet-runner/pull/90))
- **The dashboard reads devices, jobs, templates and schedules through
  `/api/v1`.** It called the deprecated `GET /api/devices`, `/api/jobs` and
  their detail routes, and enqueued with `POST /api/jobs`, with response types
  written by hand, so the server could change a field and the dashboard would
  show a blank column with nothing failing. It now uses the generated client
  for every read and change `/api/v1` offers, and its types are the client's.
  The `/api/v1` schemas state every field the dashboard reads, so
  `check-api-v1` fails when a handler stops sending one, and a new suite step
  fails if `dash/src` calls a route the deprecation headers mark. To carry the
  Devices and Jobs filter menus, `GET /api/v1/devices` and `/api/v1/jobs` now
  return `facets`, and `/api/v1/jobs` takes `has_error=true`. Two things a
  person can see: the composer's spec is checked strictly, so an unknown
  top-level field or params outside the workload's manifest is refused with
  the path named instead of failing later, and its jobs record `source: dash`.
  Enqueueing is no longer behind `FLEET_DASH_TOKEN`, as `POST /jobs` never
  was. Findings, the Overview, results, system, events, the live stream and the
  other changes stay on `/api/*` until `/api/v1` has them.
  ([#97](https://github.com/addisdev/fleet-runner/pull/97))

### Fixed

- **The OpenAPI document named the wrong status for two enqueue refusals.**
  `POST /api/v1/jobs` listed `no_matching_devices` and `no_build` under 422,
  but `queue.ts` refuses both with 400. The 400 and 422 entries now name the
  codes each really carries. ([#96](https://github.com/addisdev/fleet-runner/pull/96))
- **The older job routes skipped two auth checks.** With `FLEET_AUTH=tokens`,
  `POST /api/jobs/:id/cancel` and `/retry` let any `run` token stop or re-run
  anyone's job, and `POST /jobs` and `POST /api/jobs` accepted the `shell`
  workload from a token without `admin`. Only `/api/v1` asked. Both paths now
  call the same two functions (`collector/src/api/policy.ts`). With auth off
  nothing changes.
- **`fleet-cli`'s `bin` pointed at a file the build does not produce.** It
  named `dist/cli.mjs`; the build writes `dist/bin/fleet.mjs`, and `dist/` was
  left out of the package by `.gitignore`, so installing from a tarball gave no
  command. Both `fleet` and `fleetr` now point at the bundle, and `files`
  includes `dist/`.
- **A mistyped timer interval became a near-zero one.** `FLEET_SWEEP_MS`,
  `FLEET_SCHEDULER_TICK_MS` and `FLEET_ALERT_TICK_MS` went through a bare
  `Number()`, so `15s` was NaN and `15` (seconds, meant) a sweep every 15 ms.
  Anything but whole milliseconds of at least 1000 now falls back to the
  default, with a startup warning.
- **Explore's live-view frames were refused with `FLEET_AUTH_PROTOCOL=token`.**
  They sent only `FLEET_DASH_TOKEN`; they now also send `FLEET_TOKEN` as a
  bearer token.
- **A schedule template's empty `job_id` was replaced without a word.** A
  non-empty one was already refused; an empty or `null` one was stored and
  overwritten at every firing. It is dropped now and the reply carries a
  `warnings` entry, and a stored template that still has one is named in the
  log when it fires.
- Two comments said `fleet up` turns mDNS discovery on. It passes
  `collector.discovery`, which is off by default.
- **`fleet skill` failed on an installed 0.8.0.** The 0.8.0 archives carry
  `skills/`, but `install.sh` and `install.ps1` copy a release's directories
  by name and did not name it, so `fleet skill show` and `fleet skill install`
  could not find `SKILL.md`. Both installers now copy it, and a test fails if
  the bundle gains a directory the installers do not copy. The installers are
  fetched from `main`, so re-running the install command fixes an existing
  0.8.0 install; no new release is needed.
- **`bug-garden/tools/check-bench.mjs` passed `bench-delete-plant` without
  checking the plant was gone.** The card's `check` gained `absent_text`, which
  the harness enforces and the standalone checker ignored; it also matched
  case-sensitively where the harness does not. It now reads `absent_text` and
  matches case-insensitively, as the bug garden's README says.
- **`fleet-explore-apple` exited 1 in 0.0 minutes on 10-14.** Not a missing
  build: the shelf refused to load Holo4 at 64% free memory against its 65%
  threshold, after the night queue had admitted the job on its own measure.
  See the warm-up change above; with `--fresh-build` that night would also
  have skipped earlier, at "no greenfolio-ios build for tonight".
- **tvOS simulators registered as `os: ios`, so the TV explore night tested
  nothing.** The executor read simctl's runtime key for `iOS-` only, so an
  Apple TV simulator was described as plain `ios`, every `os ~ 'tvos'` job
  skipped with "no device matches this job on ultra", and each
  `fleet-explore-tv` night "passed" in about a minute. A tvOS simulator is
  now `tvos-26.5` (watchOS and visionOS likewise). No TV night has run with
  the fix yet.
- **A failing `ui-test` now says which step failed.** `nightly-fleet-ui-smoke`
  failed on the Galaxy S8+ every night from 10-10 with `failed: 1` and no
  error, while `Assertion is false: "Fleet Runner" is visible` sat in the JUnit
  report it had uploaded. The executor now reads the failing flow and its
  assertion out of the report into the device row's `error` and
  `test.failing_flow`; when Maestro produces no report, the error is its exit
  code and last stderr line, never its command line, which carries the test
  account's password.
- **No host result says `ok: false` with nothing beside it.** Every host
  workload's rows go through one wrapper in the executor: a device row with
  only counts says so ("1 of 1 tests failed; the runner reported no failing
  step"), and a final host row with no error of its own gets the failing
  devices' reasons. A subprocess failure nobody caught is reported as its exit
  code and last stderr line instead of Node's message. The collector also
  copies a failure's reason into the job's `last_error`, so the job list and
  the `job-failed` alert show it.
- **`GET /api/artifacts/<sha256>` answered "no such endpoint".** It is where
  `DELETE` and `/pin` already live, so it is the URL a person reaches for, and
  the 404 read as a missing artifact: the ui-smoke JUnit report was in the
  store all along. It now redirects (308) to
  `/api/v1/artifacts/<sha256>/content`, and says plainly when no artifact by
  that hash was ever uploaded.
- **The executor registered Rokus as `platform: android`.** Its Roku
  descriptor said `os: roku-15.3.4` but no platform, and the collector's
  fallback for anything that is not iOS is Android. It now sends
  `platform: "roku"`; `os ~ 'roku'` targeting and the tvloop workload are
  unaffected.
- **A Roku seen first by address and later by serial was listed twice.** A
  sweep where the box answered SSDP but not device-info left a
  `roku-ip-192-168-50-218` row offline beside `roku-X01600EMFRJ9`. A
  serial-named registration now retires the IP-named row at the same address.
- **`fleet service install` on Windows had never started anything.** The
  scheduled task's command kept the backslashes of a `\"` escaping meant for a
  `cmd` prompt -- execFile quotes the argument itself -- so the task ran
  `\"C:\...\node.exe\"` and failed with "file not found" every time. Found by
  the new Windows smoke on its first run. `fleet service uninstall` and `stop`
  also now kill `fleet up`'s process tree before ending the task: deleting a
  task does not stop it, and Windows does not take a parent's children down
  with it. ([#89](https://github.com/addisdev/fleet-runner/pull/89))
- **The desktop app left `fleet up` running when it was killed, and its Quit
  item could not quit.** SIGTERM (a `kill`, a `killall`, the end of a session)
  killed the app outright and orphaned its sidecar on the collector's port. And
  `RunEvent::ExitRequested` refused every exit, including the `app.exit(0)` the
  Quit item calls, so Quit stopped the fleet and left the app running. SIGTERM,
  SIGINT and SIGHUP now take the Quit path -- stop `fleet up`, then exit -- and
  only the implicit last-window exit is refused. Found by the first launch of
  the app, in CI. ([#89](https://github.com/addisdev/fleet-runner/pull/89))
- **`fleet skill` failed on an installed 0.8.0.** The 0.8.0 archives carry
  `skills/`, but `install.sh` and `install.ps1` copy a release's directories
  by name and did not name it, so `fleet skill show` and `fleet skill install`
  could not find `SKILL.md`. Both installers now copy it, and a test fails if
  the bundle gains a directory the installers do not copy. The installers are
  fetched from `main`, so re-running the install command fixes an existing
  0.8.0 install; no new release is needed.
  ([#86](https://github.com/addisdev/fleet-runner/pull/86))
- **`bug-garden/tools/check-bench.mjs` passed `bench-delete-plant` without
  checking the plant was gone.** The card's `check` gained `absent_text`, which
  the harness enforces and the standalone checker ignored; it also matched
  case-sensitively where the harness does not. It now reads `absent_text` and
  matches case-insensitively, as the bug garden's README says.
  ([#88](https://github.com/addisdev/fleet-runner/pull/88))
- **`/api/v1` cancel and retry were always refused with `FLEET_DASH_TOKEN`
  set.** They hand the request to the guarded `/api/jobs/:id/cancel` and
  `/retry`, and dropped `X-Fleet-Token` on the way, so with the guard on every
  one answered 401 whatever the caller sent. The header is now carried, and
  the refusal says `unauthorized` rather than `internal`.
  ([#97](https://github.com/addisdev/fleet-runner/pull/97))

### Now verified

Four items from earlier "Not verified" lists, each now checked by
GitHub-hosted CI on every pull request that touches them. ([#89](https://github.com/addisdev/fleet-runner/pull/89))
- **`fleet service install` on launchd.** `fleet / launchd smoke` installs the
  LaunchAgent on `macos-latest` (the runner has a `gui/<uid>` domain), waits
  for its collector to answer and its agent to register, checks
  `fleet service status`, reinstalls once so the bootstrap race is hit and
  retried (it was), then uninstalls and checks nothing answers, the plist is
  gone and launchd no longer has the job.
- **The Windows scheduled task.** `fleet / windows task smoke` runs the same
  lifecycle on `windows-latest`. It found the bug above; with it fixed, a
  Windows machine agent registered against a real collector for the first
  time.
- **The arm64 container image.** `fleet / container smoke (arm64)` builds
  `fleet/Dockerfile` natively on `ubuntu-24.04-arm`, checks the container
  reports `aarch64`, and waits for its agent to register and answer
  `fleet devices`, `fleet workloads` and `fleet whoami`.
- **The desktop app launches.** `desktop / launch smoke` builds it on Ubuntu
  and runs it under Xvfb: its `fleet` sidecar starts a collector whose agent
  registers, the app is still up 20 seconds later, and SIGTERM stops both.
  Then, under `tauri-driver`, the settings window is driven over WebDriver:
  it is titled `Fleet`, `get_status` answers over IPC with the sidecar
  running, and a screenshot is uploaded. This was the first time the app ever
  ran. It has still never run on a Mac, and the tray menu has never been
  clicked.

Still not verified: any of the three services coming back after a reboot, a
graceful stop on Windows, and the MCP gateway against a real identity provider
(it needs a tenant).

## [0.8.0] — 2026-10-15

The fleet as something a program or an AI agent can drive: a versioned control
API, a CLI and MCP tools that are thin wrappers over it, an optional OAuth
gateway for chat tools, and a skill that tells an agent how to use them. See
[AI agents and automation](docs/agents.md).

### Added

- **A versioned control API, `/api/v1`.** Devices, workloads, jobs, results,
  artifacts, schedules, alerts and an audit log, with one list envelope, one
  error shape (`{error:{code,message,hint}}`) and OpenAPI 3.1 at
  `/api/v1/openapi.json`. New: `POST /api/v1/jobs/validate` (a dry run that
  names each problem and the devices a job would land on),
  `GET /api/v1/jobs/{id}/summary` (one verdict across every device of a
  fan-out) and `GET /api/v1/jobs/{id}/wait` (long-poll until it finishes). One
  route table registers the routes, writes the OpenAPI document and generates
  a typed client; the suite fails if they disagree.
- **Work commands in `fleet`:** `devices`, `workloads`, `run`, `job`, `wait`,
  `cancel`, `retry`, `results`, `flaky`, `artifact`, `login`, `whoami`, with
  `--json` and the verdict as the exit code (0 passed, 1 failed, 2 usage or
  invalid spec, 3 still running, 4 skipped, 5 refused or unreachable). `fleetr`
  is installed alongside `fleet` as the same program.
- **Opt-in authentication.** `FLEET_AUTH=tokens` requires scoped bearer tokens
  (`read`, `run`, `admin`, `agent`, `delegate`) on the control API, managed with
  `fleet token create|list|revoke`. Jobs record who asked and through which
  front door; every change is audited. Off by default: a LAN or tailnet
  collector behaves as before.
- **A remote MCP gateway**, `fleet mcp --http`: Streamable HTTP, an OAuth 2.1
  resource server for Entra ID, Okta or any OIDC provider (RFC 9728 metadata),
  per-person rate limits, and jobs recorded as the person rather than the
  gateway. The `shell` workload is never available through it.
- **More MCP tools and resources:** `fleet_workloads`, `fleet_validate`,
  `fleet_cancel`, `fleet_retry`, `fleet_flaky`, `fleet_whoami`; tool
  annotations, output schemas, and jobs, devices, workloads and artifacts as
  resources.
- **An agent skill**, `skills/fleet-runner/SKILL.md`, installed with
  `fleet skill install`. Its tool and exit-code tables are generated from the
  code and checked by the tests.
- `GET /metrics` in Prometheus text format.

### Changed

- **Job specs are validated strictly.** An unknown top-level field is now
  refused (`invalid_spec`) instead of ignored, so a typo is an error rather than
  a setting that silently did nothing.
- The older read and enqueue routes (`/api/devices`, `/api/jobs`, `POST /jobs`
  and others) answer with `Deprecation` and `Link: rel="successor-version"`
  headers pointing at `/api/v1`. They keep working; there is no sunset date.
  The runner protocol is not deprecated.
- `FLEET_RUNNER_URL` and `FLEET_RUNNER_TOKEN` take precedence over `FLEET_URL`
  and `FLEET_TOKEN` for the CLI and MCP server, so a shell configured for
  another tool that reads those names cannot misdirect it.

### Fixed

- **A device that hung up mid-poll could swallow the next job.** The
  collector kept claiming on behalf of a long-poll whose client had gone,
  handing the job to nobody; it sat claimed until the lease ran out. The poll
  now stops when the connection closes.
- **The container image could not start on a fresh volume.** `VOLUME` named a
  directory the image never created, so Docker made it root-owned and the
  non-root `fleet` user died on `mkdir`. The image now creates it first.
- **The desktop app's build script failed before compiling anything.** The
  bundled resource directory was named `fleet`, the same name the sidecar is
  copied to in `target/debug`, so the copy failed with "Not a directory". The
  resource is now `fleet-tree`, and the sidecar shim also looks beside itself,
  where a dev build puts it.

### Now verified

Four items from earlier "Not verified" lists, each now checked by CI on every
pull request that touches them:

- **The container image runs.** `fleet / container smoke` builds
  `fleet/Dockerfile`, starts it, and waits for its own agent to register and
  answer `fleet devices`, `fleet workloads` and `fleet whoami`. It found the
  volume bug above on its first run. linux/amd64 only; the arm64 image is still
  built and not run.
- **`fleet service install` on systemd.** `fleet / systemd smoke` installs the
  user unit on a real systemd, checks it with `systemd-analyze verify`, waits
  for the collector it starts to answer, then uninstalls and checks nothing is
  left answering. launchd and the Windows scheduled task are still unrun.
- **The desktop app's Rust compiles.** `desktop / cargo check` stages the
  sidecar and runs `cargo check --all-targets` on macOS. It found the resource
  bug above; once that was fixed the Rust compiled with no errors. Compiling is
  all it proves: the app has still never been launched.
- **The Roku channel compiles.** `runner-roku / brighterscript` runs `bsc`
  over the channel. It has still never run on a Roku.

### Not verified

- **The MCP gateway has not met a real identity provider.** Its tests use a
  local fake that signs tokens the way Entra ID and Okta do; no tenant has an app
  registration for it yet, and it is not on any company's approved-connector
  list. [Authentication and the MCP gateway](docs/deploy/auth.md) has the setup.
- **The dashboard does not use the generated client yet.** It still calls the
  unversioned routes with hand-written types
  ([#83](https://github.com/addisdev/fleet-runner/issues/83)).

### Also in this release

These merged into `develop` before 0.8.0 was cut and shipped in it, but were
left out of the notes above on release day.

- **Exploratory QA, the `explore` workload.** A vision model works through
  mission cards on tonight's build, driving a device the way a person would,
  while the harness checks every step for crashes, ANRs, frozen and blank
  screens, dead controls, accessibility and visual defects. Each candidate is
  replayed twice on a clean install and only what reproduces is filed; a crash
  stands on its log. See [Exploratory QA](docs/explore/index.md).
  ([#70](https://github.com/addisdev/fleet-runner/pull/70))
- **Findings, verdicts and a morning digest.** `POST /findings` merges repeats
  by fingerprint; the dashboard's Findings page has Real, Duplicate, Not a bug
  and Agent's mistake. A check under 30% precision after ten verdicts is
  switched off for that app (crashes and ANRs never are). GitHub issues stay a
  dry run unless `FLEET_GITHUB_ISSUES=1` and a token are set, and the collector
  only ever creates them. ([#70](https://github.com/addisdev/fleet-runner/pull/70))
- **What it drives:** Android phones, tablets, Android TV and Fire TV over adb;
  iOS and tvOS through FleetDriver, a new XCUITest command server in
  `runner-ios`; a Roku through tvloop. The leash refuses delete, purchase,
  invite and sign-out controls unless a card allows them and never types into
  a password field. ([#70](https://github.com/addisdev/fleet-runner/pull/70))
- **The bug garden**, an Android fixture app with twenty planted defects, a
  scoring rule and scorer, and twenty bench cards for scoring a model without
  a judge. Its screenshot walks capture each screen in the base, dark, Spanish
  and large-text settings. ([#70](https://github.com/addisdev/fleet-runner/pull/70),
  [#74](https://github.com/addisdev/fleet-runner/pull/74))
- **Nights on ultra.** `scripts/explore-night.ts` is the night-queue command:
  it boots the devices, opens its own tunnel to the brain, runs one job and
  exits with its result. `nightly-builds.sh` builds GreenFolio iOS and
  Dozehound tvOS from `origin/develop`; the tvOS and iOS nights run after the
  products' own night jobs. Holo4 35B-A3B measured 100 of 100 on pointing and
  a median step of 6.8 s. Fire TV is parked and the TV question is answered on
  tvOS. ([#73](https://github.com/addisdev/fleet-runner/pull/73),
  [#77](https://github.com/addisdev/fleet-runner/pull/77),
  [#78](https://github.com/addisdev/fleet-runner/pull/78))
- **The dashboard draws each device as the object it is**: 22 drawings
  (phones, tablets, TV boxes and sticks, computers, watches, a headset, a
  board, a browser) instead of seven silhouettes, chosen from the model string
  first because older agents report a Roku as `android` and an Apple TV or a
  watch as `ios`. ([#69](https://github.com/addisdev/fleet-runner/pull/69))
- **The Android runner starts on Android 7.0 and 7.1.** `RunnerService` called
  `startForegroundService`, which exists from API 26, so API 24 and 25 threw
  `NoSuchMethodError`; it uses `startService` there now.
  ([#75](https://github.com/addisdev/fleet-runner/pull/75))
- **The Android runner is linted in CI.** The `android.hardware.type.watch`
  feature line that failed `lintDebug` is gone; the runner still detects a
  watch at run time. ([#76](https://github.com/addisdev/fleet-runner/pull/76))

Not verified, from those pull requests: a physical iPhone or Apple TV through
FleetDriver; a real Roku (its developer password is not on the host yet); any
model-driven night on an Apple surface (the iOS and tvOS simulators were driven
without a model); the GreenFolio Android cards; the Android 7 fix on a real
API 24 or 25 device (Robolectric only); and any Wear device, before or after
the lint change.

## [0.7.2] — 2026-09-30

### Fixed

- **A Hue bridge registered as a Roku.** Roku discovery sends an M-SEARCH for
  `roku:ecp` and trusted every reply, and a Philips Hue bridge answers every
  M-SEARCH whatever it asks for. The first night Roku presence was on, it
  joined the shelf as `roku-ip-192-168-50-100` -- and a `tvloop` job matching
  `os ~ 'roku'` would have pointed tvloop at a light bridge and gone red on
  its doctor. Only replies naming `roku:ecp` in their ST or USN count now.

## [0.7.1] — 2026-09-30

### Fixed

- **Every directory workload was "not supported" in a release.** `install`,
  `enrol`, `size-report`, `upgrade-test` and the new `tvloop` live in their
  own directories under `src/workloads/`, found at startup by walking that
  directory. A release is one bundled file with no directory to walk, so the
  walk found nothing -- and dispatch only asked what the walk had found, so it
  never reached the bundled copies that `static.ts` exists to provide. Every
  release since the workloads moved out of `executor.ts` has answered those
  five with "not supported by this executor yet", and said so at startup as
  "no workload directories found". Found by the first `tvloop` run on
  fleet-host. `check-workloads` now dispatches each one with nothing on disk,
  the way a release does.

## [0.7.0] — 2026-09-30

The fleet stops being something to look at and becomes something to use: a
coding agent can ask it for a run on real hardware, a PR's build can be sent
to a phone, and a tool with a hardware nightly nobody could run can borrow a
device. Three bugs that made its answers untrustworthy are fixed on the way.

### Added

- **`fleet mcp`.** The lab as MCP tools over stdio -- `fleet_devices`,
  `fleet_run`, `fleet_job`, `fleet_artifact` (screenshots come back as
  images) and `fleet_results` -- so a coding session can run a job on real
  devices and read the verdict without opening the dashboard. Register it with
  `claude mcp add --scope user fleet -- ~/.fleet/bin/fleet mcp`.
- **Shared-host pressure limits.** `FLEET_MAX_LOAD` and
  `FLEET_MIN_FREE_SWAP_MB` let an executor on somebody's workstation refuse
  heavy work while that machine is under pressure, as a `skipped:` result with
  the numbers in it. Unset by default.
- **The `tvloop` workload.** Runs tvloop's hardware suite -- doctor, sideload
  the checkout's channel, the contract tests, a JUnit replay of its flows --
  on a Roku the fleet has locked, with the developer password from the
  Keychain and scrubbed from every uploaded log.
- **Rokus register.** One host, told `FLEET_ROKU=1`, reports the Rokus on its
  network as its own devices, with model, `roku-<firmware>`, address and
  developer mode.
- **A faster front door for evaluators and contributors.** The README now
  summarizes the system, evidence and engineering scope before the deep dive;
  a structured feature-request form asks for the decision and trust boundary
  behind proposed work.

### Fixed

- **A job for a device on one host could be claimed by another**, which then
  found nothing to run it on. A host job with no `targets.executor` now goes to
  an executor that holds a matching device, when one does.
- **"Nothing ran" posted a commit status.** A skipped result -- no device, a
  host under pressure -- now posts no `fleet-runner` status, rather than a
  success for a run that did not happen. No targets is a skip, not a failure.
- **`ui-test` ignored the build its job named** and ran against whatever was
  installed. It now installs the job's `app` on each device first.
- **Simulators registered as iPhones** when simctl's listing timed out; a
  devicectl entry on `sameMachine` is now a simulator.
- **Alerts for the personal pool.** A daily laptop's battery is not a fleet
  incident.
- **A Roku would have registered as an iPhone** -- it fell through the iOS
  descriptor's fallback.

## [0.6.2] — 2026-09-22

The web nightlies move off the machine that was running forty CI runners and
overheating, and onto the fleet's brain -- which turned out to need two things
the web path had never needed.

### Fixed

- **The web workloads had never run from a release.** `npx playwright test`
  ran with no working directory, so it found `playwright.config.ts` and
  `@playwright/test` by inheriting the executor's; `import("playwright")`
  resolved against the executor's own module. Both hold in a checkout. Under a
  release the executor is `~/.fleet/bin/fleet.mjs`, started by launchd from
  `/`, with no Playwright anywhere near it. `FLEET_PLAYWRIGHT_DIR` names the
  directory that owns a host's Playwright -- package, config and specs -- and
  every web path uses it. Unset, it is the working directory, so a checkout is
  unchanged.

### Added

- **`FLEET_CHROMIUM_CHANNEL`**, to drive an installed browser instead of one
  Playwright downloaded. Playwright 1.62 **refuses to install Chromium or
  Firefox on macOS 12** -- `does not support chromium on mac12` -- and the
  fleet's brain is a Mac on 12, so there the Google Chrome already on the
  machine is the only Chromium there is. `FLEET_CHROMIUM_CHANNEL=chrome` drives
  it, for the config's `chromium` and `mobile-chrome` projects and for the
  browsers the executor launches itself. Only the Chromium engine has a
  channel, so such a host runs two of the five projects; Firefox, WebKit and
  mobile Safari need a Mac on a newer macOS.


## [0.6.1] — 2026-09-19

What running the thing found. v0.6.0 was written from a survey; this is from
two days of the fleet actually being up.

### Fixed

- **Every optional setting was unreachable from the CLI.** `setPath` refuses a
  key that is not already in the object, which is right for a fixed schema —
  there a new key is a typo. An optional setting is absent because nobody has
  set it yet, and the check could not tell those apart, so `name`,
  `agent.deviceId`, `agent.ttlS`, `executor.collector` and **`executor.name`**
  all answered `no such setting`. The last is in the README's own command table
  and is what an executor needs to inherit the job routing of the one it
  replaces. Found at the first command of a real migration.
- **`launchctl bootstrap` loses a race with the `bootout` before it.**
  Reinstalling the service is bootout-then-bootstrap, and the second half fails
  with `Bootstrap failed: 5: Input/output error` — launchd is still tearing the
  label down, and the same command a few seconds later works. The plist is
  written before the bootstrap runs, so a refusal leaves the machine carrying a
  new unit with nothing running it; on the machine this was found on that was
  the fleet's brain. It took the brain down twice before it was understood.
  Retried now, for EIO-shaped refusals only, on `install` and on `start`.
- **`fleet service status` said `running` while the fleet had no brain.**
  launchd can only speak about the launchd job, and the job is `fleet up` — a
  supervisor that has permanently given up on the collector is still running
  perfectly well. So status reported healthy while every device long-polled
  something that had gone, which is the worst answer available. The supervisor
  now publishes what it is doing and `status` reads it, naming any component
  that gave up and exiting non-zero. The file carries the supervisor's pid, so
  one left behind by a supervisor that is gone is ignored rather than believed.
- **The self-check did not know `fleet service` exists.** `agent_loaded` looked
  for `com.addisdev.fleet-runner-machine`, the label `install-agent.sh` writes,
  and not for `com.addisdev.fleet`, the one unit `fleet service install` writes.
  Every machine adopted onto `fleet up` therefore failed the row nightly while
  being supervised perfectly well — a check firing because the thing it checks
  for got better. Both names count now; naming one explicitly still means that
  one and no other.
- **A Mac with only the Command Line Tools is not a broken Mac.**
  `/usr/bin/xcodebuild` is a shim the CLT installs: it resolves, it runs, and it
  refuses, which the tool check read as a broken install. `fleet doctor` calls
  the same fact informational and is right. The brain of this fleet is a CLT
  machine by design and was failing its nightly self-check for that reason
  alone. A genuinely broken Xcode still fails.
- `fleet service stop` printed `stoped`.

### Added

- **`collector/deploy/backup-brain.sh`** and **`pull-brain-backups.sh`**, with
  a LaunchAgent for each. Nothing was backed up, and the Maestro flows and
  Playwright specs this fleet runs are not in git — they name the apps under
  test — so **the only copies in existence were on one 2016 laptop**. Losing
  that disk would have left every nightly still running and testing nothing.
  The database is copied with sqlite3's own `.backup` rather than `cp`, because
  a plain copy of a live WAL-mode database restores into a page it cannot read,
  and the copy is opened and checked before it is kept. Artifacts are excluded:
  content-addressed, and everything worth keeping is referenced by a result row
  the backup already carries.
- **[`docs/lab.md`](https://addisdev.github.io/fleet-runner/deploy/lab/)**, a
  worked example of a real deployment: which machine runs what, why the brain
  is the oldest machine in the house, what each schedule guards, how to restart
  one, how to restore, and the traps this deployment hit.

### Changed

- **`fleet service install` has now been run**, which corrects the line v0.6.0
  left deliberately negative. It runs the brain of this project's own fleet:
  one launchd unit, three components, on an Intel Mac under macOS 12, adopting
  a collector database that predates it. Not on systemd and not on Windows.
- `install.sh` has now installed on **Intel macOS 12** as well as arm64, and
  performed the **first in-place upgrade** it has ever done.
- The macOS row of [platforms](https://addisdev.github.io/fleet-runner/platforms/)
  records both architectures registering, passing conformance, and reporting
  comparable synthetic numbers with matching digests.


## [0.6.0] — 2026-09-18

The instruments, before the hardware. Everything here came out of pointing the
project at its own fleet and writing down what was wrong with it, which is the
first thing the lab plan asks for.

### Fixed

- **An offline alert for every device that ever registered.** The live brain
  held **79 open `device-offline` alerts against 6 real devices**, some with
  `seen_count` past 33,000, and an alert channel nobody reads is the failure
  alerting exists to avoid. Two causes, both fixed. The rule now fires only for
  devices somebody **named** — a name is the operator saying "this one is
  mine", and nothing else in the schema separates a shelf device from one that
  registered from a desk for a single benchmark. And it now skips **expired**
  ephemeral agents: an agent that declared a `ttl_s` and outlived it did
  exactly what it promised, the queue and the shelf already drop it, and the
  alert engine was the third place that had to agree and did not — so a closed
  browser tab raised an alert about a row the dashboard will not even show.
- **A simulator that is deleted now leaves the shelf.** The host executor is
  the only thing that ever registers a simulator, so a deleted one had nothing
  left to refresh its row and sat there offline forever; thirty accumulated in
  a month. Virtual targets register with a fifteen-minute `ttl_s`. Real
  hardware sends none, on purpose — an unplugged phone is a fact somebody
  should see, not a row that tidies itself away.
- **A teardown that raced the kernel on Windows.** `fleet`'s `up` test failed
  in cleanup with `EBUSY … unlink '…\data\fleet.db'` after all its assertions
  had passed. A `SIGKILL`'d process keeps its file handle for a moment, the
  teardown did not wait after the kill, and `rmSync`'s `force` suppresses
  ENOENT rather than EBUSY. Both fixed, and the same treatment applied to the
  multi-brain test, which tears down two databases and had simply not lost the
  race yet.

### Added

- **`env` in `~/.fleet/config.json`**, an open map of `FLEET_*` variables
  handed to every component. The config names six of the twenty-odd variables
  the three programs read; the rest are per-deployment facts with no home —
  where this host's Maestro flows live, where its Playwright specs live, which
  Xcode project the generic iOS bundle builds from, where alerts go.

  It exists because of what adopting the release does without it. The old
  deployment set those in a hand-written plist per component. `fleet service
  install` writes **one** unit and gives it only a `PATH`, so migrating to it
  dropped every one of them — and a `ui-test` whose flows directory has
  silently defaulted elsewhere fails with "no such flow", which names neither
  the cause nor the file that caused it.

  The stated precedence is unchanged: a variable already in the environment
  still wins, and an entry here still beats a computed default. That second
  half is the point of it — `env.FLEET_DATA_DIR` is how a fresh install
  **adopts a collector's existing database** instead of starting an empty one
  beside it.
- **`attached_host` on a host-driven device**, beside `attached_to`.
  `attached_to` is the executor's *name*, which is a routing handle and not a
  machine: two Macs configured with the same `FLEET_EXECUTOR_NAME` both claim
  the jobs pinned to it, and the registry could not say which of them a phone
  was cabled to. That is not hypothetical — a staging copy of the iOS
  executor's LaunchAgent was found loaded on a second Mac, racing the real one
  for twelve days.
- **The smoke suite refuses a fleet somebody is using.** It writes about sixty
  rows named `smoke-*` and removes none of them; pointed at the live brain four
  times over three weeks, it left 44 fixture devices, 18 dead executor rows and
  8 fixture artifacts, whose offline alerts drowned the real shelf. The test is
  emptiness rather than naming, because a suite collector starts on a fresh
  `mkdtemp` and so has no devices, jobs or results. `FLEET_SMOKE_I_MEAN_IT=1`
  overrides it.

  `FLEET_DASH_TOKEN` is **not** that protection, despite looking like it. It
  guards three routes — alert tick, baseline accept, mirror upload — and the
  smoke suite touches none of them.
- The conformance suite **names the brain** it is about to enqueue jobs on,
  rather than only its URL. It is meant to run against a live fleet, so it
  cannot refuse one, and `127.0.0.1:18788` reads like a scratch collector while
  being a tunnel to the real one.
- A machine whose platform probe found nothing **keeps the memory Node already
  knew**. `describe()` fills `ram_mb` from `os.totalmem()` and then merged the
  platform fields over it with a plain spread, so a probe's `null` won — the
  second, quieter reason a Windows agent could not be selected by memory.

### Documented

- `fleet service install` writes the service's `PATH` from **the environment of
  the shell that ran it**. Not guessable, and the difference between an
  executor that drives Android and one that reports no targets: on the fleet
  this was found on, `adb` lives under `~/.local/` and is on no default PATH.

### Still not true

- `install.sh` has now installed on **Intel macOS 12** as well as arm64, from
  the real v0.5.0 release, checksum verified, and the installed binary runs.
  `install.ps1` has still never been parsed by PowerShell, and no container has
  been started from the published image.
- **`fleet service install` has still never been run**, on any platform. This
  release is what makes running it on the live brain possible, and that happens
  immediately after it — so expect a follow-up that corrects this line rather
  than a release that quietly claims it.
- One cosmetic thing worth knowing before reading a version string: on Node
  22.x, `node:sqlite` still prints an `ExperimentalWarning` to stderr, so
  `fleet version` output carries it. Harmless to a person, not harmless to
  anything parsing it.

## [0.5.0] — 2026-09-07

One command instead of a checkout: `fleet up`. And a device can belong to more
than one fleet.

### Added

- **`fleet`, the front door.** `fleet up --role brain,agent` runs this machine's
  components under one supervisor; `fleet join --discover` finds a brain on the
  network and joins it; `fleet doctor` says what this machine can and cannot run
  **and why not**; `fleet service install` keeps it up. It wraps the collector,
  the machine agent and the host executor and reimplements none of them -- each
  still reads its own `FLEET_*` variables and still runs started by hand.
- **A supervisor that gives up loudly.** `KeepAlive` and `Restart=always`
  restart a component that crashes on startup every ten seconds forever, writing
  a stack trace into a log nobody rotates -- which from outside is
  indistinguishable from a fleet that works. This one backs off, rotates, and
  after five failures in quick succession stops and says which log to read. A
  child that ran for a while first resets the counter.
- **One bundle with no dependencies.** `node fleet/build.mjs` produces a 0.9 MB
  `fleet.mjs` carrying the collector, the agent and the executor, beside the
  browser runner and the dashboard in the same relative layout a checkout has --
  so `../runner-web/index.html` resolves without any source knowing it is
  bundled. Only Playwright stays outside: 400 MB of browser needed by four of
  thirty workloads, now a dynamic import, so an executor without it starts fine
  and says so.
- **`install.sh` and `install.ps1`.** No sudo, no administrator rights, no
  bundled runtime (Node 22.13 or newer on `PATH` is required, and the release
  workflow builds no runtime, so the installers deliberately do not look for
  one). Both verify the download against the release's `SHASUMS256.txt` and
  refuse to install if it does not match, or if the checksums cannot be fetched.
- **A release workflow.** Six archives, one `SHASUMS256.txt`, a multi-arch
  container image and a GitHub Release, behind a version gate that runs first
  and alone. A pre-release tag is marked as one, because the
  `/releases/latest` API both installers read excludes pre-releases -- which is
  what keeps `curl | sh` off a release candidate.
- **`fleet/Dockerfile`**: the whole program containerised, not only the agent.
  `ghcr.io/addisdev/fleet` is now a fleet rather than a device that joins one,
  which makes `--role brain` possible in Docker at all. The agent-only image
  stays as `runner-machine/Dockerfile`.
- **A collector can advertise itself over mDNS**, off by default -- a collector
  should not start announcing itself on somebody's office network because they
  upgraded. It is link-local by construction, so a collector bound to a tailnet
  address is not advertised across it and the deployment posture is unchanged.
- **A device can belong to more than one fleet.** Collectors do not share a
  database, forward jobs, replicate results or elect anything; a job enqueued on
  brain A is A's job. All of multi-homing is on the device side and it is one
  rule: **a device runs one job at a time, whoever asked**, enforced by three
  mechanisms none of which is sufficient alone -- a claim gate on the agent,
  `busy` on the beacon so other queues stop offering, and
  `POST /jobs/:id/release` for the race the first two cannot close. `release`
  **refunds the attempt**, because being handed a job you could not take is not
  evidence the job is flaky; it is refused once any result row exists, and
  refused if the caller is not the claimant, which on an unauthenticated API
  would otherwise be a denial of service with one `curl`.
- **`GET /api/peers`**, and `/api/peers/:id/*` proxying one peer's read API
  server to server. A proxy rather than CORS because there is no
  authentication, so opening the read API cross-origin would let any website in
  the operator's browser read their whole fleet from any tab. Peers are
  addressed by stable id rather than URL, only an allow-list of endpoints is
  proxied, and nothing that mutates is proxied at all.
- **Conformance clause 9**, which is skipped for almost every agent and should
  be: a runner registered with one collector has nothing to get wrong. It checks
  the half observable from one brain -- an agent that says it is busy elsewhere
  and then claims work anyway.
- **A brain switcher in the dashboard header**, rendered only when peers are
  configured. Each peer links to *its own* dashboard rather than pulling its data
  in, because mutations are not proxied and a screen mixing two fleets would have
  a compose button whose target was ambiguous. An unreachable peer stays visible
  and struck through.
- **`runner-roku/`**: the fifth hand-written implementation of the protocol, in
  BrightScript, because that is the only language a Roku will run. A SceneGraph
  channel that registers, long-polls, runs, beacons and reports, enrolled by ECP
  launch parameters rather than by an on-screen keyboard. It declares
  `benchmark:roevp` and refuses `synthetic` with a sentence, for the reason the
  browser runner declares `jssha`. `ram_mb`, `soc` and `arch` are null, each with
  a reason; the memory pressure signal rides on the beacon as `mem_pressure`
  instead of being turned into an invented number.
- **`collector/src/drivers/roku.ts`**: the first driver that reaches devices over
  the network rather than a cable -- SSDP `M-SEARCH` for `roku:ecp`, then
  `GET /query/device-info`. It deliberately does not install: that needs RFC 7616
  digest auth Node's `fetch` does not have, and `runner-roku/build.sh` does it
  with `curl --digest`, reading the password from the Keychain over a stdin pipe
  so it never reaches argv.
- **`desktop/`**: a Tauri 2 menu-bar app around the `fleet` binary -- a tray
  menu, three role switches, the dashboard in a window, and a notification when
  a component gives up. It wraps the CLI and does not reimplement it: no second
  supervisor, no backoff curve of its own, and it reads and writes the same
  `~/.fleet/config.json` with the same field names `fleet config set` writes.
- **`VERSION` at the repository root**, `scripts/version.mjs` to write it into
  all seven places, and a CI job that is deliberately not path-filtered and
  fails when they disagree. The components had drifted to four different
  answers, including an accidental `1.0` on iOS that was simply what
  `GENERATE_INFOPLIST_FILE` supplies when no target sets `MARKETING_VERSION`.
  That number is not decoration: every agent sends it as `app_ver` on every
  registration, so it is the field you read when one device behaves unlike the
  one beside it.
- **`docs/install/`** and **`docs/deploy/headless.md`**: the one-command story
  per platform, how each device platform joins, and the per-component launchd
  and systemd deployment that is actually running today.

### Changed

- **The database is Node's own `node:sqlite`**, and there is no native code
  anywhere in the tree. `better-sqlite3` was the only native addon, and it is
  what made the collector a per-OS, per-architecture, per-Node-ABI install
  rather than a copy of a directory -- and the reason it had never once run on
  Windows. The engine floor moves to **Node 22.13**, where that module lost its
  flag. It is also what makes `docker build --platform linux/arm64` from an x86
  laptop produce a working Pi image.
- **The three programs are three functions.** `listen()`/`close()` in the
  collector, `startAgent(opts)` and `startExecutor()` returning handles that stop
  at a loop boundary rather than mid-job. Each previously called `main()` at the
  bottom of the file with configuration read from `process.env` while the module
  loaded, which is right for `npm start` and the whole reason none of them could
  be embedded. `config.ts`'s exports are live bindings now with a `configure()`
  that reassigns them, and `configure()` refuses once the collector has started,
  because half these values are read once and half on every request.
- **The machine agent declares and dispatches from one table.** It had a string
  list in `capabilities.ts` and an `if` chain in `agent.ts` -- the exact drift
  `docs/writing-a-runner.md` warns every other runner author about, using this
  agent as the worked example. The Kotlin and Swift agents did it properly; the
  one the documentation points at did not.
- **A brain has a name and an id that survive a restart**, in `collector.json`,
  written through a temporary file and a rename. `SERVER_INSTANCE` answers "did
  it restart", which is right for the SSE handshake and useless for "which
  collector is this" -- a question that has to be answerable now that a device
  can register with more than one.
- **Playwright is asked for rather than assumed.** `browserAvailable()` launches
  a browser rather than resolving a package, because `npm install playwright`
  leaves you with the library and no Chromium, which resolves perfectly and
  cannot open a page.
- The workloads are named in `static.ts` as well as found by walking the
  directory, because a bundle has no directory to walk and `import(someVariable)`
  is not something a bundler can follow. `npm test` compares the two lists in
  both directions.
- **`collector/deploy/install-agent.sh` and
  `runner-machine/deploy/install-agent.sh` are deprecated** in favour of
  `fleet service install`, which writes one unit running `fleet up` rather than
  one per component. They ship one more release and are then removed. Their
  behaviour is unchanged, and they are kept for that release for a specific
  reason: `fleet service install` has never been run and these have.

## [0.4.2] — 2026-09-07

Everything the shelf photograph needs, except the photograph.

### Added

- **The banner and the social card, over a photograph.**
  `docs/figures/shelf-banner.html` and `shelf-social.html` set the mark, the
  name and the tagline over a picture of the actual shelf, dimmed and scrimmed,
  in the lower left, with the gradient running the full width so a shelf on
  either side of the frame still reads. The photograph itself is deliberately
  not in the repository: it is a picture of real hardware, and a generated or
  stock substitute would be the same lie as an invented benchmark. The shot
  guide is in [`docs/brand.md`](https://addisdev.github.io/fleet-runner/brand/#the-shelf-photograph).
- **`data-requires` on a figure**, naming a file that figure is built around.
  Absent, `npm run assets` skips the figure with a message instead of rendering
  a hole, so the renderer stays green with no photograph in the tree. Present,
  an `<img>` that fails to load is now an error rather than a gap.
- **`data-format="jpeg"`**, which writes `.jpg` at quality 82. A drawing is flat
  colour and compresses to nothing in PNG; a photograph in PNG is several
  megabytes for no difference a reader can see.

### Changed

- **The figure sources move from `docs/assets/` to `docs/figures/`.** They are
  inputs to `npm run assets`, not pages, and mkdocs was publishing them — which
  put the shelf figures' `<img>` for a photograph nobody has taken yet into the
  built site, where the link check correctly failed on it. Excluding them is the
  fix; the rename is what makes the exclusion safe, because **Material for
  MkDocs writes its own theme stylesheets to `site/assets/`**, so excluding
  `assets/` built a site whose every page linked a stylesheet it no longer
  shipped. The `docs/assets/` path named in the 0.4.1 notes below is that
  directory under its old name.

## [0.4.1] — 2026-09-06

What the project looks like to somebody who has just found it, and one
platform that could not describe itself.

### Fixed

- **A Windows agent reports what it is again.** Every descriptor field came
  from `wmic`, which is a *removed* feature on current Windows rather than a
  deprecated one, so a Windows runner registered with `model`, `soc`, `ram_mb`,
  `os` and `gpu` all null. It still ran work — the probes degrade to nulls as
  designed — but `targets.match` could not select a Windows machine by its OS
  or its memory, which left `device_id`, `platform` and `arch` as the only
  handles on one. The probes now lead with PowerShell `Get-CimInstance` and
  keep `wmic` as the fallback for older installs, in one process running six
  queries because its startup is the expensive part and this sits on the path
  to registration. `vram_mb` stays null on purpose: `AdapterRAM` is a uint32,
  so every card with 4 GB or more reports the same saturated ceiling, and
  reporting that as 4095 would let a match expression asking for 16000 skip the
  24 GB machine that could have run the job.

### Added

- **An asset pipeline.** `docs/brand.md` claimed the banner and the social card
  were rendered from source; no such source was in the repository, so nobody
  could regenerate either when the mark changed. `docs/assets/` now holds one
  HTML file per figure on the brand's tokens, with shared device outlines and
  self-hosted OFL fonts, and `npm run assets` in `collector/` renders each with
  Playwright at 2× into `docs/img/`.
- **Five hand-drawn figures**: how it fits together, the life of a job, the
  protocol on two rails, all 28 workloads by who can claim them, and platform
  coverage — the last encoding the honest column of `docs/platforms.md`, so an
  amber outline means somebody watched it register, a lit pulse in a grey
  outline means the code builds and no such device has run it, and an unlit
  tile means it has not been run at all.
- **Three screens and a recording, captured from real work.**
  `npm run shoot:dash` and `npm run shoot:motion` each start a collector on a
  spare port with its own data directory and run the real agents against it.
  The first retakes the getting-started result by running the job that guide
  tells you to run, opens an alert with a `self-check` that fails honestly
  because an agent started by hand is not loaded under launchd, and drives a
  whole visual regression — shoot this project's own built documentation site,
  accept the baseline, serve it again with a theme colour changed, shoot it
  again. The percentages on that grid are measured from pixels that really
  differ. The second records the Overview at 4 frames a second while a laptop
  and two browser runners claim a fan-out and report back.
- `collector/examples/web-specs/fleet-docs/`, the shots manifest that visual
  capture uses. It has to sit under the directory `playwright.config.ts` names
  as its `testDir`; a manifest anywhere else means `playwright test` finds no
  tests and every page reports `missing`.

### Changed

- **The architecture diagram is drawn rather than generated.** It was a mermaid
  block, in three copies. GitHub renders mermaid in its own theme with its own
  layout engine, so it was the one element on the page that could not be made
  to match the rest, and it sat in the section a reader uses to decide whether
  to keep reading. The protocol page's sequence diagram goes the same way. The
  unused mermaid export `docs/img/architecture.svg` is deleted.
- **The banner names the components in this repository** rather than the three
  archived repositories, and its empty right half shows the shelf's own device
  outlines.
- **The README opens on the thing working.** Banner, the claim, the numbers,
  eighteen seconds of a fan-out, then the documentation table. "What is in
  here" moves below how it fits together and what it can run. Four badges — CI,
  docs, release, licence — go above the banner.
- The documentation index takes the architecture figure as its hero and turns
  its "Start here" table into grid cards.
- **CI no longer runs the iOS launch smoke**, only the static
  `check-backdeploy.sh`. Booting a simulator cost about seven minutes a run, and
  the launch check could not catch the back-deployment bug it was written for
  anyway: a GitHub macOS runner ships only the newest iOS runtime, which is
  precisely where such a bug does not reproduce. `launch-smoke.sh` stays in the
  repository as the tool to run by hand on a machine with older runtimes.
- `shoot-runner-web.ts` resolved the collector from an absolute path into a
  worktree that will not exist next month, and now resolves from its own
  location.

### Not done, and said so

- **There is no Evals screenshot.** That screen shows the plant-ID accuracy
  rows, which a fresh database cannot have, and seeding them would put invented
  numbers under a heading that says measured. There is no composite of the
  three agent apps either; that needs the Android and iOS agents built and
  running on real devices. `docs/brand.md` says both where somebody would go
  looking.

### Fixed

- **A duplicate `job_id` became a 500 instead of a 409.** `POST /jobs` compared
  `e.code` against the string `SQLITE_CONSTRAINT_PRIMARYKEY`; Node puts
  `ERR_SQLITE_ERROR` in `code` and the extended result code in `errcode`, so the
  comparison silently stopped matching when the driver changed. It is
  `isUniqueViolation` in `db.ts` now, where knowing the driver belongs. The
  smoke suite caught it.
- **Ten places bound a possibly-undefined value**, which throws at runtime in
  either driver. `better-sqlite3` typed bound parameters as `any` and
  `node:sqlite` does not, so the stricter types found them.
- **A jobs-table rebuild was defined and never called.** The migration wrapper
  returns a function the way `better-sqlite3`'s did, and the call was dropped in
  the rewrite. The failure is invisible on a fresh database, because the
  `CREATE TABLE` beside it already names every status -- only an existing
  collector would have found it, as a constraint error the first time a
  dependency chain set a job `waiting`.
- **The machine agent died rather than retrying when its collector was not up
  yet**, which under `fleet up` is every single boot, since the agent reliably
  wins the race. It would have exited, been restarted, exited again, and hit the
  crash-loop ceiling on a fleet that was working perfectly.
- **`selfCommand` looked for a sibling file that only exists in a checkout**, so
  the supervisor could not spawn its own children from a release.
- **`FLEET_NAME` was defined in the settings and read by nothing.** Found by a
  screenshot: two collectors on one machine both called `MacBookPro`, because
  both took the default from the same hostname -- precisely the case
  multi-homing creates. It overrides for the life of the process without
  touching the identity file, and the id is never overridable, because an id
  somebody can set is an id two brains can collide on.
- **A device busy for another collector read `idle` on the dashboard**, which is
  the one thing it is not, and the reading that sends somebody off to debug a
  queue that is working perfectly. It says `busy · <the other brain's address>`
  now, with the job id on hover.
- **Aborting the other long-polls the instant a claim is taken is measurably
  worse**, and the new test caught it before it shipped: a poll that has already
  been answered has its job thrown away by the abort, with no runner and no
  release, and it sits `claimed` until a lease sweep. The losing poll finishes
  and hands its job back instead.

### Not verified

Everything in this list is written and reviewed and has not been run. It is
collected here rather than scattered, because a reader deciding whether to trust
this release needs the list.

- **Nobody has run a fleet on Windows or Linux.** The suites do: `ci.yml` runs
  the collector on Windows, Linux x64 and Linux arm64, and the `fleet` package's
  own suite -- including the supervised `fleet up` end to end and the two-brain
  race -- on all three platforms. That is not the same as somebody standing a
  fleet up on one and using it. Everything that has been *watched* to work
  -- `fleet up` supervising a brain and an agent from a checkout and from the
  bundled release, clean SIGTERM shutdown, mDNS discovery and `fleet join
  --discover` -- was on macOS/arm64.
- **`fleet service install` has never been run on any platform.** Not launchd,
  not systemd, not the Windows scheduled task. No path it writes has been watched
  to start at login.
- **`fleet/Dockerfile` is built but never run.** The release workflow built and
  pushed `ghcr.io/addisdev/fleet` for linux/amd64 and linux/arm64, so it
  assembles; no container has been started from it, so the entrypoint, the
  volume, the health check and the non-root user are all untested.
  `runner-machine/Dockerfile`, the agent-only image, is not built at all.
- **The install scripts were exercised against locally built archives** --
  checksum verified, a tampered archive refused, a re-install leaving config and
  data intact -- and `install.sh` has since been run against the real v0.5.0
  release on macOS/arm64. `install.ps1` has still never been parsed by
  PowerShell, let alone run.
- **No signing, notarisation, winget, Scoop or Homebrew.** Each is omitted with a
  comment saying why, rather than referencing a secret that does not exist and
  failing from the first tag. macOS will quarantine an archive downloaded in a
  browser; `install.sh` is unaffected only because `curl` does not set the
  attribute.
- **The Roku channel has never been compiled, let alone run.** No Roku hardware
  was available and no Roku emulator exists -- BrightScript's only compiler is
  inside a television. What is checked: the digest is verified against two
  independent references, XML well-formedness and block balance are checked
  mechanically, and a hand review in place of a linter found six real defects,
  four of which would have been parse errors on the firmware and on nothing
  else. Whether a screensaver suspends, throttles or ignores a running channel is
  unknown, and the throttled case would silently produce slow numbers. The
  driver's SSDP parsers are tested against recorded shapes; its UDP socket path
  is exercised by nothing.
- **None of the desktop app's Rust has ever been compiled.** There is no Rust
  toolchain on the machine it was written on, so `cargo check` has never run. It
  has never run at all -- not the tray, not the settings window, not a
  notification, not the dashboard window. Info.plist merging, the bundle resource
  layout, signing and notarisation are all assumed rather than observed.
  Critically, **the local-network hypothesis the app exists for is untested**:
  whether macOS attributes a Tauri sidecar's traffic to the bundle that spawned
  it, when `fleet up` then re-execs into grandchildren running the system `node`
  from outside the bundle. The honest assessment is roughly even odds leaning
  against. What *was* checked: both JSON files parse, both plists lint, `ui/app.js`
  parses and every element id it reaches for exists, the config struct's field
  order matches real `fleet config` output byte for byte, and the sidecar shim
  was actually run under a Finder-like `PATH` with no Homebrew on it.

## [0.4.0] — 2026-09-06

Waves 4 to 8: the fleet stops being a shelf of phones.

### Added

- **A browser tab is a fleet device.** `http://<collector>/runner` enrols the
  browser that opens it — one HTML file, no build step, no install. A smart TV's
  browser, a console, a Chromebook, a Kindle, a friend's phone via a QR code.
  It declares `benchmark:jssha` and `benchmark:webcrypto` and deliberately NOT
  `benchmark:synthetic`, because a browser's only native hash is asynchronous
  and its rate is not the same quantity as a phone's. What it does prove is
  correctness: it reports `synthetic_digest`, so it can be shown to be doing the
  fleet's arithmetic.
- **Platform and kind are declared by the agent**, not inferred from an `os`
  string. `platform` is an open string (`android`, `ios`, `tvos`, `watchos`,
  `visionos`, `macos`, `linux`, `windows`, `web`) and `kind` names the form
  factor. The old regex remains as the fallback for agents that predate the
  fields, so upgrading does not relabel a running shelf. The dashboard facets
  both out of the data and draws a television, a watch, a headset, a board and
  a browser tab rather than drawing everything as a phone.
- **`backend` and `model.format` are open strings**, enforced by capabilities
  the way `workload` already was. ONNX, MLX, ExecuTorch and WebGPU can be named
  in a job without a collector release.
- **A driver registry** under `collector/src/drivers/`: adb, simctl, devicectl,
  each a file. Both Apple tools always reported the real platform in their
  listings and nothing was reading it, so every booted simulator was called
  `ios` and an Apple TV was filtered out one line into discovery. tvOS, watchOS
  and visionOS devices are now discoverable and installable.
- **A conformance suite** — `npm run conformance -- --device <id>` — that drives
  a running agent through eight clauses, each of them something that has
  actually gone wrong here. It turns the `recall_at1` bug into a check anybody
  can run, and verifies the synthetic backend's block digest against the
  specification rather than against another runner's code.
- **Ephemeral agents.** `ttl_s` at registration means a closed browser tab and a
  finished CI runner leave the shelf instead of accumulating as offline ghosts.
  The row is kept, so their results stay attributable.
- **Android reaches every shape it always could.** Leanback launcher category,
  a TV banner, and touchscreen declared not-required, so the same APK installs
  and starts on Android TV, Fire TV, Quest and Wear.
- **A tvOS target** in the iOS project, from the same sources: two conditions
  rather than a fork. A visionOS target is written and has never been compiled.
- **A Dockerfile for the machine agent**, multi-arch by construction.
- **`llm-eval`**: the fleet finally measures whether an answer is any good and
  not only how fast it arrived. A device generates, a machine scores — five
  rules, with the deterministic and model-judged halves reported separately and
  never averaged.
- **`upgrade-test`**: install the version users have, seed it, upgrade in place,
  check the data survived. The stage is on every row, because "upgrade-test
  failed" without it sends somebody to read the wrong logs.
- **`size-report`**: archive, download and installed bytes, grouped per ABI. No
  device, no toolchain, so it can run on every push and the trend exists when
  somebody finally asks.
- **A tailnet allowlist**, off by default. Not authentication, and it does not
  make the collector safe to expose — it fences the tailnet so that a
  `FLEET_BIND` that reaches outside the house still only admits nodes you named.
  It never fences the LAN.
- **`npm run chaos`**: the collector's own guarantees, made to fail on purpose.
  A lapsed lease, exhausted attempts, a rotted artifact, a `SIGKILL` mid-job, a
  cancelled job across a restart.
- **CI on the platforms the machine agent claims**: Windows and arm64 Linux
  alongside x64 Linux and macOS, printing the descriptor each one would send.
- **`docs/platforms.md`**: every platform, what it takes to join, and an honest
  column saying which have actually been watched to register.

### Changed

- `physicalIos` is `physicalApple`, and discovery no longer drops every Apple
  device that is not an iPhone or iPad.
- The machine agent's benchmark beacons on a clock rather than on an iteration
  count. It previously beaconed only in sustained mode, which meant an ordinary
  benchmark could not learn it had been cancelled until the background beacon
  came round a minute later — by which time it had finished. Found by the
  conformance suite.
- Maestro's flow helpers moved from `executor.ts` into `workloads/flows.ts`, so
  a workload directory can run a flow. Three handlers are now directories.

### Fixed

- **A Windows machine agent described itself as nulls.** Every Windows field
  came from `wmic`, which is a removed feature on current Windows rather than
  merely a deprecated one, so `model`, `soc`, `ram_mb`, `os`, `gpu` and
  `vram_mb` all answered nothing — leaving `device_id`, `platform` and `arch`
  as the only handles a `targets.match` expression had on a Windows machine.
  The probes now lead with PowerShell `Get-CimInstance` and keep `wmic` as the
  fallback for older installs. Found by the platform matrix added in this same
  release, which is what it was added to do.
- A platform probe that could not read memory erased the reading Node already
  had. `describe()` fills `ram_mb` from `os.totalmem()` and then merges the
  platform-specific fields over it, and a plain spread let a probe's null win —
  which is the second reason Windows reported no memory, and would still have
  reported none on a machine where neither query surface answers. The probe
  still wins when it answers; a miss now falls back.
- The tailnet allowlist matched a short node name against a fully qualified
  entry in one direction only, so an allowlist written the careful way silently
  refused the node it was written for.

## [0.3.1] — 2026-09-06

### Fixed

- **The iOS runner could not launch on any simulator runtime newer than 18.4.**
  `import WebKit` plus one call to `callAsyncJavaScript` made the linker
  hard-require `/usr/lib/swift/libswiftWebKit.dylib`, because for a deployment
  target below 18.4 the SDK's `$ld$previous$` rules place about thirty
  Swift-only WebKit APIs in that library. The overlay was folded into
  `WebKit.framework` at 18.4 and the standalone dylib stopped shipping, so dyld
  refused to start the process. The one call is now expressed with
  `evaluateJavaScript`, which is the plain Objective-C API and back-deploys, and
  the dependency disappears entirely.

### Added

- **Two iOS checks, run by CI, because the job had only ever proved the app
  compiles.** `check-backdeploy.sh` fails if the app links a Swift overlay that
  the SDK says has moved, which is the exact shape of the bug above and takes
  seconds. `launch-smoke.sh` installs on the oldest runtime available and
  asserts the process survives. The static one carries the weight: a CI runner
  ships only the newest iOS runtime, and that is precisely where a
  back-deployment bug does not reproduce.

## [0.3.0] — 2026-09-05

Documentation, and the things a public project needs that this one did not have.

### Added

- **A documentation site** at
  [addisdev.github.io/fleet-runner](https://addisdev.github.io/fleet-runner/),
  built from `docs/` and published by its own workflow. The collector's
  907-line operations manual is split into concepts, workloads by executor, the
  HTTP API, deployment, networking, alerts and the dashboard.
- **The protocol, written down.** It had existed only in the two JSON schemas
  and three independent implementations of it.
- **A getting-started guide that needs Node and nothing else** — the machine
  runner rather than a phone, so a first result row costs fifteen minutes with
  no Xcode, no NDK and no device.
- **An integration guide**: a first job by hand, publishing builds on merge,
  wiring in an app, adding a workload, and a cookbook of **30 complete job
  specs validated against `job.schema.json` by `npm test`** and included
  verbatim by the docs.
- **A `ci-ok` merge gate** that always runs and reports, so the path-filtered
  component suites can back a required status check.
- **An iOS app icon.** The runner had no asset catalogue at all.
- A social preview card, the architecture diagram as a standalone SVG, and
  `docs/brand.md` recording how each asset is made.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates
  including a device report, and a pull-request template.

### Changed

- The four component READMEs stop calling themselves by their old repository
  names, and every "Phase N status" checklist becomes a "what works, and what
  does not" section in the present tense.
- App-specific flows and web specs move under `collector/examples/`, with
  `FLEET_FLOWS_DIR`, `FLEET_WEB_SPECS_DIR` and Playwright's `testDir`
  following them. The CI templates lose the app name they were pinned to.
- `collector/docs/operations.md` becomes a table pointing at where each of its
  sections went.

### Fixed

- **`job.schema.json` had drifted from what the collector accepts**, and
  nothing had ever checked it — the collector does not validate `POST /jobs`
  against the file. `backend` did not list `synthetic`, which all three runners
  emit; `app.sha256` required 64 hex characters, so `"latest"` was invalid
  against its own schema despite being what the CI docs tell everyone to
  schedule; and neither `sha256` accepted the `${jobs.<id>.artifact}` reference
  the `depends_on` description promises by name.
- The Android README described its llama.cpp backend as a stub, months after
  the NDK and JNI backend shipped.
- Two READMEs had `cd` commands pointing at directories that no longer exist.
- Two relative links in the design journals, broken by the move into `docs/`
  and caught by building the site with `--strict`.

## [0.2.0] — 2026-09-05

The first release from the mono repo, covering two waves of work plus the
migration itself.

### Added

- **Job chains.** `depends_on` makes build → install → ui-test a single
  enqueue. A promoted spec can carry `${jobs.<id>.artifact}` and
  `${jobs.<id>.metrics.<key>}`, substituted whole so a metric stays a number.
  Chains parked on a dependency are counted as `waiting`, not `queued`, so a
  healthy pipeline does not read as a backlog.
- **Preemption.** A twelve-hour `drain` steps aside for a two-minute
  `install`, checkpoints, and is requeued with `params.resume_from`. Stepping
  aside never counts against `max_attempts`, because it is not a failure.
- **The `build` workload**, on the machine agent: check out a ref, build it,
  publish the product to the artifact store, and let a later job resolve
  `"sha256": "latest"` to it.
- **Nine more workloads.** `speech-eval` and `embed-eval` on the phones;
  `vantage` from wherever an agent sits; `locale-shots`, `app-soak` and
  `a11y-audit` on the host; `self-check` on the hosts themselves;
  `model-convert`, `dataset-prep` and `serve` on the machine agent.
- **The `shell` workload, gated by a locally pinned allowlist.** `POST /jobs`
  is unauthenticated by design, so the one workload that runs arbitrary code
  declares its capability only when the owner has pinned a sha256 by hand in a
  local file. A machine that has pinned nothing is never offered the job at
  all, rather than claiming it and refusing afterwards.
- **Energy measurement**, reported in watt-hours at the wall above a measured
  idle baseline, or not reported at all. `energy_method` is declared in
  configuration and never inferred; a `plug-shared` pool reports the pool's
  draw and refuses to divide it between devices.
- **An Evals page and `/api/evals`**, pivoting eval sets by model and device
  with a Markdown export. It counts and lists the rows it excluded, naming the
  metrics each one carries.
- **A live job mirror.** MJPEG frames in a bounded in-memory ring, dropped when
  the job ends, so an `<img>` can answer "what is it doing now" without the
  permanent storage cost of a video stream.
- **Real iPhone screen capture**, via a `WKWebView` inside the runner app. The
  profile is named `webkit` rather than `safari`, because a `WKWebView` has no
  reader mode and no content blockers.
- **A status screen and launcher icon for the Android runner**, including the
  pre-API-26 icon fallback that was missing.
- `CHANGELOG.md`, and a `ci-ok` merge gate that always reports.

### Changed

- **Four repositories became one.** `fleet-collector`, `fleet-runner-ios`,
  `fleet-runner-android` and `fleet-runner-machine` are now `collector/`,
  `runner-ios/`, `runner-android/` and `runner-machine/`. Every commit came
  across with `git subtree`, so history and authorship survive and
  `git log --follow` works through the move. The old repositories are archived
  and still resolve.
- **The component suites are reusable workflows** called by a single `ci`
  workflow, which decides which of them need to run. A path-filtered workflow
  can never be a required check, because GitHub reports a check that never ran
  as pending forever; `ci-ok` always runs and reports for all four.
- The host executor's handlers began moving into a directory per workload,
  starting with `install`, behind a loader that falls back to the existing
  chain for everything not yet moved.

### Fixed

- **Swift's `convertToSnakeCase` splits on capitals, and a digit is not one**,
  so `recallAt1` encoded as `recall_at1` — one underscore short of the declared
  metric name, which meant it silently never arrived. Explicit `CodingKeys` now.
- **A real-device soak ran `simctl` against a physical iPhone's UDID** and
  reported the process dead at every check.
- **The mono-repo migration left `.gitmodules` inside `runner-android/`**,
  where git never looks, so the gitlink for llama.cpp survived with no URL
  registered against it and `git submodule update --init` in a fresh clone
  silently found nothing to do.
- Four machine workloads referenced metric names that were never mirrored into
  the agent's own protocol type, so they did not compile; the same four were
  never dispatched or capability-gated, so they were dead code.

### Known gaps

Stated rather than implied. `push-latency` needs FCM and APNs credentials;
`camera-eval` needs a physical rig; `desktop-ui-test` has no desktop app to
test against. `model-convert`, `dataset-prep` and `serve` have never run
against a real toolchain — none of the converters resolves on the development
machine, and the capability probes correctly decline to declare them. Only
`install` has moved into the executor's plugin layout.

## [0.1.0] — 2026-09-03

The first public release, when the project was still four repositories.

### Added

- **The collector**: device registry, job queue with leases, artifact store
  addressed by content hash, results database, scheduler, alert engine, and a
  dashboard with live updates over SSE. Node, Fastify and SQLite in WAL mode,
  with no broker and no cloud.
- **Runner agents for Android, iOS and desktop**, sharing a JSON protocol and
  no code. Their synthetic SHA-256 benchmark is identical token for token on
  every platform, which is what makes a 2019 phone's number comparable to a
  laptop's.
- **The first real payload**: an on-device plant-identification evaluation
  across both platforms, at 77% top-1 and 7 ms per image on a phone.
- MIT licensing, third-party notices, CI on every component, and a `npm test`
  that starts a throwaway collector on a spare port so it never touches a live
  fleet's history.

[Unreleased]: https://github.com/addisdev/fleet-runner/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/addisdev/fleet-runner/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/addisdev/fleet-runner/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/addisdev/fleet-runner/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/addisdev/fleet-runner/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/addisdev/fleet-runner/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/addisdev/fleet-runner/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/addisdev/fleet-runner/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/addisdev/fleet-runner/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/addisdev/fleet-runner/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/addisdev/fleet-runner/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/addisdev/fleet-runner/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/addisdev/fleet-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/addisdev/fleet-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/addisdev/fleet-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/addisdev/fleet-runner/releases/tag/v0.1.0
