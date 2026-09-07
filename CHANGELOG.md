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
root is the source, `scripts/version.mjs` writes it into all seven places, and
a CI job fails when they disagree.

## [Unreleased]

## [0.5.0] -- 2026-09-07

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
- **CI no longer runs the iOS launch smoke**, only the static
  `check-backdeploy.sh`. Booting a simulator cost about seven minutes a run, and
  the launch check could not catch the back-deployment bug it was written for
  anyway: a GitHub macOS runner ships only the newest iOS runtime, which is
  precisely where such a bug does not reproduce. `launch-smoke.sh` stays in the
  repository as the tool to run by hand on a machine with older runtimes.

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

- **The `fleet` CLI has never run on Windows or Linux.** Not the CLI, not the
  supervisor, not the bundle. The paths, the process handling and both service
  backends are written and untested; `fleet.yml` declares a three-platform
  matrix that has never executed. Everything that *has* been watched to work --
  `fleet up` supervising a brain and an agent with a synthetic benchmark running
  end to end through both, from a checkout and from the bundled release, clean
  SIGTERM shutdown, mDNS discovery and `fleet join --discover` -- was on
  macOS/arm64 and nowhere else.
- **`fleet service install` has never been run on any platform.** Not launchd,
  not systemd, not the Windows scheduled task. No path it writes has been watched
  to start at login.
- **Neither Dockerfile has ever been built**, and no image has been pushed.
  Docker was not available on the machine that wrote them.
- **The install scripts have never met a real GitHub release**, because none
  exists. They were exercised against locally built archives: checksum verified,
  a tampered archive refused, a re-install leaving config and data intact.
- **`release.yml` has never run.** The first tag is the first run.
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

[Unreleased]: https://github.com/addisdev/fleet-runner/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/addisdev/fleet-runner/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/addisdev/fleet-runner/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/addisdev/fleet-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/addisdev/fleet-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/addisdev/fleet-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/addisdev/fleet-runner/releases/tag/v0.1.0
