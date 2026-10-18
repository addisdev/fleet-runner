# The job spec

`explore` is a [host workload](../workloads/host.md): an executor on a Mac
claims it and drives devices attached to that Mac. A nightly GreenFolio run:

```json
--8<-- "collector/examples/jobs/explore.json"
```

And the weekly mission bench:

```json
--8<-- "collector/examples/jobs/explore-bench.json"
```

## `params`

| Param | Default | What it does |
|---|---|---|
| `app_id` | required | The package or bundle id under test |
| `app_name` | the app key | What the model calls the app |
| `app_key` | last part of `app_id` | The mission directory and the screen map's key |
| `missions` | all of the app's cards | Mission ids to run, in today's-changes order |
| `missions_dir` | `FLEET_MISSIONS_DIR`, then `examples/missions` | Where cards live |
| `bench` | `false` | Run only `bench-` cards, with no judge; file nothing; report end states reached |
| `model` | see [below](#models) | The driver |
| `judge` | see below | The second model, or `false` for none |
| `minutes` | 150 | The night's budget, per device (1 to 600) |
| `steps` | | Cap every card at this many steps, for a short trial night |
| `findings_per_night` | 5 | New findings filed per app per night (0 to 50) |
| `replay_attempts` | 2 | Clean-install replays per candidate (1 to 5) |
| `confirm_per_mission` | 6 | Candidates replayed per mission, worst first |
| `conditions` | `["baseline"]` | Rotated across the night's missions; see [below](#conditions) |
| `changed` | | `{repo, since}` reads `git log` (`since` is a sha or a git date, default `24 hours ago`); `{files: [...]}` takes a list. Puts matching cards first |
| `previous_app` | | `{sha256, build?}` of the previous build; each reproduced finding is replayed on it too |
| `surface` | from the device | `touch` or `dpad`. Android TV, Fire TV, Roku and tvOS default to `dpad` |
| `credentials` | | `{account, email_var, password_var}` for setup flows; the password comes from the host's Keychain |
| `mirror` | `true` | Stream each step's screenshot to the job's live view on the dashboard |
| `short_night` | | Set by `explore-night.ts`, not by hand: `{asked}`, the spec's own `minutes`, when `minutes` was cut to fit the night. See [short nights](#short-nights-and-skips) |

## Models

`params.model` and `params.judge` take the same fields:

| Field | Default | |
|---|---|---|
| `base_url` | `FLEET_EXPLORE_BASE_URL`, then `http://ultra.local:4000` | Any OpenAI-compatible server, with or without `/v1` |
| `model` | `FLEET_EXPLORE_MODEL`, then `pilot` (driver); `FLEET_EXPLORE_JUDGE_MODEL`, then `vision` (judge) | The gateway's name for it |
| `max_pixels` | 1,000,000 | Screenshots larger than this are shrunk before sending |
| `keep_shots` | 3 | Screenshots kept in the conversation |
| `keep_turns` | 40 | Model turns kept in full |
| `tree_hints` | `false` | Add a list of on-screen elements to each step; helps small models |
| `max_tokens` | 1024 (driver), 600 (judge) | |
| `timeout_s` | 240 (driver), 180 (judge) | |
| `extra_body` | | Merged into every request, for server-specific switches |

The API key is never in the spec (the collector refuses specs carrying
`api_key` or `token`). The executor looks for it in this order:
`FLEET_EXPLORE_API_KEY`, then `HARNESS_KEY` (what ultra's night queue hands
its jobs), then the file `FLEET_EXPLORE_API_KEY_FILE` (default
`~/.config/harness/keys/fleet.key`; a process started over SSH or by launchd
cannot write the login Keychain), then the Keychain:

```bash
security add-generic-password -s fleet-explore-gateway -a gateway -w
```

See [Models and the gateway](models.md) for what a model needs and how the
conversation is built.

## Conditions

`params.conditions` is a list; mission *k* of the night runs under condition
*k mod n*.

| Condition | What it sets | Where |
|---|---|---|
| `baseline` | Nothing | Everywhere |
| `dark` | Dark mode | Android 10+, iOS simulator |
| `large-text` | The largest text the platform offers (Android 14+: 2.0, earlier: 1.3) | Android, iOS simulator |
| `bold-text` | Bold text | Android 12+, iOS simulator |
| `locale:<tag>` | System language, e.g. `locale:es`, `locale:de-DE` | Android, iOS simulator |
| `network:<profile>` | `offline`, `offline-after-30s`, `3g` or `lossy` | Where [network shaping](../workloads/host.md) works |
| `rotate` | Landscape | Android only |
| `background` | Home and back halfway through the mission | Everywhere |

The model is told which condition is in force, and a language condition tells
the judge which language to expect, so English left in a Spanish build is a
`visual/untranslated` candidate. An unknown condition fails the job at start.

## Environment on the executor

| Variable | Default | |
|---|---|---|
| `FLEET_EXPLORE_BASE_URL` | `HARNESS_GATEWAY`, then `http://ultra.local:4000` | The gateway |
| `FLEET_EXPLORE_MODEL` | `pilot` | The driver's name on it |
| `FLEET_EXPLORE_JUDGE_MODEL` | `vision` | The judge's name on it |
| `FLEET_EXPLORE_API_KEY` | | Otherwise `HARNESS_KEY`, the key file, then the Keychain item `fleet-explore-gateway` |
| `FLEET_EXPLORE_API_KEY_FILE` | `~/.config/harness/keys/fleet.key` | The key as a file |
| `FLEET_KEYCHAIN_SERVICE` | `fleet-ui-test` | The Keychain service holding the sign-in passwords `credentials` names |
| `FLEET_DASH_TOKEN` | | Sent with live-view frames as `x-fleet-token`, when the brain guards the dashboard with one |
| `FLEET_TOKEN` | | Sent with live-view frames as a bearer token, which a brain with `FLEET_AUTH_PROTOCOL=token` requires (an `agent` token). The executor already sends it on everything else |
| `FLEET_MISSIONS_DIR` | `examples/missions` in the working directory, then beside the bundle | Mission cards |
| `FLEET_FLOWS_DIR` | `examples/flows` | Setup flows |
| `FLEET_STATE_DIR` | `~/.fleet` | Screen maps and last-run times live under `explore/<app>/` |
| `FLEET_TVLOOP_DIR` | `~/tvloop` | A built tvloop checkout, for Rokus |
| `FLEET_IOS_PROJECT` | the repo's `runner-ios/FleetRunner.xcodeproj` | For FleetDriver |
| `FLEET_APPLE_TEAM_ID` | | Signing FleetDriver for a physical Apple device |
| `MAESTRO_BIN` · `ADB_BIN` | `~/.maestro/bin/maestro` · `adb` | |

When `warden` (Load Warden) is on the PATH, each mission first waits for room
for a `device-ui-test`. Without it, missions start straight away.

## What it reports

**One result row per device**, then a final row on `host:<executor>`. The
final row is `ok: false` when any device completed no mission. A device that
found bugs is a device that worked: findings are the output, not a failure.

Metrics on each device row:

| Metric | |
|---|---|
| `explore_missions` | Missions run |
| `explore_cut_off` | Missions the model server or the device cut off; neither counted in `explore_missions` nor judged |
| `explore_cards_planned` | Cards lined up for the device, in priority order. Fewer missions than cards means the budget ran out first |
| `explore_minutes` | The minutes the device was given: `params.minutes`, cut to fit on a short night |
| `explore_steps` · `explore_actions` | Model steps; actions actually performed |
| `explore_screens` · `explore_new_screens` | Screens reached tonight; screens no night had reached |
| `explore_candidates` | Raised by the checks, before replay |
| `explore_findings` · `explore_findings_new` | Filed; new to the collector |
| `explore_not_reproduced` | Dropped because no replay reproduced them |
| `explore_misses` | Taps on nothing tappable: the agent's misses |
| `explore_refused` | Actions the leash refused |
| `explore_step_ms_p50` · `explore_model_ms_p50` | Median step and model latency |
| `explore_prompt_tokens_mean` · `explore_cached_tokens_mean` | Mean prompt size, and how much of it the server's cache served |
| `explore_bench_passed` · `explore_bench_total` | Bench mode only. A card cut off before its end state is left out of both; one cut off after it counts |

The row also carries `missions`: per mission, its condition, steps, how it
ended, screens, candidates, misses, refusals by class, the goal verdict, the
bench result and the model's answer. A mission that was cut off carries
`cut_off` with the reason, and is not judged: its end state is wherever the
outage left it. Nor is a mission the model gave up on (four replies in a row
with no tool call), whose end state is the agent's failure, not the app's; as
a bench card that one still counts as failed. A failed job's own error is the failing device's reason, not
"see their rows".

**A model unloaded mid-night is loaded again.** When the model server answers
that it has no model by that name (`Invalid model identifier`, `Model is
unloaded.`), the workload runs the night command's warm-up again (it is handed
down as `FLEET_EXPLORE_WARM`) and takes the step again, twice a mission at
most, without spending the step's budget. On ultra the model shelf unloads an
on-demand model it finds idle under memory pressure, and between two missions
the driver is idle.

