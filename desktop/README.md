# desktop

*Part of [Fleet Runner](../README.md). The CLI it wraps is [`../fleet`](../fleet),
the collector is [`../collector`](../collector).*

A menu-bar app around the `fleet` binary. Tauri 2, one sidecar, no second
supervisor.

It does four things, and every one of them is something the CLI could already do
and nobody was doing because it needed a terminal to be open:

- **A tray menu** saying what the fleet is right now, with Open Dashboard,
  Start, Stop and Quit.
- **Three role switches**, the collector port, and the list of brains the agent
  registers with — writing `~/.fleet/config.json`, the same file and the same
  schema `fleet config set` writes and `fleet up` reads.
- **The dashboard in a window**, pointed at `http://127.0.0.1:<port>/dash`.
- **A notification when a component gives up.** The supervisor stops restarting
  a component after five failures in quick succession and prints `GAVE UP` —
  which, under a launchd agent, goes into a log file nobody opens. This project's
  own README says a red nightly that reaches nobody is worse than no nightly.

**It wraps the CLI, it does not reimplement it.** No supervision logic, no
backoff curve, no second config format. `src-tauri/src/sidecar.rs` starts one
child, `fleet up`, and reads its stdout.

## The bet

**This is the reason the app exists, and it is unverified.**

[`docs/deploy/networking.md`](../docs/deploy/networking.md) records an evening
lost to it: macOS 26 gates local-network access **per application**, a process
started by launchd has no grant and **no way to prompt for one**, and the symptom
is `EHOSTUNREACH` from the same Node binary that reaches the collector perfectly
from Terminal. The deployed workaround is an SSH tunnel so the executor only ever
talks to loopback, which is not gated.

An app bundle *can* ask. So the hypothesis is: give the fleet a real bundle
identity with `NSLocalNetworkUsageDescription` in its `Info.plist`, let macOS put
a dialog in front of a human, and the tunnel stops being load-bearing.

**What is unverified is the part that matters.** The process that opens the
sockets is not this bundle. It is `fleet`, spawned as a Tauri sidecar — a
separate posix process whose executable happens to sit inside
`Fleet.app/Contents/MacOS/`. Whether macOS attributes its local-network traffic
to this bundle's grant, or treats it as an unattributed process (the launchd
case again, with extra steps), **has not been tested.** The keys are written and
reasoned through; that is all.

The configuration that would be needed is in
[`src-tauri/Info.plist`](src-tauri/Info.plist) — `NSLocalNetworkUsageDescription`
and `NSBonjourServices` for `_fleet._tcp`, which the collector's discovery
advertises and browses — and in
[`src-tauri/entitlements.plist`](src-tauri/entitlements.plist).

### Day one: how to find out

Do this before believing anything else in this README.

1. `./stage-sidecar.sh && cd src-tauri && cargo tauri build`. Sign it — an
   ad-hoc signature is enough to test attribution, and a Developer ID one is
   what you would ship.
2. `plutil -p Fleet.app/Contents/Info.plist | grep -i localnetwork`. **If the key
   is not there, stop.** Tauri is supposed to merge `src-tauri/Info.plist` into
   the generated one; if it does not, move the key into
   `bundle.macOS` in `tauri.conf.json` or post-process the bundle. A key that is
   silently dropped looks exactly like a key that is present and ignored.
3. Open the app. Put the collector on another machine and set this one to
   **agent only**, pointed at that machine's LAN address. Watch for the Local
   Network dialog.
4. Whether or not a dialog appeared, look in **System Settings → Privacy &
   Security → Local Network.** The question is *what is listed*: `Fleet`, or
   `node`, or nothing.

### What it means, and what to do

| What you see | Verdict | What to do |
|---|---|---|
| `Fleet` listed, agent registers over the LAN | The bet pays. | Delete the tunnel plist from the deploy docs for machines running this app, and say so in `docs/deploy/networking.md`. |
| `node` listed separately | Attribution follows the executable, not the bundle. | Half a win: the grant is per-`node` and survives, but it is not the app's and every Node on the machine shares it. Document it; the tunnel stays for headless hosts. |
| Nothing listed, `EHOSTUNREACH` | The bet fails. | The sidecar is not covered. Do **not** paper over it. Two honest options below. |

If it fails, the fix is **not** to reimplement the collector in Rust so that the
bundle is the thing opening the sockets — that is the second implementation of
the protocol this repository has spent a lot of effort not having. It is either:

- **Keep the tunnel.** The app is then still worth having for the config
  switches, the dashboard window and the GAVE UP notifications, and this section
  becomes a statement of fact rather than a hypothesis. The honest cost is that
  the app's headline feature is gone.
- **Make the app the network client.** Move only the *reachability* out of the
  sidecar — the app holds the socket and forwards to the child over loopback,
  which is exactly the SSH tunnel with the app in place of `ssh`. That is a real
  design and a real amount of work, and it should not be started before step 4
  above says it is needed.

