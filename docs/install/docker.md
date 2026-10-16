# Install with Docker

```bash
docker run -d --restart unless-stopped -p 8788:8788 \
  -v fleet-home:/home/fleet/.fleet \
  ghcr.io/addisdev/fleet up --role brain,agent
```

!!! note "Run by CI on every pull request, on amd64"

    Every release builds and pushes `ghcr.io/addisdev/fleet` for linux/amd64 and
    linux/arm64, tagged with the version and `latest`.

    `container smoke` in CI builds the same Dockerfile on linux/amd64, starts it
    with `up --role brain,agent` on a fresh volume, waits for `/api/health`,
    then waits for the container's own
    machine agent to register and checks `fleet devices`, `fleet workloads` and
    `fleet whoami` against it. Its first run found that the image could not
    start on a fresh volume (the directory was created root-owned), fixed in
    0.8.0. `container smoke (arm64)` does the same on linux/arm64, built
    natively on GitHub's arm64 runner rather than under QEMU, and checks the
    container reports `aarch64`. That is a cloud VM, not a board: if you run it
    on a NAS or a Raspberry Pi, an issue saying how it went is welcome either
    way.

    `runner-machine/Dockerfile`, the agent-only image, is still **not built at
    all**: nothing publishes it and nobody has run `docker build` on it.

## Build it yourself

From the repository root, because the build stage copies `collector/`,
`runner-machine/` and `fleet/` -- the bundle is all three:

```bash
docker build -f fleet/Dockerfile -t fleet .
docker run -d --restart unless-stopped -p 8788:8788 \
  -v fleet-home:/home/fleet/.fleet \
  fleet up --role brain,agent
```

Then:

```bash
curl -s http://127.0.0.1:8788/api/health
```

```json
{ "ok": true, "collector": "81fcc8c99b4559f4", "name": "…", "instance": "…",
  "started_at": "…", "uptime_s": 3, "now": "…", "node": "v22.13.0",
  "pid": 1, "stream_clients": 0, "guard": false }
```

and the dashboard at <http://127.0.0.1:8788/dash>.

## Two images, and which one you want

| | What is in it | Use it when |
|---|---|---|
| `fleet/Dockerfile` | The whole program: collector, machine agent, host executor, dashboard, browser runner. Published as `ghcr.io/addisdev/fleet` | The container is the fleet, or the fleet and a device. A NAS, a Synology, a Pi |
| `runner-machine/Dockerfile` | The desktop agent and nothing else | The brain is somewhere else and this container is only a device on it |

The agent-only image came first and is still there, but it is not what somebody
typing `docker run ghcr.io/…/fleet` expects to get -- they expect the program
the release archives contain. `fleet/Dockerfile` builds that, from the same
bundle, so the container and the tarball are the same thing. It is also what
makes `--role brain` possible in Docker at all.

## Multi-arch, and why that is suddenly easy

```bash
docker build --platform linux/arm64 -f fleet/Dockerfile -t fleet:arm64 .
```

from an x86 laptop. **Nothing in the image compiles native code**, which is true
only since the collector's database became `node:sqlite` rather than
`better-sqlite3`. That one change turned "a build per architecture, per Node
ABI, with a prebuild service in the middle" into a flag.

The release workflow builds `linux/amd64` and `linux/arm64` under QEMU for the
same reason: the only emulated work is `apt` and `npm ci`, so the usual
objection to QEMU does not apply here.

## What the image does and does not do

- **Never root.** A `fleet` user at uid 10001. The fleet makes outbound HTTP
  requests, listens on one port and writes to its own directory; a container
  that can do more than that is a container that can do more than that.
- **`tini` as PID 1**, so a `docker stop` reaches the supervisor as a signal
  rather than being swallowed. That matters more here than in the agent-only
  image, because the supervisor's whole job is to pass the signal on to its
  children and wait for them.
- **`FLEET_BIND=0.0.0.0` inside the container.** The container's network is the
  boundary, not the process's -- `-p 8788:8788` is the decision you are making,
  and a loopback bind would make the published port answer nothing at all.
  Everything in [binding and exposure](../deploy/index.md#binding-and-exposure)
  still applies to the *host* side of that mapping. **There is no
  authentication by default**. [Authentication](../deploy/auth.md) turns it
  on: `-e FLEET_AUTH=tokens`, and the first token created inside the container,
  `docker exec <container> node /app/bin/fleet.mjs token create ops --scope admin`,
  so it lands on the volume. Nobody has done that in a container yet.
- **A `HEALTHCHECK` that asks `/api/health`** rather than checking the process is
  alive. A collector whose port is bound but whose database will not open is
  exactly the failure that looks healthy from the outside.
- **No Playwright**, and therefore none of the four web workloads. It is 400 MB
  of browser a brain has no use for; the import is dynamic so nothing fails to
  start without it, and `fleet doctor` says so in a sentence. An image that needs
  them should install them in a layer of its own.

## Mount the volume, or lose everything

```
-v fleet-home:/home/fleet/.fleet
```

That directory is the database, the artifact store, the config and the logs.
Without the mount, a `docker rm` takes the fleet's entire history with it. The
image declares it as a `VOLUME`, so Docker will create an anonymous one rather
than losing the data outright -- but an anonymous volume is one nobody can find
again, which is most of the way to the same outcome.

## Next

- **[Get started](../getting-started.md)** -- a real job and a real result row.
- **[Devices](devices.md)** -- adding phones and televisions to the brain the
  container is now running.
- **[Deploy](../deploy/index.md)** -- what to think about before the port is
  reachable by anything.
