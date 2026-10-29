# The lab

What is in this fleet, which machine runs what, and what to do when something
goes red. The [platforms page](platforms.md) says what *can* join a fleet; this
says what has joined *this* one.

It exists because none of it was written down. Which phone was cabled to which
Mac, which nightly guarded which app, and what to do when one went red lived in
the registry and in somebody's head, and the registry could not answer the first
question at all — two Macs answered to the same executor name for twelve days
and nothing said which of them held the iPhone.

## The machines

| | What it is | Runs | Reached by |
|---|---|---|---|
| **fleet-host** | 2016 MacBook Pro, i7-6820HQ, 16 GB, **macOS 12.7.6**, Node 22.23.2 | A machine agent and the `fleet-host` executor — one `fleet` service, two components, pointed at the brain on ultra (`http://192.168.1.111:8789`). The executor does Android host work, the web nightlies in the installed Google Chrome, and tvloop's Roku suite. It owns the Rokus on its network (`FLEET_ROKU=1`). Until 2026-10-21 it was also the brain; its `~/fleet-collector` is kept as a cold copy | `ssh fleet-host` |
| **runner-host** | MacBook Pro (Mac14,10), macOS 26.7, Xcode 27 | **Nothing of Fleet Runner's, since 2026-09-22.** It runs the GitHub Actions runner farm, which is its own project | `ssh runner-host` |
| **the dev MacBook** | M1 Pro, 16 GB, macOS 27, Xcode 27 | A machine agent and the `mac-dev` executor in pool `personal`, plus the SSH tunnel and the alert receiver. Its executor refuses heavy work above load 50 or under 2 GB of free swap (`FLEET_MAX_LOAD`, `FLEET_MIN_FREE_SWAP_MB`) | it is the machine you are on |
| **the mini** | Mac mini M4, macOS 15.6.1, up 224 days | Nothing fleet-related | `ssh mini`, over the tailnet |
| **ultra** | Mac Studio, M5 Ultra, 96 GB, macOS 27 | **The brain** (since 2026-10-21): `fleet up` with role `brain` on `127.0.0.1:8789`, data in `~/fleet-brain`, and a forwarder that puts it on the LAN at `192.168.1.111:8789`. Also the exploratory QA nights: the `ultra` executor, its Android emulator and Apple simulators, and the model gateway they call. Its night queue runs them, not the brain's schedules; [Running it on ultra](deploy/explore-on-ultra.md) is its runbook. Since 2026-10-28 also the **`ultra-phone`** executor and two phones on its USB (below) | `ssh ultra` (`ultra-ts` away), `http://192.168.1.111:8789` from the house |

**Why the brain moved to ultra (2026-10-21).** It was on fleet-host because
that Mac is on the shelf's subnet and is macOS 12, which has no local-network
gate. But ultra is on the other side of the house's one-way router
(`192.168.1.x`; the shelf is `192.168.50.x`, which reaches ultra and not the
reverse), so ultra's night jobs and the away-from-home route both had to hop
through a third Mac, and that Mac was retired from personal work. A brain
only ever *answers*, so it belongs on the side everyone can reach: the shelf,
fleet-host and the laptop all reach ultra; ultra reaches nobody on `.50`.

Two things make it work, and both are traps:

- **The brain listens on loopback and a system-Python forwarder carries the
  LAN.** ultra's firewall is in stealth mode and drops LAN connections to a
  Homebrew `node`, although `socketfilterfw` reports that path as permitted;
  `/usr/bin/python3` gets through (the Homelab Map's page server on ultra
  relies on the same thing). `com.addisdev.fleet-lan-forward` runs
  [`collector/deploy/lan-forward.py`](https://github.com/addisdev/fleet-runner/blob/develop/collector/deploy/lan-forward.py),
  a byte pipe from `192.168.1.111:8789` to `127.0.0.1:8789`. A side effect:
  every LAN client registers from `127.0.0.0/24`, so `last_net` no longer
  tells the house from loopback on this brain.
- **Port 8789, not 8788.** ultra's `127.0.0.1:8788` belongs to another project.
  Everyone else keeps their own port: the laptop still reaches the brain at
  `127.0.0.1:18788` through its tunnel.

Executors stay where the devices are cabled: fleet-host keeps the Roku and the
Chrome nightlies, and reaches the brain over the LAN (macOS 12 has no
local-network gate, so its launchd service can).

### ultra's phones and the `ultra-phone` executor (2026-10-28)

Both shelf phones moved to ultra's USB on 2026-10-28, each **reserved**:

| Phone | Serial | Reservation | Used by |
|---|---|---|---|
| Galaxy S9 (SM-G960U1) | `444f4b3854573398` | `growth-instagram` | Taylab Social's growth phone (GreenFolio's accounts; `addisdev/taylab-social` `phone/`). Nothing else may touch it |
| Galaxy S8+ (SM-G955U1, Android 9) | `988a1b3541354f565a` | `nightly-phone` | `nightly-fleet-ui-smoke` and `nightly-bug-garden-regressions`, moved here from fleet-host (their flows copied to ultra `~/fleet-flows/{fleetrunner,bug-garden}`) |

