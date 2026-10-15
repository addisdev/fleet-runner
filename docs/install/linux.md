# Install on Linux

```bash
curl -fsSL https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.sh | sh
```

!!! warning "What has been run on Linux, and what has not"

    **`install.sh` has not been run against a release on Linux.** Releases
    publish `linux-x64` and `linux-arm64` archives with `SHASUMS256.txt`, and the
    script has been run against a real release on macOS; the Linux branch of it
    has not been watched.

    **The `fleet` CLI has been run on Linux only by CI.** Every pull request
    that touches it runs the CLI's suite on `ubuntu-latest`, including the
    supervised `fleet up` end to end. Two smoke jobs go further:
    `systemd smoke` installs the built bundle as a systemd user service, waits
    for its collector to answer, and uninstalls it; `container smoke` starts the
    [Docker image](docker.md) and waits for its machine agent to register. That
    is a real result, and it is not the same as somebody running a fleet on a
    Linux machine for a week.

    What *has* been exercised on Linux is [the machine
    agent](../platforms.md#what-a-cloud-runner-actually-reports): its own suite
    runs on x64 and arm64 Linux in CI, and the arm64 descriptor comes back
    near enough complete -- only `soc` is missing, because `/proc/cpuinfo` on
    arm64 has no `model name` line. **No board has ever registered against a
    real collector.**

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

**`fleet service install` on systemd is checked by CI, not by a deployment.**
On macOS it runs a real fleet's brain. On Linux, `systemd smoke` installs the
user unit on GitHub's Ubuntu runner, checks it with `systemd-analyze verify`,
waits for the collector it starts to answer, and uninstalls it. What that does
not cover is a reboot: the job enables lingering and starts the unit, and
nobody has watched it come back at boot on a real machine. Every path it writes
is resolved absolutely, because systemd expands no `~` and reads no login
`PATH`. [Headless hosts](../deploy/headless.md) has the older,
actually-deployed alternative.

## Next

- **[Get started](../getting-started.md)** -- a real job and a real result row.
- **[Docker](docker.md)** -- the same program in a container, for a NAS or a
  board.
- **[Platforms](../platforms.md)** -- the honest column.
