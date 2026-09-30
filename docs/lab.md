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
| **fleet-host** | 2016 MacBook Pro, i7-6820HQ, 16 GB, **macOS 12.7.6**, Node 22.23.2 | The brain, a machine agent, and the `fleet-host` executor — one `fleet` service, three components. The executor does Android host work, the web nightlies in the installed Google Chrome, and tvloop's Roku suite. It owns the Rokus on its network (`FLEET_ROKU=1`) | `ssh fleet-host`, `http://192.168.50.27:8788` |
| **runner-host** | MacBook Pro (Mac14,10), macOS 26.7, Xcode 27 | **Nothing of Fleet Runner's, since 2026-09-22.** It runs the GitHub Actions runner farm, which is its own project | `ssh runner-host` |
| **the dev MacBook** | M1 Pro, 16 GB, macOS 27, Xcode 27 | A machine agent and the `mac-dev` executor in pool `personal`, plus the SSH tunnel and the alert receiver. Its executor refuses heavy work above load 50 or under 2 GB of free swap (`FLEET_MAX_LOAD`, `FLEET_MIN_FREE_SWAP_MB`) | it is the machine you are on |
| **the mini** | Mac mini M4, macOS 15.6.1, up 224 days | Nothing fleet-related | `ssh mini`, over the tailnet |

**Why the brain is the oldest machine.** It is on the shelf's subnet, and it is
macOS 12, which has no local-network gate. Every other Mac here is macOS 26 or
later, where a launchd job cannot ask for local-network access and gets
`EHOSTUNREACH` that looks exactly like a network fault. See
[networking](deploy/networking.md). The brain being the slowest machine costs
nothing: it schedules, it does not compute.

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

## Every agent talks to the brain through loopback

Except the brain itself. On macOS 26 and later a LaunchAgent cannot reach a LAN
address, so the dev MacBook's agent and executor both point at
`http://127.0.0.1:18788`, which is an SSH tunnel to `fleet-host:8788`
(`com.addisdev.fleet-tunnel`). It is not a preference. Point one at
`192.168.50.27` and it will work from your shell and fail under launchd.

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
| The device | Roku Express 4K+ at `192.168.50.218`, Roku OS 15.3.4, developer mode on. Registered as `roku-<serial>` by fleet-host |
| The checkout | `~/tvloop` on fleet-host, **synced from the dev MacBook**, not cloned: the repo is private and fleet-host has no GitHub credential. Re-sync with `rsync -a --delete --exclude node_modules --exclude 'packages/*/dist' --exclude tvloop.toml <tvloop>/ fleet-host:tvloop/`, then `corepack pnpm install --frozen-lockfile && corepack pnpm build` there |
| `~/tvloop/tvloop.toml` | Not in the repo. Points `[project] source` at `examples/sample-channel`, the channel the flows expect. Keep it out of the rsync |
| The password | Keychain item `fleet-roku-dev` / account `rokudev` on fleet-host, the same one the dev installer reads. Missing means every run is `skipped:` and says how to add it |
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
A result whose error starts with `skipped:` means nothing ran.

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
| `com.addisdev.fleet-backup` | fleet-host | 01:30 | database (`sqlite3 .backup`, integrity checked), flows, web-specs, config, a manifest |
| `com.addisdev.fleet-backup-pull` | the dev MacBook | 03:00 | pulls the newest one off the brain and re-checks that it opens |

Fourteen kept on each side. Scripts are
[`collector/deploy/backup-brain.sh`](https://github.com/addisdev/fleet-runner/blob/main/collector/deploy/backup-brain.sh)
and
[`pull-brain-backups.sh`](https://github.com/addisdev/fleet-runner/blob/main/collector/deploy/pull-brain-backups.sh).

Artifacts are **not** backed up: content-addressed, most of a gigabyte, and
everything worth keeping is referenced by a result row the backup does carry.

The backup runs half an hour *before* the nightlies rather than after them, so
the copy is the last known-good state rather than the freshest one.

## The schedules

Five enabled. All times local to fleet-host.

| | When | Runs on | What red means |
|---|---|---|---|
| `nightly-synthetic-shelf` | 02:00 | fanout, pool `machines` | A machine's throughput moved, or an agent is not claiming. This is the comparison table |
| `nightly-self-check` | 02:15 | fanout, pool `machines` | Disk, clock drift, a tool that vanished, or the agent is not supervised |
| `nightly-fleet-ui-smoke` | 02:30 | `fleet-host`, an Android device | **Red since 2026-08-21.** Since 09-16 it is `no targets attached` — the Galaxy S8+ is unplugged |
| `nightly-aliquant-shots` | 04:15 | `fleet-host`, `chromium` and `mobile-chrome` | Green. The baseline was re-accepted on 2026-09-22 from fleet-host's own captures, after Aliquant's sign-in page gained a "Forgot password?" link; the old one had diverged 2.7% on desktop and 6.1% on mobile since 09-10. The `webkit` and `mobile-safari` baselines are still the August ones, because nothing runs those projects now |
| `nightly-tvloop-hardware` | 05:00 | `fleet-host`, the Roku, exclusive | tvloop's doctor, install, contract tests and flow replay. `skipped:` until the Roku password is in fleet-host's Keychain. Red from doctor means the Roku is asleep, off the network, or out of developer mode |

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
ssh fleet-host
fleet service status          # says "running" even when the brain has given up — see below
tail -40 ~/.fleet/logs/fleet.log
curl -s localhost:8788/api/health
```

`fleet service status` reports on the launchd job, not on what the supervisor is
doing, so it says `running` while the supervisor has permanently given up on the
brain. Read `fleet.log` for `GAVE UP`. Tracked in
[#45](https://github.com/addisdev/fleet-runner/issues/45).

### Restarting it

There is no `fleet service restart`. The subcommands are
`install|uninstall|start|stop|status|logs`. And `launchctl bootstrap`
immediately after a `bootout` fails with `Bootstrap failed: 5: Input/output
error`, which is a race rather than a permissions problem — `fleet` retries it
now, but by hand:

```bash
launchctl bootout gui/$(id -u)/com.addisdev.fleet
pgrep -f 'fleet\.mjs' | xargs -r kill        # nothing may hold 8788
sleep 5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.addisdev.fleet.plist
```

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
ssh fleet-host
fleet service stop
cd ~/fleet-backups/brain-<stamp>
sqlite3 fleet.db 'pragma integrity_check;'          # before trusting it
cp fleet.db ~/fleet-collector/data/fleet.db
tar -xzf flows.tar.gz -C ~/fleet-collector/
fleet service start
```

`MANIFEST.txt` in each backup says which host and which directories it came
from, so a restore does not have to guess.

## What is not done, and who it needs

- **The shelf is unplugged.** No phone, tablet, TV or stick has been on the
  fleet since 2026-08-18. That needs a powered USB hub and cables.
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
  reverse forward, which fails whenever the tunnel does. An ntfy topic is the
  fix and it needs an account decision.
- **No Mac for iOS, or for Firefox, WebKit and mobile Safari.** Those need a
  current macOS and Xcode, and the only such Mac besides your daily laptop is the
  runner farm. A dedicated Mac — or the mini, once fleet-host is on the tailnet —
  would bring back the three iOS nightlies and the three missing web projects.
