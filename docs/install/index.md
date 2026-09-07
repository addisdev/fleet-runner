# Install

There is one command, and it is the same command whether this machine is going
to be the brain, a runner, or both:

```
fleet up
```

Everything on this page is about getting `fleet` onto the machine so that you
can type it.

!!! warning "No release has been published yet, so `curl | sh` does not work"

    `install.sh` and `install.ps1` are written, and they have been exercised
    against locally built archives -- checksum verified, a tampered archive
    refused, a re-install leaving config and data intact. **Neither has ever
    met a real GitHub release, because there is not one.** There are no tags,
    no archives and no `SHASUMS256.txt` on the releases page.

    What actually happens if you run the one-liner today is that
    `install.sh` asks `api.github.com` for the latest release, gets nothing back
    that looks like a tag, and stops with:

    ```
    install.sh: could not work out the latest version from
      https://api.github.com/repos/addisdev/fleet-runner/releases/latest.
      Either there is no published release yet, or this address is rate limited.
    ```

    That is the correct behaviour and it is also a dead end. **Until a release
    exists, build from a checkout** -- every platform page below has that path,
    and on macOS it is the path that has actually been run.

## Pick your machine

| | The one command | State |
|---|---|---|
| **[macOS](macos.md)** | `curl -fsSL …/install.sh \| sh` | The installer has never met a real release. **`fleet up` from a checkout and from a locally built bundle is the one path that has been watched to work**, on macOS/arm64 |
| **[Windows](windows.md)** | `irm …/install.ps1 \| iex` | Installer untested against a release. **The `fleet` CLI has never been run on Windows at all** -- not the paths, not the process handling, not the service backend |
| **[Linux](linux.md)** | `curl -fsSL …/install.sh \| sh` | Installer untested against a release. **The CLI has never been run on Linux either.** The machine agent's own suite passes on x64 and arm64 Linux in CI, which is a different claim |
| **[Docker](docker.md)** | `docker run ghcr.io/addisdev/fleet` | **Neither Dockerfile has ever been built**, and no image has been pushed. Docker was not available on the machine that wrote them |
| **[Devices](devices.md)** | -- | How a phone, a television, a Roku or a browser joins a fleet that is already up |

## What the installers do, and what they refuse to do

Both scripts do the same five things in the same order, and the reasoning is
written into both files:

1. Work out `os` and `arch` from `uname` (or `PROCESSOR_ARCHITECTURE`), and
   refuse anything not built, naming the checkout as the alternative.
2. **Check for Node 22.13 or newer on `PATH`.** The release carries no runtime.
   `fleet/src/paths.ts` reserves `~/.fleet/runtime` for a private Node and the
   release workflow builds none, so the installers deliberately do not look for
   one -- an installer that preferred a runtime the workflow never produced
   would fail on a machine with no Node while saying something untrue. 22.13 is
   where `node:sqlite` stopped needing a flag, and the collector's database is
   `node:sqlite`.
3. Download `fleet-<version>-<os>-<arch>.tar.gz` (or `.zip`) **and**
   `SHASUMS256.txt`, and **refuse to install if the checksums disagree, or if
   `SHASUMS256.txt` cannot be fetched at all.** There is no `--force` past this.
4. Unpack into `~/.fleet` (`FLEET_INSTALL_DIR` moves it), replacing only the
   entries a release owns -- `bin`, `runner-web`, `dash`, `examples`,
   `schemas`. It never removes the directory itself, because
   `~/.fleet` is also where `config.json`, `data/`, `artifacts/` and `logs/`
   live, and an upgrade that deletes your results is worse than one that fails.
5. Run `fleet version` from the thing it just installed. If the bundle is
   broken the install fails there rather than the first time you type
   `fleet up`.

**No sudo, and no administrator rights.** Nothing is written outside the install
directory, with one exception: `install.ps1` adds the `bin` directory to the
*user* `PATH` in `HKCU`, which needs no elevation. `install.sh` does not edit
any dotfile at all -- it prints the `export PATH=…` line and the file to put it
in, and leaves that to you. If either script triggers an elevation prompt,
something is wrong; stop and read it.

## Everything lives in one directory

```
~/.fleet/
  config.json      what fleet up reads; `fleet config set` writes it
  bin/             fleet.mjs, and a `fleet` symlink (a fleet.cmd shim on Windows)
  data/            fleet.db, and collector.json -- this brain's name and id
  artifacts/       build products, screenshots, everything a job published
  logs/            one per supervised component
  cache/
  runtime/         reserved for a private Node. Nothing puts one here yet
```

One path on every platform rather than the three the platforms each ask for.
`FLEET_HOME` moves it, and the Docker image sets it to `/home/fleet/.fleet` so
that one volume mount covers a fleet's entire history.

## The two environment variables both installers read

| | |
|---|---|
| `FLEET_VERSION` | Install a specific release rather than asking for the latest. This also skips the `api.github.com` call, which is the unauthenticated 60-per-hour limit shared by everything behind one NAT |
| `FLEET_INSTALL_DIR` | Where the release is unpacked *into*. It is not the `bin` directory and cannot be: `fleet` resolves `runner-web/` and `dash/dist/` relative to its own location, so installing the binary alone gives you a collector that serves a blank dashboard |

## Nothing is signed

There is no Developer ID certificate, no Windows signing certificate and no App
Store Connect key in this repository's secrets, and `release.yml` says so rather
than referencing one and failing from the first tag. The consequence is
concrete: **macOS Gatekeeper will quarantine an archive downloaded in a
browser.** `install.sh` sidesteps that only because `curl` does not set the
quarantine attribute. There is no Homebrew tap, no winget manifest and no Scoop
manifest, for the same reason -- each needs a repository nothing here can push
to.

## Then what

- **[`fleet up`](../getting-started.md)** -- a brain, a runner, and a real
  result row, which is the point of the whole thing.
- **[Devices](devices.md)** -- adding a phone, a television, a Roku or a
  browser to a fleet that is already running.
- **[Deploy](../deploy/index.md)** -- keeping it up, and the network gotcha
  that costs an evening.
