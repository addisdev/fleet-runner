# Changelog

Notable changes to Fleet Runner. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

One version covers all four components. They ship no shared code, only a JSON
protocol — and that protocol is the thing that changes, so it is the thing the
version tracks. A release note says which components moved. The wire protocol
itself is `"schema": 1` and stays there until something breaks compatibility,
independently of the version below.

## [Unreleased]

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

[Unreleased]: https://github.com/addisdev/fleet-runner/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/addisdev/fleet-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/addisdev/fleet-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/addisdev/fleet-runner/releases/tag/v0.1.0
