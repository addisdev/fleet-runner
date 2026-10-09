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
| The shelf | `ondemand holo4-35b-a3b@holo4-35b-a3b-gguf 65536 1 3600` in `~/harness/shelf.conf`; `bash ~/harness/shelf.sh warm pilot` loads it when at least 65% of memory is free |
| The key | `~/.config/harness/keys/fleet.key` (roles `pilot`, `judge`, `vision`). Not the Keychain: neither SSH nor a LaunchDaemon can write the login Keychain on ultra. The workload reads `HARNESS_KEY`, then this file |
| The night | `~/night/recurring/fleet-explore.json`, run by the harness's night queue from 22:00 when memory pressure is normal, 35 GB is free and no CI job is running |
| The brain | On fleet-host, which ultra cannot route to. The night command opens `ssh -L 18788:192.168.50.27:8788 runner-ts` for the length of the run |

The night command (`collector/scripts/explore-night.ts`) boots the AVD if
needed, opens the tunnel, enqueues the spec on the brain pinned to the executor
name `ultra`, runs an executor in-process until the job ends, then shuts down
what it started and exits with the job's result, so the night queue knows when
the memory is free again.

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
`pilot` has no cloud fallback on purpose. Then put the gateway key in the
Keychain, where the workload reads it:

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
its developer password is in fleet-host's Keychain, then Fire TV through adb
D-pad keys. The TV cards are in `examples/missions/fakeroku/` and
`examples/missions/dozehound-tv/`; each bench card's end state is a focused
element the harness can read.

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
phase 2 passes; leave `nightly-explore-dozehound-tv` off until phase 3 does.

On the brain, set `FLEET_FINDINGS_DIGEST_AT=07:30` for the morning digest
through the alert webhook. GitHub issues stay dry-run until both
`FLEET_GITHUB_ISSUES=1` and `FLEET_GITHUB_TOKEN` are set and
`FLEET_FINDINGS_REPOS` maps each app to its repo; until then
`/api/findings/issues` shows what would have been filed.

**Exit:** seven nights in a row without help, morning triage under ten minutes,
and no night over five new findings per app.

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
