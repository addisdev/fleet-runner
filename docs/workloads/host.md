# Host workloads

Claimed by an executor process on a Mac, with `"executor": "host"`, and driving
a device from *outside* over adb or `simctl`. Installing an APK or tapping
through a UI test is not something an app can do to itself.

The executor runs wherever the devices are physically attached. See
[Deploy](../deploy/index.md) for where it lives and what it needs on `PATH`.

## `enrol`

Tell every attached device which collector to talk to, without anybody typing
an address.

```json
{ "workload": "enrol", "executor": "host",
  "params": { "url": "http://fleet-host.local:8788" } }
```

The enrolment screen has always said the hard part is typing an address on a
touch keyboard without a typo. A QR code answers that for a phone, because a
phone has a camera. It answers nothing for a television, which has neither a
camera nor a keyboard worth using, and a Roku remote has no text entry beyond an
on-screen grid.

There are two ways out: the device finds the brain, or the brain reaches the
device. [Discovery](../deploy/index.md) is the first. This is the second, and it
is the one that still works when multicast is blocked — which is guest wifi,
most offices, and every Docker bridge network.

Each driver knows its own mechanism:

| Driver | How |
|---|---|
| `adb` | `am start -S --es base_url <url>` — the Android runner has read this since the shelf was built |
| `simctl` | `simctl launch` with `SIMCTL_CHILD_FLEET_URL` |
| `devicectl` | `devicectl device process launch --payload-url fleetrunner://join?url=…` |
| `roku` | `POST /launch/dev?fleet_url=<url>` over ECP |

### It verifies, because all four fail silently

This is the whole reason the workload is more than a shell script. Every one of
those mechanisms reports success for a device that did not enrol: `am start`
exits 0 and prints `Error type 3` when the package is not installed; a `simctl
launch` succeeds against an app that ignores its environment; an ECP launch
returns 200 for a channel that then cannot reach the address it was handed.

So a device's result row is **"it registered with that collector within the
window"**, or the reason it did not — and the reason names which half failed,
the launch or the registration after it. Ninety seconds by default,
`params.wait_s` to change it.

Registration is detected by watching for a device id that was not in the
registry before. Not by name: the runner chooses its own id and nothing outside
the device can predict it — a Roku's is `GetChannelClientId()`, a per-publisher
value ECP does not expose. The cost is that an unrelated device registering
during the window would be credited to this enrolment, which on a shelf being
deliberately enrolled is a fair trade for a check that works at all.

!!! warning "A loopback address is refused"

    Omitting `params.url` uses the collector this executor claims from, which is
    usually right. If that is `127.0.0.1`, the job fails immediately rather than
    enrolling a shelf onto an address no other device can reach — a failure that
    otherwise looks like a network problem for days. Pass the LAN or tailnet
    address explicitly.

**Status: the launch path has never been run against a device.** No Android
device was attached and no simulator was booted on the machine this was written
on. What is tested is every path that decides *not* to enrol: the loopback
refusal, no targets, a driver with no mechanism, and one device's failure not
stopping the others.

The Apple half is closer than that suggests: the runner reads `FLEET_URL` from
its launch environment and handles `fleetrunner://join`, and both the iOS and
tvOS apps were built and their `Info.plist` confirmed to register the scheme.
What has not happened is a device being launched with either.

## `install`

One artifact onto every attached device — `adb install` on Android,
`simctl`/`devicectl` on iOS.

```json
{ "schema": 1, "job_id": "install-903", "workload": "install", "executor": "host",
  "app": { "name": "your-app-android", "build": "903", "sha256": "latest" } }
```

`"sha256": "latest"` resolves to the newest build published for that app name.
That is the mechanism that stops a nightly testing a build older than the code
it guards — see [Publish on merge](../integration/publish-on-merge.md).

With nothing attached, the job is claimed and fails cleanly with
`no android targets attached`, which is the correct answer rather than a hang.

## `explore`

A vision model uses tonight's build the way a person would, and leaves a short
list of reproduced bugs for the morning: crashes, hangs, blank screens, controls
that do nothing, accessibility gaps, visual defects and goals that did not hold.
Every candidate is replayed on a clean install before it is filed, and your
verdicts on the [Findings page](../explore/findings.md) decide which checks keep
running.