**The phones swapped roles on 2026-10-29.** The S9 was factory reset by mistake, so it became the growth phone
(a clean device is what growth needs) and the S8+ took the nightlies (it already carries the Fleet Runner and
bug-garden apps). Reservations and both schedules' `targets.match` were changed on the brain; backups in ultra
`~/fleet-backups/*-pre-swap-20261029135311.json`. The S8+ still has a lock-screen PIN: until it is removed the
executor reports both nightlies `skipped` (a PIN cannot be swiped away).

They are driven by a second Fleet process on ultra, the **`ultra-phone`**
executor, beside the brain and never inside it:

- LaunchAgent `com.addisdev.fleet-phone` (hand-written: `fleet service install`
  has one fixed label, `com.addisdev.fleet`, which the brain uses), running
  `fleet.mjs up --role executor` with `FLEET_HOME=~/.fleet-phone`, so its
  name and config never mix with the brain's. Config
  `~/.fleet-phone/config.json`: `executor.name ultra-phone`, collector
  `http://127.0.0.1:8789`, `env.FLEET_FLOWS_DIR ~/fleet-flows`. Logs
  `~/.fleet-phone/logs/`.
- Its PATH and `JAVA_HOME` are in the plist: platform-tools
  (`~/Library/Android/sdk/platform-tools`), Homebrew `openjdk@21` (keg-only,
  so not on any default path), `~/.maestro/bin` (Maestro 2.8.0).
- It loads every driver (adb, simctl, devicectl, roku) and there is no setting
  to limit them. That is safe only because every ultra explore spec pins
  `targets.executor: ultra` and both phones are reserved; a new unpinned job
  could land on it.
- Proof 2026-10-28: `s9-proof-ui-smoke-214023` passed on the S9 in 60 s through
  `ultra-phone`, and the executor logged "leaving out 1 reserved device(s):
  988a1b3541354f565a (reserved for growth-instagram)".

Restart it with `launchctl kickstart -k gui/$(id -u)/com.addisdev.fleet-phone`;
disable it by renaming the plist to `.plist.disabled` (see below).

**Do not run `fleet up --help` on a machine whose brain is running.** `up`
ignores `--help` and starts a second brain, which crash-loops on the taken port
five times and gives up. Harmless, but it looks alarming in `brain.log`; read
the options in `fleet/src/cli.ts` instead.

**Why runner-host was taken off the fleet.** It is the only Mac here with a
current Xcode, and it was running every iOS and web nightly — alongside forty
GitHub Actions runners. On 2026-09-22 its load average was 52 on twelve cores,
Spotlight was indexing the runners' build directories, and on 2026-09-20 it had
gone to sleep on a *thermal emergency*. The `greenfolio-ios` nightly hung for 55
minutes three nights running there. Its `com.addisdev.fleet-watch`,
`fleet-autofix` and `fleet-dashboard` jobs belong to the runner farm, **not** to
Fleet Runner, despite the shared prefix — leave them alone. Fleet Runner's two
jobs there are renamed to `.plist.disabled`.

