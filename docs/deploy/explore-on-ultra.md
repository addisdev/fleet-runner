# Overnight exploratory QA on ultra

Everything the [`explore` workload](../explore/index.md) needs on the
Mac Studio, in the order it happens. It starts only after the day-one setup:
ultra answers over SSH and its gateway is up (the day-one plan's phases 1 to 5).

The plan runs in phases, and each ends on a number. A missed number changes the
plan instead of being explained away. The thresholds below are the plan's
proposals.

## How it is installed on ultra

As set up on 8 October 2026. ultra's user is `studio`, not `addisdev`; it has
no Homebrew and no full Xcode; and its models, gateway, keys and nightly jobs
belong to the [Local LLM Harness](https://claude.ai/code/artifact/2fe401ec-a8ce-4a6e-a78a-5b31b83491f7),
which runs LM Studio, LiteLLM, Postgres and the night queue as system
LaunchDaemons. Explore plugs into that rather than running its own.

| Piece | Where |
|---|---|
| Node 24, a JDK 21, adb, the emulator, `google_apis` image, Maestro | user-local: `~/.local/opt/`, `~/Library/Android/sdk`, `~/.maestro`; `source ~/explore/env.sh` puts them on `PATH` |
| Fleet Runner checkout | `~/fleet-runner` (`npm ci` in `collector/`) |
| The emulator | AVD `fleet-explore-1`, android-35 `google_apis`, 1080×2400 at 420 dpi |
| Holo4 | `~/.lmstudio/models/Hcompany/Holo4-35B-A3B-GGUF/`: the vendor's Q4_K_M and its vision projector, renamed to LM Studio's convention (`Holo4-35B-A3B-Q4_K_M.gguf`, `mmproj-Holo4-35B-A3B-F16.gguf`) or LM Studio lists the projector as a separate model and cannot pair them. Model key `holo4-35b-a3b`, identifier `holo4-35b-a3b-gguf` |
| The gateway name | `pilot` in the harness's `litellm.yaml`: Holo4, 300 s timeout, no fallback. The judge is the harness's `judge` role |
| The shelf | `ondemand holo4-35b-a3b@holo4-35b-a3b-gguf 65536 1 3600` in `~/harness/shelf.conf`; `bash ~/harness/shelf.sh warm pilot` loads it when enough memory is free: 65% by default, 45% for explore, which sets `WARM_MIN_FREE_PCT=45` in its manifests and in `~/explore/env.sh` (the resident models keep ultra near 56% free, so at 65% Holo4 never loaded; at 45% its ~25 GB leaves about 29 GB). The shelf still refuses under memory pressure. The night command runs it (`--warm`) after its own checks, and retries a refusal for memory for ten minutes |
| The key | `~/.config/harness/keys/fleet.key` (roles `pilot`, `judge`, `vision`). Not the Keychain: neither SSH nor a LaunchDaemon can write the login Keychain on ultra. The workload reads `HARNESS_KEY`, then this file |
| The night | `~/night/recurring/fleet-explore.json`, run by the harness's night queue from 22:00 when memory pressure is normal, 35 GB is free and no CI job is running |
| The brain | On fleet-host, which ultra cannot route to. The night command opens `ssh -L 18788:192.168.50.27:8788 runner-ts` for the length of the run |

The night command (`collector/scripts/explore-night.ts`) opens the tunnel,
checks that each spec has a build and the night has time for it, warms the
model, boots the AVD or simulator if needed, enqueues the spec on the brain
pinned to the executor name `ultra` with `minutes` cut to what is left, runs an
executor in-process until the job ends, then shuts down what it started and
exits, so the night queue knows when the memory is free again. A spec that
cannot run tonight is posted to the brain as a skip and exits 0; see
[short nights and skips](../explore/job.md#short-nights-and-skips).

### Builds, TVs and Apple simulators (from 12 October 2026)

Three more night-queue jobs, kept in `collector/deploy/explore/night/` and
copied to `~/night/recurring/`. Lower priority numbers run first; the TV and
Apple nights go after every product's own night jobs (50–70), so a long
explore night can never push those past 07:30.

| Job | Priority | What it does |
|---|---|---|
| `fleet-explore-builds` | 19 | `deploy/explore/nightly-builds.sh`: resets `~/explore/builds/{greenfolio-ios,dozehound-tvos}` to `origin/develop`, builds a simulator `.app` (zipped) and uploads it to the brain as app `<name>`, build `develop-<sha>`. An unchanged sha is not rebuilt but is uploaded again, so the brain shows it as tonight's; a failed build leaves the previous one as `latest`, and the TV and Apple nights skip rather than test it again |
| `fleet-explore` | 20 | The bug garden on `fleet-explore-1` (unchanged) |
| `fleet-explore-tv` | 85 | Dozehound tvOS on simulator `fleet-explore-tvos` (tvOS 26.5) with its stub catalog: the 10 bench cards with Holo4, the same cards with the resident `vision` model (phase 3's 20 navigation missions), then the every-button explorer |
| `fleet-explore-apple` | 86 | GreenFolio iOS offline on simulator `fleet-explore-ios` (iOS 26.5): the first real-build night, phase 2's precision bar, and phase 4 |

**Explore builds never reach a backend.** The script writes each app's
`Secrets.xcconfig` from its template with `SUPABASE_URL = http://127.0.0.1:9`
(nothing listens there), a dummy anon key and empty collector keys. The apps
count as configured (Dozehound tvOS refuses to start otherwise; both allow
plain http to loopback) and every request fails locally.

**Fire TV is parked.** The Dozehound Fire TV app has no offline or stub mode
and refuses to start without a real `https` backend, so exploring it means
reading the production catalog. That is the owner's call (WB-297); until then
the script builds it only when named (`nightly-builds.sh dozehound-firetv`)
and the TV question is answered on tvOS.

### When a night cannot run (from 16 October 2026)

On 10-14 a CI job held the machine from 22:00 to 04:00. The night queue skipped
`fleet-explore-builds` and `fleet-explore` after their 120-minute waits; that
admission is the queue's and nothing in this repository can shorten it.
`fleet-explore-tv` then "passed" in 1.4 minutes and `fleet-explore-apple`
exited 1 in 0.0 minutes, which turned ultra's `model-ladder#night` check red.

- **The Apple night's exit 1 was the warm-up, not the build.** Its log has one
  line: `not loading holo4-35b-a3b@holo4-35b-a3b-gguf: 64% free, needs 65%`.
  The queue had admitted it on its own measure (35 GB free); the shelf
  refused on another (`memory_pressure`'s free percentage, 65% for an
  on-demand model) and the manifest's `&&` ended the job before
  `explore-night.ts` started. Yesterday's GreenFolio build was on the brain.
  The warm-up now runs inside the night command after its checks, a refusal
  for memory is retried for ten minutes and then posted as a skip, and with
  `--fresh-build` that night would have skipped earlier still, at "no
  greenfolio-ios build for tonight".
- **The TV night has tested nothing since it started.** Every job in it ended
  in twenty seconds with `skipped: no device matches this job on ultra`: the
  executor described a tvOS simulator as `os: ios`, so `os ~ 'tvos'` never
  matched. It now says `tvos-26.5`. No TV night has run since the fix, so the
  phase 3 bench result is still to come.
- **A night admitted late runs short instead of being killed.** The night
  queue already refuses to start a job whose `max_minutes` would run past
  07:30, so on ultra the binding limit is usually `max_minutes` itself (the
  TV night's three specs plus booting and warming come close to its 150). The
  `--until` check matters for a run started by hand and for any future
  queue that admits a job with less than its full budget.

`explore-night.ts` takes `--spec` more than once (run in turn on one device)
and `--sim name:runtime:devicetype`, which creates the simulator if missing,
boots it, and shuts it down afterwards if it booted it. Simulator names start
with `fleet-` so the executor counts them as fleet devices. FleetDriver builds
itself into `~/.fleet/explore/derived` on first use. Xcode builds use
`/Applications/Xcode.app`, `xcodegen` comes from `/opt/homebrew`. After an
Xcode update, `sudo xcodebuild -runFirstLaunch` has to run once before any
simulator test will; the night command checks for it and fails until it has.

### Measured on 8 October 2026

| Measure | Holo4 35B-A3B (GGUF Q4_K_M, LM Studio) | Bar |
|---|---|---|
| Pointing, 100 targets from 40 of our own screens | **100%**, median 2.2 s (Qwen3.8-27B on the same targets: 59%) | 85% |
| Model latency per step, 40-step mission | median 4.0 s, max 6.8 s, prompt up to 11.5k tokens | |
| Whole step (look, model, act, checks) | median 6.8 s | 20 s |
| Full-size screenshot reaches the model | yes: 2,569 prompt tokens at 2.6 MP, 665 at half size | |
| Tool calls | 40 of 40 steps, once `tool_choice` is `required` (with `auto`, the second turn sometimes came back as prose) | |

Its first 40-step bug-garden mission filed BG-01 and BG-03, both reproduced
2/2 on clean installs. The night rehearsal through the brain filed BG-16 (low
contrast), reproduced 2/2.

### The first nights on 0.9.0 (15 to 17 October 2026)

The night of 10-15 was the first with Holo4 allowed at 45% free and with tvOS
simulators registering as `tvos`, so the first time the TV and Apple nights
drove anything. The bug garden at 22:09 still ran the old code (0.9.0 was
deployed at 00:10) and skipped at "57% free, needs 65%". No night ran short:
each was admitted with its whole `max_minutes`.

**Phase 3, the tvOS bench** (Dozehound stub catalog, Apple TV 4K simulator on
tvOS 26.5, build `develop-ebcd74e46e`, 10 cards per model):

| Model | Passed, as scored | Cards it actually ran | Median step · model | Prompt, mean |
|---|---|---|---|---|
| Holo4 35B-A3B (`pilot`) | **5 of 10** | 5 of 8 | 4.5 s · 2.4 s | 5.9k tokens |
| Qwen3.8-27B (`vision`) | **5 of 10**; 6 with the end-state fix below, re-scored from its saved trees | 5 of 10 | 5.9 s · 3.4 s | 2.1k tokens |

Both passed `focus-meadow`, `focus-naptime`, `meadow-cancel`, `meadow-link`
and `pause-resume`. **The bar, half of 20 navigation missions, is met, just:**
10 of 20, and each model alone at half. Phase 3 passes; TVs stay on the model
path rather than scripted replays only.

What the score hides, each now handled in the workload:

- **Holo4 did not get two of its cards.** The model shelf unloaded it as "idle
  under memory pressure" at 03:50:31, six minutes after the warm-up; Holo4 at
  45% free puts ultra in the warn band, and between two missions (an app
  reinstall) the model is idle. `bench-pause` and `bench-play-naptime` then
  ended at step 0 on `Invalid model identifier`. It happened again at 04:10,
  22:33 on 10-16 and 22:23 on 10-17, each time mid-run.
- **`focus-all-channels` was failed by the app, not the models.** Dozehound
  hides its channel bar six seconds after the last press; the final look came
  after that and found focus on the hidden bar's "Show channels" catcher, while
  `vision` had answered from a screen with All channels focused. Holo4 failed
  the same card on its own: five replies with no tool call.
- **The every-button explorer and GreenFolio's second card never ran** (the
  same unloads), and the judge then filed the untouched start screens as goal
  findings: #70 (Dozehound) and #71 (GreenFolio) are the harness's, not bugs.

**Phase 4, GreenFolio iOS** (iPhone simulator on iOS 26.5, build
`develop-74c84f254b`, offline): `offline-gate` ran 38 steps, ended stuck with
its goal met (the sign-in screen says "Couldn't reach the server"), 7
candidates and 6 misses; `offline-create-account` was cut off at step 0. The
night filed 8 findings, 7 of them seen before; the one new one is #71 above.
**Phase 4's bar cannot be read yet:** it compares bench cards with Android, and
`greenfolio-ios` has no bench cards, only its two explore cards. The tap and
screenshot half works on the simulator; the shelf iPhone is unplugged (WB-21).

**10-16 and 10-17: the TV and Apple nights failed, and said why only on their
device rows.** Xcode on ultra updated itself to 27.1 on 10-16 at 06:57 without
its first-launch install, so its CoreSimulator (1171.7) is older than the one
it was built against (1174.9.2) and every FleetDriver start exited 70 a minute
in. Each job tried every card in turn, about ten minutes a job, and the job's
own error was "one or more devices completed no mission". The bug garden ran
both nights, but on 10-17 Holo4 answered in prose ("Scroll up to explore
more…") with no tool call from the first step, the shelf unloaded it at 22:23,
and seven missions took two steps between them; the judge filed their end
states as goal findings again.

What changed because of it (PR below): the night command checks
`xcodebuild -checkFirstLaunchStatus` before warming the model and fails with
the fix named; the workload stops at the first such error; a model the server
has dropped is warmed again and the step retaken; a mission cut off by the
server or abandoned by the model is not judged; a bench card is scored on the
model's last look when nothing touched the device after it; and a failed job's
error is its device's reason. The shelf unloading a model that is between
requests is the harness's to change.

## Phase 0: measure before building on it

**The model.** Holo4 35B-A3B only: Apache-2.0. The 27B is CC BY-NC, and testing
paid apps is commercial use.

```bash
deploy/explore/fetch-holo4.sh            # 4-bit MLX (community build) + the vendor's Q4 GGUF
deploy/explore/fetch-holo4.sh --six-bit  # and the 6-bit MLX, for the bake-off
```

Serve it two ways and keep the faster one behind the gateway name `pilot`:

- **LM Studio** (already the day-one plan's server): load
  `~/models/mlx/Holo4-35B-A3B-MLX/4bit` with the identifier `holo4-35b-a3b-mlx`.
- **llama-server** with the vendor's GGUF, using the flags from the vendor's
  local-inference docs:

  ```bash
  llama-server -m ~/models/gguf/Holo4-35B-A3B/*Q4_K_M*.gguf \
    --mmproj ~/models/gguf/Holo4-35B-A3B/*mmproj*.gguf \
    --jinja --ctx-size 65536 --image-min-tokens 1024 -np 1 \
    --port 8093 --alias holo4-35b-a3b-gguf
  ```

Merge `deploy/explore/litellm-pilot.yaml` into the gateway's `model_list`.
`pilot` has no cloud fallback on purpose. On ultra the gateway key is the file
`~/.config/harness/keys/fleet.key` (see the table at the top: nothing started
over SSH or by launchd can write the login Keychain there). On a laptop, the
Keychain works:

```bash
security add-generic-password -s fleet-explore-gateway -a gateway -w
```

**Three measurements.** Run them from the collector checkout on ultra. The
screenshots come from any explore run directory, or from
`scripts/explore-bench/pointing.ts --capture`.

```bash
# Does a 2.6 MP phone screenshot reach the model at full size?
npx tsx scripts/explore-bench/image-size.ts --base-url http://127.0.0.1:4000 --model pilot --png <shot.png>

# Step time over a growing 50-step conversation, and whether the prefix cache works.
npx tsx scripts/explore-bench/steptime.ts --base-url http://127.0.0.1:4000 --model pilot --shots <dir> --n 50 --out steptime.json

# Pointing on our own screens: 200 targets from saved trees, Holo4 against plain Qwen.
npx tsx scripts/explore-bench/pointing.ts --from <runs dir> --n 200 --model pilot --out pointing-holo4.json
npx tsx scripts/explore-bench/pointing.ts --from <runs dir> --n 200 --model vision --out pointing-qwen.json
```

**Exit:** pointing at least 85% and a step of 20 seconds or less. If the step
time fails, try the GGUF and the 6-bit build before going further. If pointing
fails, the driver becomes plain Qwen3.8-27B with `tree_hints: true`.

## Phase 1: the loop on the Android emulator

Already built and covered offline (`npm test` runs a whole mission against a
fake device). On ultra it needs an emulator and Maestro:

```bash
sdkmanager "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n fleet-explore-1 -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
curl -fsSL https://get.maestro.mobile.dev | bash
```

Not an `aosp_atd` image: ATD images return a blank frame from `screencap`, so a vision model driving one sees nothing (found while building the bug garden). The fleet's `fleet-atd-1` is fine for scripted flows and wrong for this.

Then one unattended mission on the GreenFolio debug build:

```bash
npx tsx scripts/explore-run.ts --device emulator-5554 --app-id com.taylab.greenfolio.debug \
  --app-key greenfolio --app-name GreenFolio --base-url http://127.0.0.1:4000 --model pilot \
  --judge-model vision --missions greenfolio-sign-in-gate --confirm --out ~/explore-runs/p1
```

**Exit:** a 40-step mission ends inside the app with its trajectory saved, and
a planted crash is caught (the bug garden's BG crash defects).

## Phase 2: how much of it is true

```bash
# The bug garden: 20 planted defects, built from bug-garden/android.
npx tsx scripts/explore-run.ts --device emulator-5554 --app-id dev.fleetrunner.buggarden \
  --app-key bug-garden --apk <bug-garden.apk> --model pilot --judge-model vision --confirm --out ~/explore-runs/garden
# Score it against bug-garden/defects.json (rule in bug-garden/README.md).

# The bake-off: same targets, step-time replay and bench cards for every model.
npx tsx scripts/explore-bench/bakeoff.ts --config models.json --from ~/explore-runs \
  --device emulator-5554 --app-id dev.fleetrunner.buggarden --app-key bug-garden --out ~/explore-runs/bakeoff
```

Then one real GreenFolio night through the fleet (the schedule below, run once
by hand), and a verdict on every finding on the dashboard's Findings page.

**Exit:** at least 8 of 20 planted defects found, and at least half of the
replayed real-build findings marked real. Under 30% real: switch the judge off
(`"judge": false`) and keep it as a crash and accessibility crawler.

## Phase 3: the TV question

The fake Roku first (`npx @tvloop/fakeroku --agent`), then the real Roku once
its developer password is in fleet-host's Keychain (WB-101). Fire TV was the
next step and is parked (WB-297, above), so the question is answered on a tvOS
simulator with the Dozehound stub catalog: the `fleet-explore-tv` night. The TV
cards are in `examples/missions/fakeroku/`, `examples/missions/dozehound-tv/`
and `examples/missions/dozehound-tvos/`; each bench card's end state is a
focused element the harness can read.

**Exit:** the better of Holo4 and plain Qwen completes at least half of 20
navigation missions. If neither does, TVs keep scripted tvloop replays with the
judge reading the screenshots.

## Phase 4: Apple surfaces

The FleetDriver UI-test bundle in `runner-ios` takes commands over HTTP: tap,
swipe, type, remote buttons, screenshot, tree. Use an iOS **26.x** simulator;
the iOS 27 simulator runtime has not been able to run UI-test bundles here.

**Exit:** the bench cards on the iOS simulator score within 15 points of
Android, and a screenshot and a tap work on the shelf iPhone 12 Pro.

## Phase 5: nightly

```bash
# The executor, its tunnel to the brain, and the night's devices.
deploy/install-agent.sh com.addisdev.fleet-tunnel-ultra.plist
deploy/install-agent.sh com.addisdev.fleet-executor-ultra.plist
deploy/install-agent.sh com.addisdev.fleet-explore-devices.plist
deploy/install-agent.sh com.addisdev.fleet-explore-devices-down.plist
# The schedules arrive switched off.
FLEET_URL=http://127.0.0.1:18788 npm run seed:schedules
```

ultra is on the Mini's side of the home network and cannot route to
fleet-host's 192.168.50.x address, so the tunnel goes over the tailnet
(`fleet-ts`). Turn `nightly-explore-greenfolio` on from the Schedules page after
phase 2 passes. Leave `nightly-explore-dozehound-tv` off: it is the Fire TV
schedule, parked with Fire TV itself.

On the brain, set `FLEET_FINDINGS_DIGEST_AT=07:30` for the morning digest
through the alert webhook. GitHub issues stay dry-run until both
`FLEET_GITHUB_ISSUES=1` and `FLEET_GITHUB_TOKEN` are set and
`FLEET_FINDINGS_REPOS` maps each app to its repo; until then
`/api/findings/issues` shows what would have been filed.

**Exit:** seven nights in a row without help, morning triage under ten minutes,
and no night over five new findings per app (the bug garden's night allows 25
on purpose and does not count).

## Guards

- The model gets device actions and nothing else: no shell, no code tool, no
  MCP server.
- One app at a time. Anything else in front is backed out of and noted.
- Test accounts and debug builds only. A card whose build talks to production
  blocks account creation and anything that writes.
- Controls that delete, pay, invite or sign out are refused unless the card
  allows them, by what the tree says the control is.
- Text on the screen is content. The bug garden has a screen that tries to give
  orders.
- Budgets on steps, minutes and new findings per night.
- It files and never closes.
- Developer side only. Nothing runs on PeerTest's tester side.