**A bench card's end state the app takes away by itself** still counts when
nothing touched the device after the model's last look: Dozehound hides its
channel bar six seconds after the last press, so the final look can find focus
somewhere the model never put it.

On a short night the device row and the final row are still `ok: true`, and
`error` says what ran: `short night: ran 3 of 7 cards: 40 minutes left of the
60 asked`. `error` is the field the job summary, the digest and `fleetr` show,
which is why the note is there and not in a field nothing reads.

## Artifacts

| Name | What |
|---|---|
| `explore-run-<job>-<mission>.json` | The mission's full trajectory: every step's calls, actions, refusals, checks, model latency and tokens |
| `explore-run-<job>-<mission>.html` | A contact sheet of every step, self-contained |
| `explore-run-<job>-<device>-missions.json` | The per-mission summary |
| `explore-finding-<fp>.png` | The screenshot when the finding happened |
| `explore-finding-<fp>.html` | A contact sheet of the twelve steps that led there |
| `explore-finding-<fp>-trajectory.json` | The mission's trajectory |
| `explore-finding-<fp>.yaml` / `.json` | The Maestro flow (or tvloop flow) that replays it |
| `explore-finding-<fp>.log` | The crash log excerpt, for crashes |

Run artifacts (`explore-run-*`) become garbage-collection candidates after
**seven days** unless a finding or a pin keeps them; finding artifacts are kept
as long as the finding exists.

