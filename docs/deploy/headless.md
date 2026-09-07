# Headless hosts

A fleet's brain lives on a machine nobody looks at. That is the point of it, and
it is also where every interesting failure happens: a service that starts at
login on a machine nobody logs into, a `PATH` that exists in your shell and not
in launchd's, a network permission dialog that nobody is there to click.

This page is the deployment that is **actually running** today -- per-component
launchd plists and systemd units, driven over SSH -- plus the tunnel that makes
a Mac collector reachable at all.

!!! warning "These scripts are deprecated"

    `collector/deploy/install-agent.sh` and
    `runner-machine/deploy/install-agent.sh` are superseded by
    [`fleet service install`](index.md#keeping-it-up-fleet-service), which writes
    one unit running `fleet up` instead of one unit per component. They ship one
    more release and are then removed.

    They are documented here rather than deleted because of an awkward fact:
    **`fleet service install` has never been run on any platform**, and these
    have. Until somebody has watched the new path start at login, the old path
    is the one with mileage on it.

## The plists are templates, and that is not tidiness

```bash
deploy/install-agent.sh com.addisdev.fleet-collector.plist
deploy/install-agent.sh com.addisdev.fleet-collector.plist --print   # dry run
```

The files in
[`collector/deploy/`](https://github.com/addisdev/fleet-runner/tree/main/collector/deploy)
carry `__PLACEHOLDER__` paths rather than anyone's home directory. launchd
cannot expand `~`, does not read your login `PATH`, and does not complain about
a path that does not exist -- an agent with someone else's home directory in it
fails by quietly doing nothing at all. The script fills the template in from the
machine it runs on and refuses to install a plist with any placeholder left in
it.

Every value can be overridden from the environment:

```bash
NODE=/usr/local/bin/node deploy/install-agent.sh com.addisdev.fleet-collector.plist
```

The five units the reference deployment has:

| | What it runs |
|---|---|
| `com.addisdev.fleet-collector.plist` | the collector |
| `com.addisdev.fleet-executor.fleet-host.plist` | the host executor |
| `com.addisdev.fleet-executor-ios.plist` | the iOS executor, on the Mac with full Xcode |
| `com.addisdev.fleet-tunnel.plist` | the SSH tunnel, below |
| `com.addisdev.fleet-alert-receiver.plist` | the end of the alert path |

plus `runner-machine/deploy/com.addisdev.fleet-runner-machine.plist` for the
desktop agent, and `fleet-runner-machine.service` beside it so a Linux box joins
the fleet under systemd the same way. Five is exactly the number
`fleet service install` exists to reduce to one.

`KeepAlive` revives the collector however it dies, which is the point: the
fleet's devices long-poll this service, so a crash that goes unnoticed strands
every runner. It is also the thing `fleet up`'s supervisor improves on -- see
[why](index.md#keeping-it-up-fleet-service).

### Things that will catch you

- **Stop it with `launchctl bootout`**, not by killing the process. launchd
  starts it straight back.
- **Do not `npm start` while it is loaded.** The port is taken, and the
  second copy exits with `EADDRINUSE` while looking, for a moment, like it
  worked.
- **This is a LaunchAgent, so it starts at login, not at boot.** A Mac mini
  that reboots unattended needs automatic login, or the same job installed
  as a root-owned LaunchDaemon.
- **Logs are not rotated.** `~/Library/Logs/fleet-collector.log` gets a line
  per request. Check its size occasionally. (`fleet up` rotates its own; these
  do not.)
- After `npm install` upgrades tsx, confirm `node_modules/tsx/dist/cli.mjs`
  still exists -- the plist invokes it directly to avoid depending on a login
  `PATH`. This is the single most annoying property of the old deployment, and
  it is why the release is a bundle: `fleet up` from a release invokes `node` on
  one file that has no `node_modules` anywhere near it.

## systemd, for a Linux host

`runner-machine/deploy/fleet-runner-machine.service` is the same idea with
different syntax, installed by the same script. Two things differ from launchd
and both are the usual traps:

- **A user unit runs at login, not at boot**, unless the account has lingering
  enabled: `loginctl enable-linger <user>`. A headless box that reboots and is
  never logged into will otherwise sit there running nothing, which looks
  exactly like a crashed service.
- **`ExecStart` is not a shell.** It splits on spaces and expands nothing, so
  every path in it is absolute for the same reason the plists' are.

## The tunnel, and why loopback

This is the one that costs an evening, and it looks exactly like an ordinary
network problem.

**macOS gates local-network access per application, and a process started by
launchd has no grant and no way to prompt for one.** The symptom is
`EHOSTUNREACH` from the same Node binary that reaches the collector's LAN
address perfectly from Terminal.

Loopback is not gated. So the deployed answer is a tunnel forwarding a local
port to the collector, and an executor whose `FLEET_URL` points at
`127.0.0.1:<forwarded port>` rather than at a LAN address:

```bash
deploy/install-agent.sh com.addisdev.fleet-tunnel.plist
```

The full diagnosis, the cleaner fix for a machine with a human at the keyboard,
and the reverse forward that carries alerts back to a desktop notification are
in [networking](networking.md#macos-gates-local-network-access-and-launchd-cannot-ask).

??? note "The menu-bar app is a bet on this, and it does nothing for you here"

    [`desktop/`](https://github.com/addisdev/fleet-runner/tree/main/desktop) is a
    Tauri menu-bar app whose whole reason for existing is that **an app bundle
    can ask for local-network access** where a launchd agent cannot. If that
    works, the tunnel stops being load-bearing on a machine somebody uses.

    **Whether it works is untested**, and the honest assessment is roughly even
    odds leaning against: `fleet up` re-execs itself into grandchildren running
    the system `node` from outside the bundle, and each hop is a chance for
    responsibility to reset. The most likely outcome is that `node` gets the
    grant rather than the app.

    Either way it is irrelevant to this page. A headless host has nobody to click
    the dialog, so **the tunnel stays** for exactly the machines this page is
    about. None of the Rust has ever been compiled, either.

## Rebuilding one over SSH

The reference deployment is sudo-free on purpose: Node is a user-local tarball,
the service is a LaunchAgent in `~/Library/LaunchAgents`, and the executor's
tools all live under `~/.local` and `~/.maestro`. Nothing in the stack needs a
password, which is what makes "rebuild it over SSH with nobody at the keyboard"
a true sentence rather than an aspiration.

`collector/deploy/adopt-fleet-host.sh` is the front of that: given
`user@spare-mac.local` it verifies key auth, gathers the facts that decide
whether the machine can host a collector at all, and writes an `~/.ssh/config`
entry. It never prompts, which is the property that makes the rest scriptable.

Two things do not survive that model and are worth knowing before you rely on
it:

- **The local-network grant**, above. It cannot be given over SSH, which is why
  the tunnel exists rather than being a workaround somebody forgot to remove.
- **The iOS executor's credentials.** Signing and sign-in secrets come from the
  host's Keychain, which needs an unlocked login session. See [the iOS
  executor](ios-executor.md#3-sign-in-credentials).

## Alerts have to reach a person

A red nightly that reaches nobody is worse than no nightly. On a headless host
that is not rhetoric. `FLEET_ALERT_WEBHOOK` unset -- the default -- makes the
dashboard the only channel, which on a machine nobody looks at is the same as no
channel at all.

The deployed answer is `scripts/alert-receiver.ts`, a local webhook target that
raises a macOS notification, running on the machine somebody *is* looking at
under `com.addisdev.fleet-alert-receiver.plist`. The tunnel's reverse forward is
how the headless host reaches it -- loopback at both ends, so the alert never
crosses the LAN.

[Alerts](alerts.md) has the rules and the sinks.