```json
{ "schema": 1, "workload": "explore", "executor": "host",
  "app": { "name": "greenfolio-android", "build": "nightly", "sha256": "latest" },
  "targets": { "executor": "ultra", "match": "os ~ 'android'", "exclusive": true },
  "params": { "app_id": "com.taylab.greenfolio.debug", "app_key": "greenfolio",
              "minutes": 100, "conditions": ["baseline", "dark", "locale:es"] } }
```

It drives Android phones and TVs over adb, iOS and tvOS through the FleetDriver
UI-test bundle, and a Roku through tvloop. It has a
[section of its own](../explore/index.md): a
[laptop quickstart](../explore/quickstart.md),
[how a night works](../explore/how-it-works.md),
[mission cards](../explore/missions.md), and the full
[job spec](../explore/job.md).

## `upgrade-test`

Does the version users already have survive becoming this one? Almost no app
project automates this, and it is the failure that actually loses people. A
clean install passes every suite in the fleet; the path nobody runs is a real
user with two years of data taking an update and the migration dropping a table.

```json
{ "schema": 1, "job_id": "upg-1", "workload": "upgrade-test", "executor": "host",
  "app": { "name": "app-android", "build": "latest", "sha256": "latest" },
  "params": { "from_sha256": "<the build users have>",
              "seed_flow": "seed-account", "verify_flow": "account-survived",
              "app_id": "com.example.app" } }
```

Five steps: install the old build, seed it with a flow, install the new build
**over** it, launch, verify. Step three is the one that has to be right —
`adb install -r` and simctl both upgrade in place and keep the sandbox, and an
uninstall between the two would make this an install test with extra steps that
passes forever.

**The stage is on every row and is the point of the row.** A failure at
`install-old` or `seed` is the old build's problem and says nothing about the
upgrade; at `upgrade` it is packaging, a signature mismatch or a downgraded
versionCode; at `launch` it is a migration that crashes on start; at `verify` it
upgraded, it launched, and the data is wrong. "upgrade-test failed" without the
stage sends somebody to read the wrong logs.

`from_build` must already be resolved to a hash. The executor deliberately does
not resolve build names — the collector owns publish ordering, and a workload
guessing which artifact "1.4.0" meant could pick a different one than the
dashboard shows.

## `size-report`

The cheapest workload here. No device, no install, no toolchain: it fetches an
artifact a `build` job published and reads its zip central directory. So it can
run on every push forever, and the value is the trend — a graph of download size
per build answers "when did this get big" months later, which nobody can answer
retrospectively without having measured all along.

```json
{ "schema": 1, "job_id": "size-1", "workload": "size-report", "executor": "host",
  "app": { "name": "app-android", "build": "latest", "sha256": "latest" } }
```

Three numbers, because one misleads:

| Metric | What it is |
|---|---|
| `artifact_bytes` | the archive: what CI publishes and the store holds |
| `download_bytes` | the sum of compressed entries: roughly what a user waits for |
| `installed_bytes` | everything unpacked: roughly what it occupies on the device |

They differ by a lot — native libraries compress well and resources do not — and
quoting one when somebody meant another is the usual way a size report misleads.

Native libraries group **per ABI** rather than as one `lib/`. `lib/` being huge
tells you nothing you did not know; `lib/arm64-v8a` being 18 MB of it tells you
what to split.

## `tvloop`

