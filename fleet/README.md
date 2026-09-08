# fleet

*Part of [Fleet Runner](../README.md). The collector is
[`../collector`](../collector), the desktop agent is
[`../runner-machine`](../runner-machine).*

The front door: one command that runs a brain, a runner, or both.

Before this, standing up a fleet meant cloning the repository, `npm install` in two
directories, building the dashboard, running a shell script that filled a launchd plist in
from a template, and knowing that the plist invokes `node_modules/tsx/dist/cli.mjs` directly
because launchd does not read a login PATH. That is a fine way to run software you wrote. It
is not a way to hand it to somebody.

**It wraps the three programs, it does not reimplement them.** The collector, the machine
agent and the host executor each still read their own `FLEET_*` variables, still have their
own entry points, and still run perfectly well started by hand. `fleet` puts a face on them,
supervises them, and keeps them alive.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.sh | sh
```

Windows is [`install.ps1`](../install.ps1) via `irm ... | iex`. Both need **Node 22.13 or
newer** on PATH — that is the release where `node:sqlite` lost its flag, and the collector's
database is `node:sqlite`. Neither installer carries a runtime, neither needs sudo or
administrator rights, and both verify the download against the release's `SHASUMS256.txt`
and refuse to install if it does not match.

From a checkout instead:

```bash
cd fleet && npm install
npm start -- doctor        # or: node build.mjs && node dist/bin/fleet.mjs doctor
```

`fleet` detects which of the two it is, because a flag for it is a flag somebody gets wrong
once and then cannot start the fleet.

## The commands

| | |
|---|---|
| `fleet up [--role brain,agent,executor] [--join <url>] [--port N]` | This machine's components, supervised. Roles are a list because the first machine this exists for is a brain and a runner at once |
| `fleet collector` / `fleet agent` / `fleet executor` | Just the one component, in this process |
| `fleet join <url>` | Run a runner pointed at a brain elsewhere, and write that down |
| `fleet status` | What this fleet looks like right now: devices online, jobs by state, per collector |
| `fleet doctor` | What this machine can and cannot run, **and why not** — adb, full Xcode against the Command Line Tools, Playwright, Maestro, and the capability list the agent would actually declare |
| `fleet dash` | Open the dashboard |
| `fleet service install\|uninstall\|start\|stop\|status\|logs` | Start at login and stay up: launchd, systemd or a scheduled task, whichever this machine has |
| `fleet config` / `config get <path>` / `config set <path> <value>` | Read and write `~/.fleet/config.json` |
| `fleet version` | |

`fleet doctor` exits 0 whether or not it found problems. A machine that cannot build for iOS
is not a broken machine, and a doctor that exited non-zero for it would fail every CI job
somebody put it in.

## Where things live

Everything is under `~/.fleet` — config, database, artifacts, logs, and the installed binary
in `bin/`. One directory on every platform rather than the three the platforms each ask for,
because a project whose deployment story is "copy this somewhere and run it" is better
served by one path a person can type. `FLEET_HOME` moves it.

Precedence is the same for every value and is stated once, in `src/config.ts`:

```
command-line flag  >  FLEET_* environment  >  config.json  >  default
```

Nothing already deployed changes behaviour: a plist that sets `FLEET_URL` keeps deciding,
and `fleet` only fills in what nobody has said. `fleet config set` warns when the variable it
just wrote is also set in the environment, because "I edited the config and nothing happened"
is almost always that.

`fleet service install` writes **one** unit running `fleet up`, not one per component. The
old deployment had a plist each for the collector, the executor, the iOS executor, the tunnel
and the agent. One unit is the difference between switching the brain off being a config edit
and being a `launchctl` invocation somebody has to look up — and it means the crash-loop
detection in `src/supervisor.ts` applies, which launchd's `KeepAlive` has no equivalent for
and which will otherwise restart a broken collector every ten seconds forever.

## Status

What has actually been watched to work, on **macOS/arm64 and nowhere else**:

- `fleet up` starting a supervised brain and agent, and a synthetic benchmark running end to
  end through them — from a checkout, and from the bundled release.
- The bundle running with no `node_modules` anywhere near it. That is the property a release
  is for, and it is the one that would have broken silently.
- `fleet doctor` and `fleet status`.
- Clean `SIGTERM` shutdown. The components install their own signal handling guarded on
  `import.meta.url === argv[1]`, which is false inside a bundle, so the bundled path installs
  it explicitly — without that, `SIGTERM` takes the default action and the process dies with
  sockets open and the database mid-write.

Since v0.5.0, CI also runs this package's whole suite -- the supervisor, the config, the
supervised `fleet up` end to end and the two-brain race -- on **Windows, Linux and macOS**,
and builds the bundle and runs `fleet doctor` from it on each. That is coverage, not use:
nobody has stood a fleet up on a Windows or Linux machine and worked with it.

The first three runs on those platforms failed, and everything they found is fixed: a
supervisor backoff timer that was `unref`'d and so could skip a restart when nothing else
held the event loop open, an absolute path imported as an ESM specifier (`Received protocol
'd:'`), a database Windows would not unlink while a killed child still held it, `spawn("npm")`
being ENOENT there and `spawn("npm.cmd")` being EINVAL, and a `node_modules/.bin` shim with
no Windows equivalent.

What has still not been run:

- **`fleet service install`, on any platform.** Not launchd, not systemd, not the Windows
  scheduled task. Every path it writes is resolved absolutely and none of it has been watched
  start at login.
- **A container.** `fleet/Dockerfile` is built and published by the release workflow for
  linux/amd64 and linux/arm64, so it assembles; nothing has started a container from it.
- **`install.ps1`.** No PowerShell was available to parse it, let alone run it. `install.sh`
  *has* been run against the real v0.5.0 release on macOS/arm64: checksum verified, binary
  installed and reporting its version.

MIT — see [LICENSE](../LICENSE).