## Build it

Needs a Rust toolchain and the Tauri CLI. **Node is needed at runtime too** —
the sidecar is a Node bundle, and `fleet`'s own README is clear that it needs
**Node 22.13 or newer**, because that is the release where `node:sqlite` lost its
flag and the collector's database is `node:sqlite`.

```bash
cargo install tauri-cli --version "^2"
./stage-sidecar.sh            # builds fleet and stages it as a sidecar
cd src-tauri && cargo tauri dev
```

`stage-sidecar.sh --skip-build` reuses whatever is already in `fleet/dist`.

### Why the sidecar is a shim script

A Tauri sidecar is **one executable file**, copied into
`Fleet.app/Contents/MacOS/`. `fleet` is not one file. `fleet/build.mjs` emits a
tree — `bin/fleet.mjs` beside `dash/dist`, `runner-web`, `examples` and
`schemas` — and it keeps that relative layout deliberately, because
`assetRoot()` in `fleet/src/paths.ts` resolves the dashboard and the browser
runner against the bundle's own directory. Ship only the `.mjs` and you get a
collector that starts, serves the API, and 404s the dashboard.

So the tree goes in as an app resource and the sidecar is a small `sh` shim that
finds it and execs `node` on `bin/fleet.mjs` inside it, which puts `assetRoot()`
back over the layout it expects.

The shim also **finds `node` by hand** before trusting `PATH`. An app launched
from Finder gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — the
same class of problem the deploy docs record for launchd, which "does not read
your login `PATH`". A Homebrew `node` in `/opt/homebrew/bin` is invisible there.
It checks `$FLEET_NODE`, then `~/.fleet/runtime/bin/node` (where `install.sh`
puts a private Node), then the usual prefixes, then `PATH`.

### No `package.json`, no bundler

The frontend is `ui/index.html`, `ui/app.js` and `ui/style.css`, loaded with
plain `<script src>` and `<link rel>`. This is the same choice
[`collector/runner-web/index.html`](../collector/runner-web) makes — the one the
dashboard docs call out as the only dashboard that works from a bare checkout —
and the reasoning carries over: this window has one form in it, and a toolchain
that has to run before you can see a checkbox is a toolchain that will be broken
on the day somebody wants to change the checkbox. It also keeps the claim below
literal: there is no second Node runtime in this app, and a bundler would have
put one back into the build if not into the bundle.

`app.withGlobalTauri` in `tauri.conf.json` is what makes it possible — it puts
`window.__TAURI__` on the page, so there is nothing to import and nothing to
resolve.

## The three things that had to be right

**Stopping cleanly.** `CommandChild::kill()` in `tauri-plugin-shell` is a
`SIGKILL`. A SIGKILLed `fleet up` never runs the `shutdown()` in `cli.ts`, never
calls `supervisor.stop()`, and so never asks the collector to stand down — it
dies with sockets open and its SQLite database mid-write. Quitting a menu-bar app
must not be worse than closing a terminal. So `sidecar::stop` sends **SIGTERM by
pid** (which is the entire reason `libc` is a dependency), waits **15 seconds**
— the supervisor gives each of its own children 10 seconds of grace, and a
parent that gave up sooner would make that grace a fiction — and only then
kills, saying so in the scrollback.

**Not inventing a second config.** `src-tauri/src/config.rs` mirrors the
`FleetConfig` type in `fleet/src/config.ts` field for field, including the
`deviceId`/`ttlS` camelCase and `tailnetAllowlist`. The field order is the order
`save()` in config.ts emits, so a file written here and a file written by the
CLI are byte-identical rather than merely equivalent — a config.json that
reshuffles itself depending on which program touched it last is a diff nobody
can read. Unknown top-level keys survive a round trip, so a key a newer CLI adds
is not silently deleted by saving from the settings window.

The one thing it does **not** mirror is the precedence rule. config.ts is clear
that `FLEET_*` environment beats the file, and this app cannot see the
environment some other process was given. So the settings window shows the file,
says so in its footer, and does not pretend to show effective values.

**Not fighting an existing fleet.** `fleet service install` writes a launchd unit
that runs `fleet up` at login. Somebody with both that and this app gets two
collectors racing for one port, and the loser exits with `EADDRINUSE` — which
the deploy docs already call out as looking, for a moment, exactly like it
worked. So before auto-starting, the app tries to bind the collector's port; if
something already has it, it does not start and the tray says why.

## Why Tauri and not Electron

Electron was the obvious alternative and it is a better-trodden path: the tray,
the notifications and the child process are all APIs this project's authors
already know, and there would be no Rust in the repository at all.

Two things decided it:

- **No second Node runtime.** The sidecar *is* Node. An Electron shell would
  mean two Node runtimes in one app — one supervising, one supervised — with
  their own versions, and a fleet whose whole install story is "Node 22.13 or
  newer, and nothing else" would suddenly ship a different one inside itself.
  Tauri uses the system WebView, so the only runtime in the bundle is the one
  the fleet already needs.
- **Size.** Roughly 200 MB against roughly 10 MB plus the staged fleet tree, for
  an app whose entire UI is one form.

**What would make me switch:** if Tauri's macOS sidecar signing costs more than
a day. An `externalBin` has to be signed and notarised as part of the bundle,
and a shell-script sidecar that execs a system `node` is not a configuration
anybody has written a blog post about. If getting a notarised build that launches
its sidecar turns into a multi-day fight with `codesign`, Electron's
`extraResources` plus `child_process.spawn` is a solved problem and the 200 MB is
worth paying. That is a *measured* threshold, not a feeling: start the timer at
the first `codesign` invocation.

## The couplings this app has, and what breaks them

| It depends on | Where | What breaks it |
|---|---|---|
| The `FleetConfig` shape | `src-tauri/src/config.rs` | A field added to `fleet/src/config.ts` and not here. It survives via `extra`, but the settings window will not show it. |
| The literal string `": GAVE UP -- "` | `sidecar.rs`, `parse_gave_up` | The `onEvent` formatting in `cli.ts`. If it changes, notifications stop silently and nothing else does. There is a unit test asserting the current line. |
| `fleet up` printing supervisor events on stdout/stderr | `sidecar.rs` | The supervisor piping component output into the same stream. It currently pipes children to files, which is what makes the parent's stream parseable at all. |
| `assetRoot()`'s relative layout | `stage-sidecar.sh` | `build.mjs` changing where it puts `bin/` relative to `dash/`. |
| `/dash` and `/api/health` | `config.rs`, `main.rs` | A collector route rename. |

## Status

Be suspicious of this whole directory. **None of the Rust has ever been
compiled**, on this machine or any other — there is no Rust toolchain here
(`cargo` and `rustc` are both absent), so `cargo check` was never run.

What **has** actually been checked:

- Every JSON file validates (`python3 -m json.tool`), and both plists lint
  (`plutil -lint`).
- `ui/app.js` parses (`node --check`), and every element id it reaches for
  exists in `ui/index.html`.
- **The sidecar shim works.** `stage-sidecar.sh` was run, the result was
  arranged into a fake `Contents/MacOS` + `Contents/Resources` layout, and
  `fleet version` and `fleet config` were run through the shim under
  `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` — the Finder environment, with no
  Homebrew on `PATH`. Both worked. That is the piece most likely to be wrong and
  it is the piece that is tested.
- The Rust config struct's serialisation order was compared against real
  `fleet config` output. It matches.

What has **not**:

- **It has never run.** Not the tray, not the settings window, not the sidecar
  under Tauri, not a notification, not the dashboard window. Assume the first
  `cargo check` produces a list of errors; the Tauri 2 APIs most likely to have
  moved are `App::on_menu_event`, `TrayIcon::set_menu`, and
  `tauri::async_runtime::spawn_blocking`. The Cargo package is `fleet-desktop`
  and `productName` is `Fleet`; if the bundler cannot find its binary, that
  mismatch is why, and `mainBinaryName` in `tauri.conf.json` is the knob.
- **The Local Network hypothesis.** See The bet, above. Everything this app is
  *for* rests on it and none of it is tested.
- **Info.plist merging.** That Tauri's bundler merges `src-tauri/Info.plist` into
  the generated one is assumed, not observed. Step 2 of the day-one checklist is
  there because of this.
- **The resource layout.** `bundle.resources` maps `resources/fleet` to `fleet`;
  where that actually lands inside `Contents/Resources` is unconfirmed, which is
  why the shim searches four candidate paths and fails with a message naming
  what it looked for rather than assuming one.
- **Signing and notarisation.** Not attempted. The entitlements are reasoned
  through — `allow-jit` because Node JITs and the hardened runtime kills it
  otherwise, `disable-library-validation` because `fleet up` re-execs itself as
  its own children — but nothing has been signed, and the switch-to-Electron
  threshold above is measured from here.
- **Windows and Linux.** Untouched. `terminate()` on Windows is a no-op with a
  comment saying so, because `TerminateProcess` does not run `fleet up`'s
  `process.on("SIGTERM")` handler and faking a graceful stop would be worse than
  admitting there is not one. The CLI has never been run on either platform
  either.
- **Notification permission.** On macOS this needs a signed, bundled app; an
  unsigned `cargo tauri dev` build may get nothing. The tray headline says the
  same thing without needing permission from anybody, which is the deliberate
  fallback.

MIT — see [LICENSE](../LICENSE).