**The web nightlies run in the installed Chrome.** Playwright 1.62 refuses to
install Chromium or Firefox on macOS 12, so fleet-host drives the Google Chrome
already on it (`FLEET_CHROMIUM_CHANNEL=chrome`), from the Playwright install in
`~/fleet-collector` (`FLEET_PLAYWRIGHT_DIR`). That covers the `chromium` and
`mobile-chrome` projects. Firefox, WebKit and mobile Safari need a Mac on a newer
macOS and currently run nowhere. fleet-host is also Liz's machine — it serves the
Pinterest dashboard on 8787 behind a Cloudflare tunnel — and it is
enterprise-managed (SentinelOne, Jamf, GlobalProtect), which is one more reason
it drives a browser that was already there rather than downloading new ones.

**The mini is not on the fleet.** It is on `192.168.1.x` and the shelf is on
`192.168.50.x`, so the only route is the tailnet, and the brain is not on it.
Putting Tailscale on fleet-host is what unblocks the mini, and with it the
`llm-eval` judge and an MLX backend.

## Every agent on a new macOS talks to the brain through loopback

On macOS 26 and later a LaunchAgent cannot reach a LAN address, so the dev
MacBook's agent, executor, CLI and MCP server all point at
`http://127.0.0.1:18788`, which is an SSH tunnel to ultra's `127.0.0.1:8789`
(`com.addisdev.fleet-tunnel`: the LAN alias `ultra` first, the tailnet alias
`ultra-ts` when away). It is not a preference. Point one at `192.168.1.111`
and it will work from your shell and fail under launchd. ultra's own night
jobs use `127.0.0.1:8789` directly. fleet-host is macOS 12 and uses the LAN
address.

**Runner apps on phones** (the Android and iOS runners in device mode) are
not launchd jobs and use the LAN address: `http://192.168.1.111:8789`, typed
into the app's Collector field. None was connected over Wi-Fi when the brain
moved; a shelf device that comes back with `http://192.168.50.27:8788` saved
needs that field changed.

## What runs where, and the traps in it

### One executor per name, and the name is not the machine

`targets.executor` routes by **name**. Two machines configured with the same
`FLEET_EXECUTOR_NAME` both claim the jobs pinned to it and each runs them on
whatever devices it can see, so a nightly lands on old or new code by coin
flip. The names in use are `fleet-host` and `mac-dev` (the dev MacBook).
`mac-xcode` was runner-host's and is retired; no schedule points at it.

Devices now report `attached_host` beside `attached_to`, so the registry can
tell two Macs apart. Before that, answering "which Mac is this iPhone cabled
to" meant reading two log files.

### `launchctl bootout` does not survive a login

This bit twice. A LaunchAgent with `RunAtLoad` comes back the next time anybody
logs in, so booting one out disables it until the next login and no longer.
**Rename the file** to `.plist.disabled`, which is what the retired agents here
have:

```
com.addisdev.fleet-collector.plist.disabled
com.addisdev.fleet-executor.plist.disabled       (fleet-host)
com.addisdev.fleet-executor-ios.plist.disabled   (the dev MacBook — staging only, never load it)
```

### The service bakes its roles in at install time

`fleet service install` writes the roles into the unit's argv, and a
command-line flag outranks the config file. Changing `roles` in
`~/.fleet/config.json` therefore does nothing until you re-run
`fleet service install`.

### The service PATH comes from the shell that installed it

`fleet service install` writes the unit's `PATH` from the environment of the
shell that ran it. On fleet-host `adb` lives at `~/.local/platform-tools` and is
on no default path, so the service must be installed from a shell that can see
it, or the executor reports no Android targets and says nothing about why.

```bash
export PATH="$HOME/.fleet/bin:$HOME/.local/platform-tools:$HOME/.local/jdk/Contents/Home/bin:$HOME/.maestro/bin:$PATH"
fleet service install
```

## The Roku, lent to tvloop

tvloop has its own hardware nightly (`.github/workflows/hardware.yml`), aimed at
a self-hosted runner labelled `tvloop-lab` that no machine carries. Rather than
make fleet-host an Actions runner, the fleet runs the same steps as the
`tvloop` workload: **tvloop drives, the fleet lends.** The fleet locks the Roku
(a Roku holds exactly one dev channel, so two things sideloading at once is a
corrupted run), hands tvloop its address and password, and files what came
back.

