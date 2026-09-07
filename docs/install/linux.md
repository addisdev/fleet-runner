# Install on Linux

```bash
curl -fsSL https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.sh | sh
```

!!! danger "Two separate things are untested here"

    **No release has been published**, so there is no archive to download and no
    `SHASUMS256.txt` to check it against. The script asks `api.github.com` for
    the latest release, finds nothing, and stops. Use [from a
    checkout](#from-a-checkout) or [Docker](docker.md).

    **And the `fleet` CLI has never been run on Linux.** Not the CLI, not the
    supervisor, not the bundle, not the systemd service backend. The paths, the
    process handling and the service code are written and untested.

    What *has* been exercised on Linux is [the machine
    agent](../platforms.md#what-a-cloud-runner-actually-reports): its own suite
    runs on x64 and arm64 Linux in CI, and the arm64 descriptor comes back
    near enough complete -- only `soc` is missing, because `/proc/cpuinfo` on
    arm64 has no `model name` line. That is a real result about the agent and
    says nothing about `fleet`. **No board has ever registered against a real
    collector.**

**You need Node 22.13 or newer on `PATH`.** The release carries no runtime, and
your distribution's `nodejs` package is very often older than 22.13 -- Debian
stable and Ubuntu LTS both are. NodeSource, nvm, or a tarball from nodejs.org
all work; the installer does not care which, only that `node -v` answers 22.13
or newer. That version is where `node:sqlite` lost its experimental flag, and
the collector's database is `node:sqlite`.

`curl` or `wget`, whichever is there. The `curl` path passes
`--proto '=https' --tlsv1.2` so that a plaintext redirect is an error rather
than a fallback -- this script downloads something it is about to execute.

**No sudo.** Everything is written under `~/.fleet`. No dotfile is edited: the
script prints the `export PATH=…` line and names the file for your shell, and
leaves it to you. If you point `FLEET_INSTALL_DIR` at a system path, create it
and make it yours first -- the script will not escalate to do it for you.

## From a checkout

```bash
git clone https://github.com/addisdev/fleet-runner
cd fleet-runner

npm --prefix collector install
npm --prefix runner-machine install
npm --prefix fleet install

npm --prefix collector run dash:install
npm --prefix collector run dash:build

node fleet/build.mjs
node fleet/dist/bin/fleet.mjs up
```

Three installs, because in a checkout `fleet up` spawns each component's own
entry point rather than importing it. Nothing in that sequence compiles native
code -- the collector's database is Node's own `node:sqlite`, and there is no
addon anywhere in the tree -- so an install cannot fail on a toolchain the
machine does not have. That is also what makes a Raspberry Pi or a Jetson
plausible without a cross-compiler in sight.

If a board is what you have, [Docker](docker.md) is the shorter road: one
`docker build --platform linux/arm64` from an x86 laptop produces an arm64
image, because nothing in it compiles.

## `fleet up`

```bash
fleet up
```

You should see this -- the banner is platform-independent, and this is the
macOS one with the paths changed:

```
fleet 0.5.0-dev
  home     /home/you/.fleet
  roles    brain, agent
  brain    http://127.0.0.1:8788  (bind 0.0.0.0)
  agent    -> http://127.0.0.1:8788

19:22:41  brain: start pid 7412
19:22:41  agent: start pid 7413
```

**If it does not, that is the finding**, and it is worth an issue. Then:

```bash
fleet status
fleet doctor
```

`fleet doctor` first, on a platform nobody has run this on. A Linux box will
report no Xcode and quite possibly no `adb`, and both are `?` lines rather than
failures -- it exits 0 regardless, because a machine that cannot build for iOS
is not a broken machine.

## A board on someone else's brain

A Pi does not have to be a fleet. It can be one device on a fleet whose brain is
elsewhere:

```bash
fleet join http://fleet-host.local:8788
```

which runs the agent role only and writes that collector down, so the next
`fleet up` remembers. `fleet join --discover` looks for one on the local network
over mDNS instead -- but that needs the brain to have discovery turned on, which
is off by default. See [devices](devices.md#finding-a-brain-instead-of-typing-one).

## Keeping it up

```bash
fleet service install
```

On Linux the backend is a **systemd user unit**, written to
`~/.config/systemd/user/fleet.service`. A user unit rather than a system one,
because nothing in this project needs root, a privileged port or `/usr/local`.

Note what that costs: a user unit runs at login, not at boot, unless you enable
lingering for the account (`loginctl enable-linger <user>`). A headless Pi that
reboots unattended and is never logged into will otherwise sit there running
nothing.

**`fleet service install` has never been run on any platform.** Every path it
writes is resolved absolutely, because systemd expands no `~` and reads no login
`PATH` -- and none of it has been watched start. [Headless
hosts](../deploy/headless.md) has the older, actually-deployed alternative.

## Next

- **[Get started](../getting-started.md)** -- a real job and a real result row.
- **[Docker](docker.md)** -- the same program in a container, for a NAS or a
  board.
- **[Platforms](../platforms.md)** -- the honest column.
