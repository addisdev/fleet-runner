# Deploy

Where the services live, how to keep them up, and the parts that cost an evening
each to diagnose.

## The shape of a deployment

| | Runs where | Why there |
|---|---|---|
| **collector** | One always-on machine | Everything long-polls it, so it has to be up |
| **host executor** | Wherever devices are physically attached | It drives phones over adb; a cable is required |
| **iOS executor** | A Mac with **full Xcode** | `simctl` and `devicectl` ship with Xcode, not the Command Line Tools |
| **machine agent** | Any laptop or desktop | It is a fleet device in its own right |
| **runner apps** | The phones | They claim their own work |

The first three are roles of one command now. `fleet up --role brain,executor`
runs a collector and a host executor on one machine; `fleet up` on its own runs
`brain,agent`. They are still three programs in three processes -- `fleet`
wraps them and does not reimplement them, so each still reads its own `FLEET_*`
variables and still runs perfectly well started by hand.

The reference deployment runs the collector on a spare 2016 MacBook Pro that
does nothing else, and it is deliberately **sudo-free**: Node is a user-local
tarball and the service is a LaunchAgent in `~/Library/LaunchAgents`. The whole
stack can be rebuilt over SSH with nobody at the keyboard.

There is **no native code anywhere in the collector**. It used to need
`better-sqlite3` and a prebuild for the running architecture; the database is
Node's own `node:sqlite` now, so `npm install` compiles nothing and an install
cannot fail on a toolchain the machine does not have. That is also what lets the
collector run on Windows, which it never had, and what makes one
`docker build --platform linux/arm64` from an x86 laptop produce a working Pi
image.

## Keeping it up: `fleet service`

```bash
fleet service install                       # brain,agent, from ~/.fleet/config.json
fleet service install --role brain,executor
fleet service status
fleet service logs
fleet service stop | start | uninstall
```

That writes **one** unit running `fleet up`, and starts it. Which kind of unit
depends on the machine:

| | What it writes | Where |
|---|---|---|
| macOS | a LaunchAgent plist, label `com.addisdev.fleet` | `~/Library/LaunchAgents/com.addisdev.fleet.plist` |
| Linux | a systemd **user** unit | `~/.config/systemd/user/fleet.service` |
| Windows | a `schtasks` task that runs at logon | the task scheduler |

!!! warning "How much each backend has been run"

    - **launchd:** a real fleet's brain runs under it, on macOS 12.
    - **systemd:** a CI smoke test installs the user unit on Ubuntu, checks it
      with `systemd-analyze verify`, waits for the collector it starts to
      answer, and uninstalls it. Nobody has watched it come back after a reboot.
    - **Windows task:** never run.

    Every path it writes is resolved absolutely -- launchd expands no `~` and
    reads no login `PATH`, systemd is the same and Windows is worse.

    Also run, on macOS, are the older per-component plists in
    `collector/deploy/` and `runner-machine/deploy/`. Those are what the
    reference deployment actually uses today, and they are documented in
    [headless hosts](headless.md). They have been deprecated in favour of
    `fleet service` since 0.5.0 and still ship in 0.8.0, with no removal date
    set, because they are the ones with mileage on them.

**One unit, not five.** The old deployment had a plist each for the collector,
the executor, the iOS executor, the tunnel and the agent. One unit is the
difference between switching the brain off being a config edit
(`fleet config set roles agent`) and being a `launchctl` invocation somebody has
to look up.

It also means the crash-loop detection in the supervisor applies. `KeepAlive`
and `Restart=always` have no equivalent: they restart a component that crashes
on startup every ten seconds forever, writing a stack trace into a log file
nobody rotates, and from outside that is indistinguishable from a fleet that
works. `fleet up` backs off, rotates, and after five failures in quick
succession **stops and says which log to read**. launchd still supervises the
supervisor, which is the right division of labour.

### The things that will still catch you

- **Stop it through `fleet service stop`**, or `launchctl bootout` -- not by
  killing the process. launchd starts it straight back.
- **Do not run `fleet up` by hand while the service is loaded.** The port is
  taken, and the second copy exits with `EADDRINUSE` while looking, for a
  moment, like it worked.
