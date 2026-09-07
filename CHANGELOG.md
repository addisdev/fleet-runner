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

[Unreleased]: https://github.com/addisdev/fleet-runner/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/addisdev/fleet-runner/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/addisdev/fleet-runner/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/addisdev/fleet-runner/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/addisdev/fleet-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/addisdev/fleet-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/addisdev/fleet-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/addisdev/fleet-runner/releases/tag/v0.1.0
