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

The reference deployment runs the collector on a spare 2016 MacBook Pro that
does nothing else, and it is deliberately **sudo-free**: Node is a user-local
tarball, the service is a LaunchAgent in `~/Library/LaunchAgents`, and
`better-sqlite3` installs from a prebuild. The whole stack can be rebuilt over
SSH with nobody at the keyboard.

## Binding and exposure

**There is no authentication, by design.** Anyone who can reach the collector
can enqueue a job. `FLEET_DASH_TOKEN` guards the dashboard's mutations but
`POST /jobs` stays open so `curl` and CI keep working. **Do not put this on the
internet.**

The network is the access control, and `FLEET_BIND` is what decides which
network that is. It takes a comma-separated list of addresses to answer on and
defaults to every interface.

```bash
FLEET_BIND=127.0.0.1,100.x.y.z npm start
```

Loopback plus the host's own tailnet address is the configuration most people
want: reachable from your own devices anywhere, and from nothing else. No port
forward, no hotel wifi, no guest network.

That matters more than it looks, because the LAN-only assumption stops being
true the moment one of your agents is a laptop that leaves the house.

## Running under launchd

The plists in
[`collector/deploy/`](https://github.com/addisdev/fleet-runner/tree/main/collector/deploy)
are **templates** carrying `__PLACEHOLDER__` paths rather than anyone's home
directory. That is not tidiness: launchd cannot expand `~`, does not read your
login `PATH`, and does not complain about a path that does not exist — an agent
with someone else's home directory in it fails by quietly doing nothing at all.

```bash
deploy/install-agent.sh com.addisdev.fleet-collector.plist
deploy/install-agent.sh com.addisdev.fleet-collector.plist --print   # dry run
```

The script fills the template in from the machine it runs on and refuses to
install a plist with any placeholder left in it.

`KeepAlive` revives the collector however it dies, which is the point: the
fleet's devices long-poll this service, so a crash that goes unnoticed strands
every runner.

!!! warning "Things that will catch you"

    - **Stop it with `launchctl bootout`**, not by killing the process. launchd
      starts it straight back.
    - **Do not `npm start` while it is loaded.** The port is taken, and the
      second copy exits with `EADDRINUSE` while looking, for a moment, like it
      worked.
    - **This is a LaunchAgent, so it starts at login, not at boot.** A Mac mini
      that reboots unattended needs automatic login, or the same job installed
      as a root-owned LaunchDaemon.
    - **Logs are not rotated.** `~/Library/Logs/fleet-collector.log` gets a line
      per request. Check its size occasionally.
    - After `npm install` upgrades tsx, confirm `node_modules/tsx/dist/cli.mjs`
      still exists — the plist invokes it directly to avoid depending on a login
      `PATH`.

The desktop agent ships both a plist and a `.service`, so a Linux box joins the
fleet under systemd the same way.

## The host executor

```bash
FLEET_URL=http://fleet-host.local:8788 npm run executor
```

Everything it needs is user-local, keeping the host sudo-free:

| | |
|---|---|
| `~/.local/platform-tools/adb` | Android Debug Bridge, from Google's zip |
| `~/.local/jdk` | Temurin 17, needed only because Maestro is JVM-based |
| `~/.maestro/bin/maestro` | Maestro |

**iOS host work is not possible on a machine without full Xcode**, by design.
Its `xcrun` is the Command Line Tools stub and cannot find `simctl`. See [the
iOS executor](ios-executor.md).

Devices must be physically attached to the executor for it to drive them. With
nothing attached, a host job is claimed and fails cleanly with `no android
targets attached`, which is the correct answer rather than a hang.

## Device state is journalled, not assumed

Anything that changes a phone and must put it back — network shaping, display
settings — writes its intent to a journal **before** touching the device, so a
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

Target them with `targets.match` rather than pools — see
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
  must not be divided by the device count — the devices are not identical, they
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

- **[Networking](networking.md)** — the SSH tunnel, why it exists, and network
  shaping.
- **[The iOS executor](ios-executor.md)** — standing one up on a Mac with Xcode.
- **[Alerts](alerts.md)** — the rules, and getting a notification somewhere you
  will see it.