- **A LaunchAgent starts at login, not at boot.** A Mac mini that reboots
  unattended needs automatic login, or the same job as a root-owned
  LaunchDaemon. A systemd *user* unit has the same problem and the same class of
  answer: `loginctl enable-linger`.
- **On macOS, a service that has to reach the LAN hits the local-network gate.**
  This is the one that costs an evening. See
  [networking](networking.md#macos-gates-local-network-access-and-launchd-cannot-ask).

## Binding and exposure

**There is no authentication by default.** Anyone who can reach the collector
can enqueue a job. `FLEET_DASH_TOKEN` guards the dashboard's mutations but
`POST /jobs` stays open so `curl` and CI keep working. Scoped tokens are opt-in
(`FLEET_AUTH=tokens`, and `FLEET_AUTH_PROTOCOL=token` for the runners): see
[Authentication](auth.md). With auth off, **do not put this on the internet.**

The network is the access control, and `FLEET_BIND` is what decides which
network that is. It takes a comma-separated list of addresses to answer on and
defaults to every interface -- and says so in the log when it does.

```bash
fleet config set collector.bind 127.0.0.1,100.x.y.z
```

or `FLEET_BIND=127.0.0.1,100.x.y.z`, which wins over the file. Loopback plus the
host's own tailnet address is the configuration most people want: reachable from
your own devices anywhere, and from nothing else. No port forward, no hotel
wifi, no guest network.

That matters more than it looks, because the LAN-only assumption stops being
true the moment one of your agents is a laptop that leaves the house.

### The other collector settings

`fleet up` sets the paths below from `~/.fleet`; started by hand, the
collector resolves the relative defaults against its working directory. The
port, bind list, tailnet allowlist, data and artifact directories and
`FLEET_NAME` are covered above and in [Install](../install/index.md).

| Variable | Default | |
|---|---|---|
| `FLEET_DISCOVERY` | off (`fleet up` passes `collector.discovery`) | `1` advertises the collector over mDNS, below |
| `FLEET_PEERS` | none | Comma-separated base URLs of other collectors, for [more than one brain](#more-than-one-brain) |
| `FLEET_PEER_TOKENS` | none | JSON object of peer URL to a `read` token that peer issued, for a peer with tokens on. See [more than one brain](#more-than-one-brain) |
| `FLEET_POWER_CONFIG` | `power.json` | The pool-to-smart-plug map, see [Energy](#energy) |
| `FLEET_SWEEP_MS` | 15000 | How often expired leases are swept |
| `FLEET_SCHEDULER_TICK_MS` | 20000 | How often schedules are evaluated |
| `FLEET_DASH_DIST` | `dash/dist` | The built dashboard. Missing, the collector serves a placeholder rather than failing |
| `FLEET_LOG` | `info` | Log level |
| `FLEET_LOG_FILE` | `~/Library/Logs/fleet-collector.log`; `~/.fleet/logs/collector.log` under `fleet up` | Where the service manager sends the collector's output. The collector does not write it; it reports its size and alerts on it (`log-size`) |
| `FLEET_TOKENS_FILE` | `$FLEET_DATA_DIR/tokens.json` | See [Authentication](auth.md) |

The intervals (`FLEET_SWEEP_MS`, `FLEET_SCHEDULER_TICK_MS` and
`FLEET_ALERT_TICK_MS`) must be whole milliseconds, at least 1000. Anything else
(`15s`, or `15` meaning seconds) is ignored for the default, with a warning in
the startup log, rather than becoming a timer that fires every few
milliseconds.

Alert thresholds are `FLEET_ALERT_*`, listed in [Alerts](alerts.md).

Three more belong to the machine agent, not the collector:

| Variable | Default | |
|---|---|---|
| `FLEET_DEVICE_TTL_S` | unset: a permanent shelf device | Registers with `ttl_s`, for an agent whose absence is normal. See [the protocol](../protocol.md#ttl_s-if-you-are-temporary). `fleet up` passes `agent.ttlS` |
| `FLEET_SHELL_ALLOWLIST` | `$FLEET_CACHE_DIR/shell-allowlist.txt` (`~/.fleet/cache/` under `fleet up`) | The sha256 list of scripts the `shell` workload may run. No file, no `shell` capability |
| `FLEET_SERVE_BIND` | `loopback` | Where the `serve` workload's model server listens when the job does not say: `loopback`, `tailnet`, or this machine's tailnet address. Never a wildcard or a LAN address |

### mDNS advertising is off by default

`fleet config set collector.discovery true` makes a collector announce itself as
`_fleet._tcp`, which is what `fleet join --discover` looks for. It is off by
default because a collector should not start announcing itself on somebody's
office network because they upgraded.

It does not widen anything. mDNS is link-local by construction, so a collector
bound to a tailnet address is not advertised across it, and the posture above is
unchanged.

### The tailnet allowlist

**This is not authentication and it does not make the collector safe to
expose.** Everything above still holds. What it addresses is narrower: once the
collector answers on its tailnet address so a roaming laptop can claim work,
"the network I chose" includes every node on the tailnet -- including one
somebody added with a share link, and including a phone handed round at a
conference.

So the network is still the boundary. It is just a network you can enumerate.

```bash
FLEET_TAILNET_ALLOWLIST=my-macbook,pixel-4a,fleet-ci-runner
```

| Peer registering | What happens |
|---|---|
| loopback | admitted |
| a LAN address | admitted, under the posture above |
| a tailnet address (100.64.0.0/10) | must resolve, via `tailscale whois`, to a node in the list |
| anything, with the list unset | admitted -- nothing is checked, which is the default |

Three deliberate choices:

- **It fences the tailnet, not the house.** An allowlist that also fenced the
  LAN would mean enabling it broke every phone on the shelf.
- **A tailnet address that cannot be identified is refused.** If an unavailable
  `tailscale` binary made the lookup fail open, the allowlist would disable
  itself exactly when it was needed -- so the collector needs the CLI on its
  PATH, which a launchd agent does not get for free.
- **Entries are names, not patterns.** No globs. An allowlist that can be got
  wrong quietly is worse than one that has to be typed out.

A refusal is a 403 on `POST /devices/register` and a warning in the log naming
the node and the reason.

### CI runners as devices, for four minutes

Rather than opening the collector to GitHub, the runner comes to the collector:
it joins the tailnet, registers with a `ttl_s`, claims the `build` job for its
own commit, publishes the artifact and disappears. Everything after that runs on
real hardware at home, and `report_to.github_status` closes the loop back to the
pull request.

`collector/ci/ephemeral-runner.yml` is a worked example, and an example on
purpose -- a workflow that tries to reach a collector it cannot see fails on
every push.

## More than one brain

Two people with two collectors can share a shelf, and a laptop can be a device
on the fleet at home and on the one at work. Collectors do **not** share a
database, forward jobs, replicate results, or elect anything: a job enqueued on
brain A is A's job and lands in A's database, whatever device ran it.

`GET /api/peers` lists other brains and `/api/peers/:id/*` proxies one peer's
read API server to server, which the dashboard's brain switcher uses. The proxy
rather than CORS is a security decision: there is no authentication by default
(see [Authentication](auth.md)), so opening the read API cross-origin would let
any website in the operator's browser read the whole fleet from any tab. Peers are addressed by stable id rather than URL,
so a link cannot be turned into a request to an arbitrary host by editing the
address bar; only an allow-list of endpoints is proxied; and nothing that mutates
is proxied at all.

**A peer with tokens on** answers the proxy 401 unless this collector sends it
a token, and each brain issues its own (a token is a hash in that brain's
`tokens.json`), so the token is per peer. On the peer, create a `read` token
(`fleet token create brain-a --scope read`); on this collector, map the peer's
URL, spelled as in `FLEET_PEERS`, to it:

```bash
FLEET_PEERS=http://fleet-host.local:8788
FLEET_PEER_TOKENS='{"http://fleet-host.local:8788": "fr_..."}'
```

It is sent as a bearer token on every request to that peer and never to any
other. The token of whoever is reading this dashboard is not passed on: it is
a token for this brain, not that one. A value that is not a JSON object of
strings maps nothing and says why at startup. Under `fleet up`, set it in the
environment or in the `env` object of `~/.fleet/config.json`, as for
`FLEET_AUTH`.

The rule the device side enforces is the one that matters for numbers: **a
device runs one job at a time, whoever asked.** Two benchmarks at once produce
two numbers that are both wrong. See
[adding devices](../install/devices.md#and-it-can-belong-to-more-than-one-fleet).

## The host executor

```bash
fleet up --role executor
```

or `FLEET_URL=http://fleet-host.local:8788 npm run executor` from `collector/`.

Everything it needs is user-local, keeping the host sudo-free:

| | |
|---|---|
| `~/.local/platform-tools/adb` | Android Debug Bridge, from Google's zip |
| `~/.local/jdk` | Temurin 17, needed only because Maestro is JVM-based |
| `~/.maestro/bin/maestro` | Maestro |

`fleet doctor` prints which of those it found, and a reason for each one it did
not.

**iOS host work is not possible on a machine without full Xcode**, by design.
Its `xcrun` is the Command Line Tools stub and cannot find `simctl`. See [the
iOS executor](ios-executor.md).

Devices must be physically attached to the executor for it to drive them, with
one exception: `collector/src/drivers/roku.ts` reaches Rokus over the LAN by
SSDP rather than over a cable. With nothing attached, a host job is claimed and
fails cleanly with `no android targets attached`, which is the correct answer
rather than a hang.

## Device state is journalled, not assumed

Anything that changes a phone and must put it back -- network shaping, display
settings -- writes its intent to a journal **before** touching the device, so a
crash between the two is recoverable. Both restore every attached device at
executor startup, before the first claim.

That makes the journals operator-visible signals. **A device still listed in
`~/.fleet/network-shape.json` or `~/.fleet/device-state.json` after a run needs
manual attention**: a phone left offline, or left in Arabic at the largest
dynamic type, looks broken rather than configured, and nothing else will tell
you which.

Restoration is asymmetric on purpose. Wifi is re-enabled unconditionally, since
a fleet device off the network is broken by definition. **Cellular data is only
re-enabled when the journal says the executor disabled it**, because turning
data back on for a device deliberately kept off a metered SIM costs real money.

## Schedules

Nightly and weekly runs live in
[`scripts/seed-schedules.ts`](https://github.com/addisdev/fleet-runner/blob/main/collector/scripts/seed-schedules.ts),
not only in the database. `npm run seed:schedules` upserts them; it is
idempotent and preserves the on/off state of anything already there, so
re-running can never quietly switch off a run somebody turned on. **New
schedules always arrive disabled.**

Target them with `targets.match` rather than pools -- see
[Targeting](../concepts.md#targeting) for the case that proves why.

## Energy

`power.json` maps a pool to a smart plug; Tasmota, Shelly and Home Assistant all
speak the shape. A pool that also declares `read_url`, `watts_path` and
`energy_method` is sampled, and a job's energy is integrated over its claim
window.

Three things are deliberate and worth knowing before you trust a figure:

- **`energy_method` is declared, never inferred.** A pool that omits it gets no
  energy figure at all. `plug` means the plug feeds exactly one device;
  `plug-shared` means several sit behind it and the figure is **the pool's**. It
  must not be divided by the device count -- the devices are not identical, they
  are not all busy, and a per-device number arrived at by division would be
  indistinguishable in storage from a measured one.
- **Gaps are counted, never bridged.** The integration refuses to extrapolate
  past its first and last in-window sample, skips gaps over five minutes, and
  yields null rather than zero below two samples. An unreachable plug must not
  become fabricated draw.
- **The number includes charging, and says so.** Subtracting a measured idle
  baseline removes the charger brick's standing draw, but nothing can remove
  battery charging current from a wall measurement. The reported quantity is
  therefore stated everywhere it appears: watt-hours at the wall, above the
  pool's idle baseline, over the job's claim window, including any charging
  during it.

## Also here

- **[Headless hosts](headless.md)** -- the per-component launchd plists and
  systemd units that are actually deployed today, the tunnel, and what to do
  when nobody is at the keyboard.
- **[Networking](networking.md)** -- the SSH tunnel, why it exists, and network
  shaping.
- **[The iOS executor](ios-executor.md)** -- standing one up on a Mac with Xcode.
- **[Exploratory QA on ultra](explore-on-ultra.md)** -- the executor, emulator,
  simulators and model gateway behind the overnight explore jobs. Listed under
  Exploratory QA in the navigation.
- **[Alerts](alerts.md)** -- the rules, and getting a notification somewhere you
  will see it.