| | |
|---|---|
| The device | Roku Express 4K+ at `192.168.50.218`, Roku OS 15.3.4, developer mode on. Registered as `roku-<serial>` by fleet-host. An executor older than 0.9 registers it as `platform: android` and leaves an offline `roku-ip-192-168-50-218` beside it; from 0.9 it says `roku`, and the serial-named row retires the IP-named one |
| The checkout | `~/tvloop` on fleet-host, **synced from the dev MacBook**, not cloned: the repo is private and fleet-host has no GitHub credential. Re-sync with `rsync -a --delete --exclude node_modules --exclude 'packages/*/dist' --exclude tvloop.toml <tvloop>/ fleet-host:tvloop/`, then `corepack pnpm install --frozen-lockfile && corepack pnpm build` there |
| `~/tvloop/tvloop.toml` | Not in the repo. Points `[project] source` at `examples/sample-channel`, the channel the flows expect. Keep it out of the rsync |
| The password | Keychain item `fleet-roku-dev` / account `rokudev` on fleet-host, the same one the dev installer reads. Missing means every run is `skipped:` and says how to add it. On a 0.7 or 0.8 brain those runs show as `done`; from 0.9 they are `skipped`, and three in a row raise a `schedule-skipping` alert |
| The steps | `doctor`, `install` (sideloads the sample channel, **replacing whatever is in the dev slot**), `hardware`, `replay`. A failed doctor or install stops the run |

## Real phones from CI

`taylab-launch-kit`'s `android-ci` has an opt-in lane (v1.14.1): the build job
uploads its debug APK here, queues a `ui-test` pinned to that exact build, and
the brain posts a **`fleet-runner`** commit status when it finishes. Nothing in
CI waits for it and nothing there can go red because of it. greenfolio-android
is the first caller.

Three things have to be true for a status to appear:

- **The runner reaches the brain** as `http://fleet-host:8788`, over the tailnet.
  Farm runners are LaunchAgents on macOS 26 and cannot reach a LAN address.
  That address has been dead since the brain moved to ultra on 2026-10-21, and
  the lane has not been repointed: Fleet Runner stays disconnected from CI
  until the owner says otherwise.
- **A matching phone is attached to fleet-host.** Otherwise the job is a
  `skipped:` result, and a skip posts no status on purpose — a green check where
  nothing ran would be worse than none.
- **fleet-host has a status token:** `env.FLEET_GITHUB_STATUS 1` and
  `env.FLEET_GITHUB_TOKEN` (fine-grained, commit statuses: write, on the repos
  that opt in).

## For a coding agent

`fleet mcp` serves the lab as MCP tools; register it once with
`claude mcp add --scope user fleet -- ~/.fleet/bin/fleet mcp`. From the dev
MacBook it reaches the brain through the tunnel, the same as the agent does.
A result whose error starts with `skipped:` means nothing ran, and from 0.9
the job's status says so: `skipped`, not `done`.

From 0.8.0 there is also `fleetr`, whose exit code is the verdict, and a skill
(`fleet skill install`) that tells an agent which commands to run in what
order, both installed on the dev MacBook (`fleet skill install --target
claude`). [AI agents and automation](agents.md) has both, and from 0.9 the
findings commands (`fleetr findings`, `fleet_findings`) that a morning agent
session can start from.

## The suites are not in git

`~/fleet-collector/flows/` and `~/fleet-collector/web-specs/` on fleet-host hold
every Maestro flow and Playwright spec this fleet runs. They name the apps under
test, which is why they were never published, and **the only copies were on one
2016 laptop**. Losing them would leave every nightly running and testing nothing.

They are now in the nightly backup. They are still not in git, and a private
repository for them is an open question.

## Backups

| Job | Where | When | What |
|---|---|---|---|
| `com.addisdev.fleet-backup` | ultra | 01:30 | database (`sqlite3 .backup`, integrity checked), config, a manifest; then sealed into ultra's `~/offsite-outbox` as `fleet-brain-<stamp>.tar.age` (`FLEET_BACKUP_OUTBOX`) |
| the off-site pull | fleet-host | 04:30 | the house's existing pull of ultra's outbox carries the sealed bundles to fleet-host, encrypted |
| `com.addisdev.fleet-backup` | fleet-host | 01:30 | **suites only** (`FLEET_BACKUP_NO_DB=1`): flows, web-specs, config. The brain left, but the executor there still runs these, and they are in no repository |
| `com.addisdev.fleet-backup-pull` | the dev MacBook | 03:00 | pulls the newest from ultra (`~/fleet-backups/ultra`) and from fleet-host (`~/fleet-backups/fleet-host`), and re-checks that a database opens |

