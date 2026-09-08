# Install on macOS

```bash
curl -fsSL https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.sh | sh
```

!!! warning "This cannot work yet"

    **No release has been published**, so there is no archive for that script to
    download and no `SHASUMS256.txt` to check it against. It will ask
    `api.github.com` for the latest release, find nothing, and stop. Skip to
    [from a checkout](#from-a-checkout) below, which is the path that has
    actually been run on this platform.

    The script itself has been exercised against locally built archives --
    checksum verified, a tampered archive refused, a re-install leaving
    `config.json` and `data/` intact. It has since been run against the real
    v0.5.0 release on macOS/arm64: the checksum verified and the installed
    binary reported its version.

**You need Node 22.13 or newer on `PATH`.** The release carries no runtime, by
decision rather than oversight -- see [why](index.md#what-the-installers-do-and-what-they-refuse-to-do).
That version is where `node:sqlite` stopped needing a flag, and the collector's
database is `node:sqlite`.

Nothing needs sudo. Nothing is written outside `~/.fleet`, and no dotfile is
edited -- if `~/.fleet/bin` is not already on your `PATH`, the script prints the
line to add and the file to add it to, and leaves that to you.

## From a checkout

This is the supported path today, and on macOS/arm64 it is the one that has been
watched to work end to end.

```bash
git clone https://github.com/addisdev/fleet-runner
cd fleet-runner

npm --prefix collector install
npm --prefix runner-machine install
npm --prefix fleet install

npm --prefix collector run dash:install
npm --prefix collector run dash:build
```

Three installs rather than one, because in a checkout `fleet up` spawns each
component's own entry point rather than importing it -- so each component needs
its own dependencies. (A *release* has no such problem: the bundle carries all
three inside one file, which is what the [bundle](#or-build-the-bundle) below
produces.)

The dashboard is a separate build with its own `package.json` and gitignored
output. Without it the collector serves a page telling you to run the build and
everything else keeps working, so you can skip it -- but the last step of
[getting started](../getting-started.md) is looking at it.

Then, from the repository root:

```bash
node fleet/node_modules/tsx/dist/cli.mjs fleet/src/cli.ts up
```

or, equivalently, `cd fleet && npm start -- up`. `fleet` detects which of the
two it is -- checkout or bundle -- because a flag for that is a flag somebody
gets wrong once and then cannot start the fleet.

### Or build the bundle

```bash
node fleet/build.mjs
node fleet/dist/bin/fleet.mjs up
```

`build.mjs` produces a 0.9 MB `fleet.mjs` with the collector, the machine agent
and the host executor inside it, beside the browser runner and the dashboard in
the same relative layout a checkout has. It runs with no `node_modules`
anywhere near it, which is the property a release is for and the one that would
have broken silently. Only Playwright stays outside -- 400 MB of browser needed
by four of thirty workloads, made a dynamic import so an executor without it
starts fine and says so.

## `fleet up`

```bash
fleet up
```

You should see this:

```
fleet 0.5.0-dev
  home     /Users/you/.fleet
  roles    brain, agent
  brain    http://127.0.0.1:8788  (bind 0.0.0.0)
  agent    -> http://127.0.0.1:8788

19:22:41  brain: start pid 76003
19:22:41  agent: start pid 76004
```

That is a collector and a machine agent, supervised. The default roles are
`brain,agent`: this machine is a fleet, and it is also a device on it.

`--role brain,agent,executor` adds the host executor, which is what drives
phones over `adb` and `simctl`. `--port` overrides the collector's port for this
run; `fleet config set collector.port 8788` writes it down.

### Then check it

```bash
fleet status
```

```
http://127.0.0.1:8788
  brain    MacBookPro (81fcc8c99b4559f4), up 72s
  devices  1 online of 1
  jobs     none
```

The hexadecimal is the brain's id, from `~/.fleet/data/collector.json`. It
survives a restart, which `instance` in `/api/health` deliberately does not --
`instance` answers "did it restart", and now that a device can register with more
than one brain, "which collector is this" is a separate question that needed a
separate answer.

`FLEET_NAME` overrides the name for the life of the process. The id is never
overridable, because an id somebody can set is an id two brains can collide on.

## `fleet doctor`

```bash
fleet doctor
```

```
this machine
  + fleet     0.5.0-dev (from a checkout)
  + node      v26.5.0
  + platform  darwin/arm64, 10 cores
  + home      /Users/you/.fleet
  + writable  yes

as a runner
  + declares             benchmark, build, build:gradle, build:xcode, build:npm, self-check, llm-eval
  ? benchmark:llama.cpp  no llama.cpp numbers from this machine. Put `llama-bench` on PATH, or set FLEET_LLAMA_BENCH.
  ? model-convert        no conversions from this machine. See docs/workloads/machine.md for the converter toolchain.
  ? serve                cannot host a model for other jobs to use. Put `llama-server` on PATH.
  ? shell                shell jobs are refused here, which is the default. A machine declares it only once its owner pins an allowlist.

as a host executor
  + adb      /Users/you/Library/Android/sdk/platform-tools/adb
  + xcode    full Xcode; simctl and devicectl are available
  + browser  chromium 151.0.7922.34
  + maestro  ~/.maestro/bin/maestro

reachability
  + http://127.0.0.1:8788  up

Nothing here would stop a job from running. Lines marked ? are things this machine simply does not have.
```

**Read the `declares` line rather than the `?` lines.** It is not a fixed
string: those are the capabilities this machine actually probed for, and the
collector will never offer this agent a workload that is not on it. A `?` is a
thing this machine does not have, which is not a fault -- `fleet doctor` exits 0
either way, because a Mac that cannot build for Android is not a broken Mac, and
a doctor that exited non-zero for it would fail every CI job somebody put it in.

The `xcode` line is worth its own sentence: **iOS host work is impossible
without full Xcode**, because the Command Line Tools' `xcrun` is a stub that
cannot find `simctl`.

## Keeping it up

```bash
fleet service install
```

writes **one** launchd unit running `fleet up`, into
`~/Library/LaunchAgents/com.addisdev.fleet.plist`, and starts it. One unit
rather than the five plists the old deployment had, so switching the brain off
is a config edit rather than a `launchctl` invocation somebody has to look up.

**`fleet service install` has never been run, on this platform or any other.**
Every path it writes is resolved absolutely -- launchd expands no `~` and reads
no login `PATH` -- and none of it has been watched start at login.
[Headless hosts](../deploy/headless.md) covers what the old, actually-deployed
plists do, and the local-network gate that bites a launchd agent on macOS
specifically.

## Next

- **[Get started](../getting-started.md)** -- a real job and a real result row.
- **[Devices](devices.md)** -- adding a phone, a television or a browser.
- **[Deploy](../deploy/index.md)** -- binding, exposure, and the networking that
  costs an evening.