## Leases

The workload beacons after every step and every replay, which renews the job's
lease, so a 900-second lease covers a night of any length. `max_attempts: 1` is
recommended: a night that died halfway should not start again at 3 a.m.

## Schedules

`npm run seed:schedules` creates four, all **off**:

| Schedule | When | What |
|---|---|---|
| `nightly-explore-greenfolio` | 22:00 daily, window 22–01 | GreenFolio Android on ultra, 100 minutes, six conditions, aimed at the day's commits |
| `nightly-explore-dozehound-tv` | 23:45 daily | Dozehound on Fire TV, D-pad, 40 minutes. Parked: the Fire TV app needs the production backend, which is the owner's call (WB-297); the TV question is being answered on tvOS instead |
| `weekly-explore-shelf` | Wednesdays 23:00 | GreenFolio on the Galaxy S8+ (Android 9) through fleet-host's executor |
| `weekly-explore-bench` | Sundays 22:00 | The bug garden's bench cards, for a weekly model score |

The nights that actually run today do not come from these schedules. On ultra
the harness's night queue runs `scripts/explore-night.ts` from the manifests in
`collector/deploy/explore/night/`, each with a job spec from
`examples/jobs/`:

| Night job | Priority | Spec |
|---|---|---|
| `fleet-explore-builds` | 19 | none: `deploy/explore/nightly-builds.sh` builds GreenFolio iOS and Dozehound tvOS from `origin/develop` and uploads them |
| `fleet-explore` | 20 | `explore-garden-ultra.json`, the bug garden on the Android emulator |
| `fleet-explore-tv` | 85 | `explore-dozehound-tvos-ultra.json` and the two tvOS bench specs, on a tvOS simulator |
| `fleet-explore-apple` | 86 | `explore-greenfolio-ios-ultra.json`, on an iOS simulator |