Fourteen kept on each side. Scripts are
[`collector/deploy/backup-brain.sh`](https://github.com/addisdev/fleet-runner/blob/main/collector/deploy/backup-brain.sh)
and
[`pull-brain-backups.sh`](https://github.com/addisdev/fleet-runner/blob/main/collector/deploy/pull-brain-backups.sh).

Artifacts are **not** backed up: content-addressed, most of a gigabyte, and
everything worth keeping is referenced by a result row the backup does carry.

The backup runs half an hour *before* the nightlies rather than after them, so
the copy is the last known-good state rather than the freshest one.

## The schedules

Six enabled. All times local to the brain (ultra, America/New_York; fleet-host was the same zone).

| | When | Runs on | What red means |
|---|---|---|---|
| `nightly-synthetic-shelf` | 02:00 | fanout, pool `machines` | A machine's throughput moved, or an agent is not claiming. This is the comparison table |
| `nightly-self-check` | 02:15 | fanout, pool `machines` | Disk, clock drift, a tool that vanished, or the agent is not supervised |
| `nightly-fleet-ui-smoke` | 02:30 | `ultra-phone`, the S8+ (`nightly-phone`) since 2026-10-29 (the S9 on 10-28, fleet-host before) | **Red since 2026-08-21.** From 09-16 to early October it was `no targets attached`. The S8+ then had a PIN (WB-195). Green again 2026-10-28 on the S9 (`s9-proof-ui-smoke-214023`, 60 s). From 0.9.1 the executor wakes a phone and swipes its lock screen away, and a PIN makes the run `skipped` with that reason instead |
| `nightly-bug-garden-regressions` | 02:45 | `ultra-phone`, the S8+ (`nightly-phone`) since 2026-10-29 (the S9 on 10-28, fleet-host before) | Bug garden's smoke flow, then every bug-garden finding marked real and then fixed, replayed as a regression test. The garden's defects are planted, so finding #18 (BG-01, marked fixed on purpose) comes back every night and reopens: that is the run working. Runs on the S9 since 2026-10-28. Proved once on ultra's emulator on 2026-10-18 (`bg-regression-proof-1`) |
| `nightly-aliquant-shots` | 04:15 | `fleet-host`, `chromium` and `mobile-chrome` | Green. The baseline was re-accepted on 2026-09-22 from fleet-host's own captures, after Aliquant's sign-in page gained a "Forgot password?" link; the old one had diverged 2.7% on desktop and 6.1% on mobile since 09-10. The `webkit` and `mobile-safari` baselines are still the August ones, because nothing runs those projects now |
| `nightly-tvloop-hardware` | 05:00 | `fleet-host`, the Roku, exclusive | tvloop's doctor, install, contract tests and flow replay. `skipped:` until the Roku password is in fleet-host's Keychain (status `skipped` from 0.9). Red from doctor means the Roku is asleep, off the network, or out of developer mode |

**`nightly-aliquant-web` and `nightly-aliquant-audit` are retired** (disabled
2026-09-29). Aliquant's own CI already runs the same Playwright suite and
audit on every push, so the fleet running them again nightly on a 2016 laptop
added a second place to read the same answer. `nightly-aliquant-shots` stays:
visual baselines are the one thing only the fleet keeps.

**The iOS nightlies are paused**: `nightly-greenfolio-ios`, `nightly-aliquant-ios`
and `nightly-jerv-ios`. fleet-host cannot run them — it has only the Command Line
Tools, and macOS 12 tops out at Xcode 14 — and runner-host is off the fleet.
They come back when a Mac with a current Xcode is dedicated to it.

Nine more are disabled. Four of them carry placeholder values (`SET-ME-numeric-app-id`)
and should be filled in or deleted — a disabled schedule with a placeholder in it
is a lie waiting to be enabled.

**Both fanout schedules are pinned to the `machines` pool on purpose.** A
fanout with no pool reaches every row in the registry, including a phone that
has been unplugged for a month, and mints it a child job every night that sits
queued until it returns. When a phone joins the shelf, give it a pool and add
that pool here.

## When something goes wrong

### The brain is not answering

```bash
ssh ultra
export PATH="/opt/homebrew/opt/node@22/bin:$HOME/.fleet/bin:$PATH"
fleet service status          # names a component that gave up, and exits non-zero
tail -40 ~/.fleet/logs/fleet.log
curl -s localhost:8789/api/health
launchctl list | grep fleet-lan-forward    # the LAN side; its log is ~/.fleet/logs/lan-forward.log
```

Loopback answering while `http://192.168.1.111:8789` times out from the house
is the forwarder, not the brain.

Since 0.6.1 `fleet service status` reads the supervisor's own state, so a
component it has given up on shows as `GAVE UP at … after N restarts` rather
than `running`. `fleet.log` has the restarts that led there.

### Restarting it

There is no `fleet service restart`. The subcommands are
`install|uninstall|start|stop|status|logs`. And `launchctl bootstrap`
immediately after a `bootout` fails with `Bootstrap failed: 5: Input/output
error`, which is a race rather than a permissions problem — `fleet` retries it
now, but by hand:

```bash
launchctl bootout gui/$(id -u)/com.addisdev.fleet
pgrep -f 'fleet\.mjs' | xargs -r kill        # nothing may hold the brain's port (8789 on ultra)
sleep 5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.addisdev.fleet.plist
```

**Check that the collector really went.** When the brain left fleet-host, a
`bootout` stopped the supervisor but left its `fleet.mjs collector` child
running as an orphan, still writing the database, and it ignored `SIGTERM`
for over 40 seconds; it took a `kill -9`. Before copying a database, `lsof`
it.

**Kill fleet processes by PID or by a path-qualified pattern.** On the dev
MacBook `pkill -f "src/server.ts"` also kills an unrelated project, and
`lsof -ti tcp:8788` lists clients as well as the listener — and loopback `8788`
there is an SSH tunnel to the mini, nothing to do with the fleet.

### A device has gone offline

Only **named** devices raise `device-offline`, so a name is how you say "I care
about this one". Everything on the shelf gets one. If a device you care about is
silent and no alert arrived, it probably has no name.

### Restoring from a backup

```bash
ssh ultra
fleet service stop
cd ~/fleet-backups/brain-<stamp>
sqlite3 fleet.db 'pragma integrity_check;'          # before trusting it
cp fleet.db ~/fleet-brain/data/fleet.db
fleet service start
```

The suites restore on fleet-host, from its own backups:
`tar -xzf ~/fleet-backups/brain-<stamp>/flows.tar.gz -C ~/fleet-collector/`.

`MANIFEST.txt` in each backup says which host and which directories it came
from, so a restore does not have to guess.

## What is not done, and who it needs

- **Most of the shelf is unplugged.** The Galaxy S8+ is back on fleet-host;
  no other phone, tablet, TV or stick has been on the fleet since 2026-08-18.
  That needs a powered USB hub and cables.
- **The Roku's developer password is not in fleet-host's Keychain**, so the
  tvloop nightly skips. Developer mode is on.
- **An Apple TV 4K** is paired to the dev MacBook and has never run the tvOS
  target.
- **fleet-host is not on the tailnet**, which blocks the mini joining and blocks
  the CI lane: every greenfolio-android run says the lab is unreachable and
  skips.
- **No commit-status token on fleet-host**, so a CI lane run that does happen
  posts nothing back to the PR.
- **Alerts still go to the dev MacBook's local receiver** over the tunnel's
  reverse forward (ultra's loopback 8790), which fails whenever the tunnel does. An ntfy topic is the
  fix and it needs an account decision.
- **No Mac for iOS, or for Firefox, WebKit and mobile Safari.** Those need a
  current macOS and Xcode, and the only such Mac besides your daily laptop is the
  runner farm. A dedicated Mac — or the mini, once fleet-host is on the tailnet —
  would bring back the three iOS nightlies and the three missing web projects.
