# Install on Windows

```powershell
irm https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.ps1 | iex
```

!!! danger "Two separate things are untested here, and the second one matters more"

    **No release has been published**, so there is nothing for that line to
    download. It will ask `api.github.com` for the latest release, fail, and
    stop with a message naming the releases page and `$env:FLEET_VERSION`.

    **And the `fleet` CLI has never been run on Windows at all.** Not the CLI,
    not the supervisor, not the bundle, not the scheduled-task service backend.
    The paths, the process handling and the service code are written and
    untested. `fleet.yml` declares a three-platform matrix that has never
    executed.

    What *has* been exercised on Windows is [the machine
    agent](../platforms.md#what-a-cloud-runner-actually-reports): its own suite
    runs on `windows-latest` in CI, and the descriptor it sends from there is
    printed and recorded. That is a real result about the agent and says nothing
    about `fleet`.

    Everything below is written from the source. Treat it as a plan, not a
    procedure, and please [send a device
    report](https://github.com/addisdev/fleet-runner/issues) if you run it.

**You need Node 22.13 or newer on `PATH`.** The release carries no runtime.
`winget install OpenJS.NodeJS.LTS`, nvm-windows, or nodejs.org -- all fine. An
older Node does not fail politely: 22.13 is where `node:sqlite` lost its
experimental flag, the collector's database is `node:sqlite`, and an older
runtime fails at the first query.

**No administrator rights.** Everything is written under `%USERPROFILE%\.fleet`,
and the only thing touched outside it is the *user* `PATH` in `HKCU`, which is
per-user and needs no elevation. Nothing installs a service, writes to Program
Files, or touches the machine `PATH`. If Windows prompts you for administrator
rights while this runs, something is wrong; stop and read it.

Three details the script gets right that are easy to get wrong by hand:

- It reads `PROCESSOR_ARCHITEW6432` before `PROCESSOR_ARCHITECTURE`, because a
  32-bit PowerShell host on 64-bit Windows reports `x86` in the obvious one --
  which is how an arm64 machine ends up being told it is unsupported.
- It pins TLS 1.2 first. Windows PowerShell 5.1 negotiates whatever
  `ServicePointManager` was left set to, and github.com has refused SSL3 and
  TLS 1.0 for years. The symptom is "Could not create SSL/TLS secure channel",
  which reads like a network fault rather than a protocol one.
- `fleet` is a `.cmd` shim, not a symlink. A real symlink on Windows needs
  developer mode or elevation and this installer asks for neither; `PATHEXT`
  makes `fleet.cmd` runnable as plain `fleet`.

## From a checkout

Until a release exists, this is the only path. It has never been run on Windows
either, but it has no archive to download and no `PATH` registry entry to write,
so there is less of it to be wrong.

```powershell
git clone https://github.com/addisdev/fleet-runner
cd fleet-runner

npm --prefix collector install
npm --prefix runner-machine install
npm --prefix fleet install

npm --prefix collector run dash:install
npm --prefix collector run dash:build

node fleet\build.mjs
node fleet\dist\bin\fleet.mjs up
```

Three installs because in a checkout `fleet up` spawns each component's own
entry point rather than importing it. The `build.mjs` step is optional -- `cd
fleet; npm start -- up` runs from source -- but building the bundle is closer to
what a release would be, so a failure there is a more useful failure.

There is **no native code anywhere in this tree**, which is why running the
collector on Windows is plausible at all. It used to need `better-sqlite3`, a
native addon with a per-OS, per-architecture, per-Node-ABI prebuild, and that is
the single reason the collector had never once run on Windows -- nothing in it
was macOS-specific, nobody wanted to find out what the addon did over there.

## `fleet up`

```powershell
fleet up
```

You should see this -- the banner is platform-independent, and this is the
macOS one with the paths changed:

```
fleet 0.5.0-dev
  home     C:\Users\you\.fleet
  roles    brain, agent
  brain    http://127.0.0.1:8788  (bind 0.0.0.0)
  agent    -> http://127.0.0.1:8788

19:22:41  brain: start pid 7412
19:22:41  agent: start pid 7413
```

**If it does not, that is the finding.** The supervisor spawns `fleet
collector` and `fleet agent` as child processes and re-execs this program to do
it; process spawning and path resolution are exactly where a first Windows run
would break.

Then:

```powershell
fleet status
fleet doctor
```

`fleet doctor` is the one to run first on a platform nobody has run this on. It
prints what the machine can do and, for everything it cannot, why not -- and it
exits 0 either way, so a machine with no Android SDK is reported rather than
treated as broken.

## Keeping it up

```powershell
fleet service install
```

On Windows the service backend is **`schtasks`**, registering a task that runs
`fleet up` at logon. It is not a Windows Service: a service would need
elevation, and nothing else in this project does.

**`fleet service install` has never been run on any platform**, and the Windows
backend is the least exercised of the three. See [headless
hosts](../deploy/headless.md).

## What is deliberately absent

No winget manifest and no Scoop manifest. Each needs a repository this project's
release workflow has permission to push to, and none exists; a workflow step
referencing one would fail from the first tag. No code signing either, for the
same reason -- there is no Windows signing certificate in this repository's
secrets.

## Next

- **[Get started](../getting-started.md)** -- a real job and a real result row.
- **[Devices](devices.md)** -- adding a phone, a television or a browser.
- **[Platforms](../platforms.md)** -- the honest column, including what a
  Windows machine agent actually reports about itself.