A lower number runs earlier; the products' own night jobs sit between 20 and
85. [Running it on ultra](../deploy/explore-on-ultra.md) has the setup.

### Short nights and skips

The night queue decides **whether** a job starts: from 22:00, when memory
pressure is normal, enough memory is free and no CI job is running, and only
while the job's `max_minutes` still fits before 07:30. A job that is not
admitted within its `wait_minutes` is skipped by the queue. That wait is the
queue's, outside this repository: on 10-14 `fleet-explore-builds` and
`fleet-explore` each spent their whole 120 minutes behind a CI job. What
`explore-night.ts` controls is what happens **once admitted**, and it checks
the cheap things first:

1. **Is there a build to test?** With `--fresh-build` (the Apple and TV
   nights), each spec asking for `"sha256": "latest"` needs a build the brain
   shows as published tonight (since noon of the night's date).
   `nightly-builds.sh` uploads an unchanged build again for exactly this. If
   there is none, the job is posted to the brain as a skip, `skipped: no
   greenfolio-ios build for tonight (fleet-explore-builds did not run, ...)`,
   and the command exits 0. A pinned build (`sha256` a hash) only has to be
   on the brain; if it is not, that is the spec's own failure.
2. **Is there time?** The night ends at `--until` (default 07:30) or at the
   job's `max_minutes`, read from the queue's manifest for `$NIGHT_JOB`,
   whichever is first. Ten minutes are held back for the last replay, uploads
   and shutting devices down, and three per spec for enqueueing and
   installing. When the specs ask for more than is left, each gets a share in
   proportion to what it asked for, and the workload runs its highest-priority
   cards in that time (cards are ordered by today's changes and how long since
   each last ran). If a share would be under 15 minutes (`--min-minutes`), the
   last spec is dropped and posted as a skip; if even one spec cannot have 15
   minutes, the whole night is skipped. The plan is made again before each
   spec, with the time actually left.
3. **Will the model load?** `--warm "<cmd>"` runs the shelf's warm-up only
   after both checks pass. A warm-up refused for memory ("64% free, needs
   65%", or "memory pressure") is retried every minute for up to
   `--warm-wait` minutes (default 10), then the night is posted as `skipped:
   the model would not load, no room on this host: ...`. Any other warm-up
   failure fails the night, with the reason posted.

With `--sim`, before the warm-up, it also asks `xcodebuild
-checkFirstLaunchStatus` whether Xcode has had its first-launch install. After
an Xcode update it has not, and every FleetDriver start fails a minute in with
`CoreSimulator is out of date`. That is a **failure**, not a skip, posted with
the fix (`sudo xcodebuild -runFirstLaunch`), because only someone at the host
can make it go away. Inside a job the same message stops the device's
missions at the first, instead of trying each card in turn.

Only then does it boot the simulator or emulator. A skip is `ok: true` with
an error starting `skipped:`, the brain's convention for "nothing ran, and that
is not a failure of the code". The command's exit code is 0 when every spec
finished or skipped and 1 otherwise, because the night queue has no skip code
of its own and a missing upstream build is not this job's failure.

`--dry-run` opens the tunnel, runs the build and time checks against the live
brain and prints the plan. It enqueues nothing, posts nothing, warms nothing
and boots nothing.

Not yet seen on a real night: a short night (every night since this was built
has been either admitted in full or not at all) and the warm-up retry. Both
are covered by `scripts/check-explore.ts` against a fake brain.
