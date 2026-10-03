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
| `minutes` | 150 | The night's budget, per device |
| `steps` | | Cap every card at this many steps, for a short trial night |
| `findings_per_night` | 5 | New findings filed per app per night |
| `replay_attempts` | 2 | Clean-install replays per candidate (1 to 5) |
| `confirm_per_mission` | 6 | Candidates replayed per mission, worst first |
| `conditions` | `["baseline"]` | Rotated across the night's missions; see [below](#conditions) |
| `changed` | | `{repo, since}` reads `git log`; `{files: [...]}` takes a list. Puts matching cards first |
| `previous_app` | | `{sha256}` of the previous build; each reproduced finding is replayed on it too |
| `surface` | from the device | `touch` or `dpad`. Android TV, Fire TV, Roku and tvOS default to `dpad` |
| `credentials` | | `{account, email_var, password_var}` for setup flows; the password comes from the host's Keychain |
| `mirror` | `true` | Stream each step's screenshot to the job's live view on the dashboard |

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
`api_key` or `token`). It comes from the executor's environment
(`FLEET_EXPLORE_API_KEY`) or its Keychain:

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
| `FLEET_EXPLORE_BASE_URL` | `http://ultra.local:4000` | The gateway |
| `FLEET_EXPLORE_MODEL` | `pilot` | The driver's name on it |
| `FLEET_EXPLORE_JUDGE_MODEL` | `vision` | The judge's name on it |
| `FLEET_EXPLORE_API_KEY` | | Otherwise the Keychain item `fleet-explore-gateway` |
| `FLEET_MISSIONS_DIR` | `examples/missions` | Mission cards |
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
| `explore_steps` · `explore_actions` | Model steps; actions actually performed |
| `explore_screens` · `explore_new_screens` | Screens reached tonight; screens no night had reached |
| `explore_candidates` | Raised by the checks, before replay |
| `explore_findings` · `explore_findings_new` | Filed; new to the collector |
| `explore_not_reproduced` | Dropped because no replay reproduced them |
| `explore_misses` | Taps on nothing tappable: the agent's misses |
| `explore_refused` | Actions the leash refused |
| `explore_step_ms_p50` · `explore_model_ms_p50` | Median step and model latency |
| `explore_prompt_tokens_mean` · `explore_cached_tokens_mean` | Mean prompt size, and how much of it the server's cache served |
| `explore_bench_passed` · `explore_bench_total` | Bench mode only |

The row also carries `missions`: per mission, its condition, steps, how it
ended, screens, candidates, misses, refusals by class, the goal verdict, the
bench result and the model's answer.

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
| `nightly-explore-dozehound-tv` | 23:45 daily | Dozehound on Fire TV, D-pad, 40 minutes. Leave off until a model passes the TV test |
| `weekly-explore-shelf` | Wednesdays 23:00 | GreenFolio on the Galaxy S8+ (Android 9) through fleet-host's executor |
| `weekly-explore-bench` | Sundays 22:00 | The bug garden's bench cards, for a weekly model score |