Runs [tvloop](../explore/surfaces.md#roku-through-tvloop)'s hardware suite
against a Roku on the executor host's network. tvloop is the Roku development
CLI and already has a hardware nightly, aimed at a self-hosted Actions runner
nobody carries; this workload runs the same steps on the fleet instead.
**tvloop drives, the fleet lends**: tvloop knows how to talk to a Roku, and the
fleet's part is the device lock, the address, the password and filing what came
back.

```json
{ "schema": 1, "job_id": "tvloop-1", "workload": "tvloop", "executor": "host",
  "targets": { "match": "os ~ 'roku'", "exclusive": true },
  "params": { "steps": ["doctor", "install", "hardware", "replay"] } }
```

| Step | What runs | |
|---|---|---|
| `doctor` | `tvloop doctor --json` | A failure stops the run |
| `install` | `tvloop install --force` | Sideloads the checkout's channel into the Roku's one dev slot, **replacing whatever is there**. A failure stops the run |
| `spike` | `tools/m0-spike.mjs --full` | Opt-in, not in the default: ten sideloads, slow |
| `hardware` | tvloop's vitest suite with `--testNamePattern hardware` | |
| `replay` | `tvloop replay --reporter junit` | The JUnit counts become the row's test counts |

The default is doctor, install, hardware, replay. `params.flows` picks which
flows to replay (default: all of the checkout's `tests/flows`), and
`params.dir` the checkout, which must be built: `FLEET_TVLOOP_DIR`, then
`~/tvloop`. A host with no built checkout **fails** the job and says how to
build one, because that is misconfiguration.

**`exclusive` matters more here than anywhere.** A Roku holds exactly one dev
channel, so two jobs sideloading onto it at once is a corrupted run, and the
lock is held around the whole suite.

**The developer password is a Keychain item on the executor host**: service
`fleet-roku-dev` (`FLEET_ROKU_KEYCHAIN_SERVICE` to change), account `rokudev`.

```bash
security add-generic-password -s fleet-roku-dev -a rokudev -w
```

Without it a job of only Rokus is **skipped, not failed**: its row reads
"skipped: no Roku developer password on this host" with that command, because
it is a setup step nobody has done yet rather than a broken build. A Keychain
that refuses access fails the job. The password is passed to tvloop in its
environment and scrubbed from every log and report before upload, since the
artifact store is readable by anyone who can open the dashboard.

Only one executor should report the Rokus as its own devices: the host started
with `FLEET_ROKU=1`.

### Fire TV and Android TV

With `params.androidtv: { "package": "com.example.app.debug" }`, adb devices
that declare leanback run alongside the Rokus, each through a generated
`tvloop.toml`. Only `doctor` and `replay` run on them (install, spike and
hardware are the Roku adapter's), and they need no Roku password.
`params.androidtv.flows` replays a different set on the TVs.

A green TV row says less than a Roku row. tvloop's Android TV adapter reads no
logcat, so `assert noErrors` cannot fail there; its launch is `monkey` with
one random event, so a replay can start with a stray key; and a flow that
asserts focus or visibility always fails, because it has no Android UI tree.

### What is not proven

The fleet's Roku has never run this suite: its developer password is not in
the host's Keychain, so no run from the fleet has got past the skip. The step
sequencing, the skip, the scrubbing and the Android TV path are covered by
unit tests that fake each step's exit code; the Android TV adapter's caveats
above were seen driving an Android TV emulator through tvloop, not from this
workload on a real TV.

## `ui-test`

Maestro flows or an XCUITest bundle, per device, with the JUnit report parsed
back into results and uploaded as an artifact.

```json
{ "workload": "ui-test", "executor": "host",
  "app": { "name": "your-app-android", "build": "903", "sha256": "latest" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" },
  "targets": { "exclusive": true },
  "lease": { "ttl_s": 1200 } }
```

Flows resolve relative to `examples/flows/` in the executor's working
directory (`FLEET_FLOWS_DIR` to change). `exclusive`
takes a device lock for the run, because two suites tapping the same phone is
not a test.

**A failing Maestro run says which step broke.** The device row's `error` is
the first failing flow and its assertion, read from the JUnit report
(`smoke: Assertion is false: "Fleet Runner" is visible`), `test.failing_flow`
names the flow, and the report itself is the row's artifact
(`GET /api/v1/artifacts/<sha>/content`). When Maestro produced no report at
all, the error is its exit code and the last line it printed to stderr, never
its command line, which carries the test account's password. Until 0.9 the
reason was in the uploaded report and nowhere else.

### A sleeping phone

Before it drives an Android device's screen, `ui-test` (and `locale-shots`)
wakes it and asks the lock screen to go away. A phone on the shelf sleeps
between jobs and Maestro does not wake it, so a flow used to run against a dark
lock screen and fail on its first assertion, which read as the app being
broken. A lock screen with a PIN, pattern or password cannot be dismissed from
here: that device's row is `skipped` with the reason, and the fix is to set the
test device's screen lock to None or Swipe. Emulators have no lock screen.

### Regression tests from fixed findings

`params.regressions` adds the app's fixed night-QA findings to the run. Set it
to the app key the findings are filed under (what `fleetr findings` shows in
the APP column), or `true` to use `app.name`:

```json
{ "workload": "ui-test", "executor": "host",
  "app": { "name": "greenfolio-android", "build": "nightly", "sha256": "latest" },
  "suite": { "kind": "maestro", "flows": "greenfolio/smoke.yaml", "app_id": "com.taylab.greenfolio.smoke" },
  "params": { "regressions": "greenfolio" },
  "targets": { "match": "os ~ 'android'", "exclusive": true } }
```

At run time the executor asks the collector for the app's **active**
regression flows (`GET /findings/regressions`), and after the suite's own flow
runs each one whose finding was on the same platform as the device. A finding
joins by being marked Real and then Fixed; nobody edits the schedule. `flows`
may be left out to run only the regression flows; a device with none to run is
then skipped, not passed. The lab's `nightly-bug-garden-regressions` is a
working example: the garden's defects are planted, so a bug-garden finding
marked fixed comes back on every run and reopens, which is the mechanism
proving itself rather than a bug.

Each stored flow is adapted before it runs: its `appId` becomes the job's
`suite.app_id` when the job sets one (night QA often explores `.debug`; the
nightly may test `.smoke`), and a relative `runFlow` (the mission's sign-in
flow) is resolved under the flows directory. The suite's sign-in variables
reach the flow as they reach the suite's.

What a run asserts depends on the finding's check:

| Finding | On Android | Elsewhere |
|---|---|---|
| `crash`, `anr` | No new crash or ANR of the package in `logcat -b crash` / `am_anr` during the flow. A new one is `reproduced` and **reopens the finding** | Replays without error; the crash is not checked, and the detail says so |
| Any other check | Replays without error | Replays without error |

"Replays without error" is all a replay can claim for a check whose oracle was
a model or a heuristic: the flow repeats the steps, not the judgement. A flow
that fails is `failed` and fails the row, without reopening the finding,
because a step that no longer replays may be a redesigned screen. tvloop flows
are skipped (ui-test drives Maestro). Each regression counts as one test in
the row's `passed`/`failed`, is listed in `test.regressions` with its outcome,
and a failing one is named in the row's `error`. The regressions run outside
`params.network` shaping. Not yet run on the lab; see [Regression
tests](../explore/findings.md#regression-tests).

**iOS UI tests need a Mac with full Xcode.** `simctl` and `devicectl` ship with
Xcode, not the Command Line Tools, so they run on a different executor from the
Android work. [The iOS executor](../deploy/ios-executor.md) covers standing one
up.

## `cold-start`

Launch the installed build from cold, warm and hot; p50 and p95 per state, per
device.

**Metrics:** `launch_ms`, `launch_state`.

Cold-start on iOS is not offered: `simctl` returns at process spawn rather than
at first frame, so the number would measure the wrong thing.

## `app-soak`

Memory, jank and crashes over hours.

**Metrics:** `pss_mb`, `jank_pct`, `crashes`, `app_state`.

No PSS on an iOS simulator — only host RSS is available there, which counts
shared pages Android's PSS does not, so the two are not the same quantity and
the workload says so rather than reporting one as the other.

## `a11y-audit`

The accessibility tree diffed against a baseline, at the largest dynamic type.

Bold text below Android 12 is refused: the setting writes and nothing reads it,
so a pass would prove nothing.

## `locale-shots`

A screenshot flow under every locale, including RTL, bundled as a store-ready
contact sheet.

**Metrics:** `locales`, `shots`.

!!! tip "The check that catches a green run that measured nothing"

    It **fails a device when two locales produce byte-identical screenshots.**
    An app whose locale setting never reached it is otherwise indistinguishable
    from a correct run: the setting reads back fine, every folder exists, and
    every folder is in English.

Locale is not settable on a physical iPhone, and the workload refuses rather
than pretending.

## `web-test`

Playwright suites from `web-specs/` against `targets.url`, one result row per
config project. Needs an executor started with `FLEET_WEB=1`.

`params.browser` picks the projects: one name, an array run in sequence, or
`"all"` for everything in `playwright.config.ts`. The executor beacons between
projects, so the lease budgets one project rather than the whole matrix.

## `web-shots`

The capture half of visual regression. Reads `web-specs/<site>/shots.json` —
pages with optional `waitFor`, `mask` selectors, `fullPage` and `settle_ms`,
plus the profiles to capture under — screenshots every page × profile, and
uploads the PNGs.

![The Visual screen: two pages across two browser profiles, every cell diverged from its accepted baseline by around one to two percent after a theme colour changed](../img/visual.png)

Each capture is diffed with pixelmatch **on the executor**, because baselines
are only comparable to pixels rendered by the same host. A page over its
`threshold_pct` (default 0.1%) fails with `diff_pct` and a diff-image artifact.
A page with no baseline **passes** with a "new: no baseline" note until somebody
accepts a shot.

### Real phone screens

Two profile names expand to real hardware attached to the claiming executor, one
profile and one baseline per device, because two phones have two screens:

| Meta-name | Becomes | How |
|---|---|---|
| `android-device` | `android:<serial>` per Android device | Real Chrome driven via Playwright over adb |
| `ios-sim-safari` | `ios-sim:<name>` per booted simulator | Safari via `simctl openurl`, status bar pinned to 9:41 |

A meta-name that finds no hardware **fails its slot rather than quietly
shrinking the matrix**. Pin device captures to the executor whose shelf holds
the devices.

Real-iPhone Safari has no capture path; a `WKWebView` inside the runner app
covers it instead, and the profile is named `webkit` rather than `safari`
because a `WKWebView` has no reader mode and no content blockers, and somebody
reading "safari" in a baseline matrix would believe a stronger claim than the
capture supports.

## `web-audit`

Crawls `targets.url` with a real browser and audits every rendered page: titles,
descriptions, canonicals and their site-wide duplicates, h1s, JSON-LD validity,
redirect chains, broken internal links with who links them, bounded
external-link checks, sitemap-versus-crawl diff, robots.txt sanity. Then
re-renders each page under a phone profile for viewport meta, content overflow,
tiny text and tap targets.

A real browser rather than `fetch`, because these are single-page apps and
`fetch` would bless a blank body.

**Metrics:** `pages_crawled`, `issues_error`, `issues_warn`. Error-severity
findings fail the run; warnings land in the report artifact.

## `web-unfurl`

Fetches the **raw HTML** the way link-preview bots do — no JavaScript — under
several bot user-agents, and validates og and twitter tags plus the og:image
itself.

This exists because Open Graph tags injected client-side unfurl as nothing on
every platform, and **a browser-based check can never see that bug.** It needs
the raw HTML, which is the opposite of what the rest of the web auditing does.

## `drain`

Battery curve under a replayed GPX track.

**Metrics:** `drain_pct_per_h`, plus the per-sample curve.

Long-running, so the lease TTL defaults to 14400 s. Pairs with the smart-plug
[energy](../deploy/index.md#energy) support to unplug a pool before a run.

## `soak`

Whether a runner is still alive hours later — the per-check process-alive
timeline per device.

## `archive`

Pulls data the vendor will eventually delete, into the artifact store, where it
is kept forever.

- `source: "gsc"` — one finalized day of Search Console data. Google keeps 16
  months.
- `source: "asc"` — App Store Connect reviews, via an ES256 API key.
- `source: "play"` — Play Console reviews.

**Play returns roughly the last seven days of reviews and nothing older, so the
review pulls must run daily.** A lazy cadence loses data permanently.

Credentials are Keychain items on the executor host. The job spec names the
account only, never the secret: a spec is stored and shown to anyone who can
read jobs, and the collector has no authentication by default (see
[Authentication](../deploy/auth.md)), so a spec is not a place a credential
could safely live. Enqueue refuses a spec carrying a `password`, `token` or
similar key as `secret_in_spec`. Until the Keychain item exists the
job fails with instructions rather than silently producing nothing.

## `digest`

The weekly payoff, and the fleet eating its own cooking.

The executor gathers the week's archived reviews, dedupes by review id against
the previous digest's watermark, and **farms the LLM work to the shelf as
ordinary `batch` jobs**: one pass classifying every review against a fixed topic
taxonomy, deterministic clustering in code between the passes, one pass
summarising each cluster. Then it assembles a markdown digest with real quotes
**chosen in code, never generated**.

Devices are matched with `ram_mb >= 4000` and `require_charging`, and the job's
`model` names the GGUF the shelf runs.
