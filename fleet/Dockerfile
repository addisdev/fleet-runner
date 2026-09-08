# The whole fleet, containerised.
#
#   docker build -f fleet/Dockerfile -t fleet .          # from the repo root
#   docker run -d --restart unless-stopped -p 8788:8788 \
#     -v fleet-home:/home/fleet/.fleet \
#     fleet up --role brain,agent
#
# ## Why this replaces the agent-only image
#
# `runner-machine/Dockerfile` builds the desktop agent and nothing else: no
# collector, no dashboard, no `fleet` CLI. That is a perfectly good image and it
# is still there, but it is not what somebody typing `docker run ghcr.io/…/fleet`
# expects to get -- they expect the program the release archives contain. This
# builds that, from the same bundle, so the container and the tarball are the
# same thing.
#
# It also makes `--role brain` possible in Docker, which the agent-only image
# could never do. A NAS, a Synology or a Pi with Docker is now a place a whole
# fleet can live rather than only a device that joins one.
#
# ## Multi-arch by construction
#
# The base image is multi-platform and **nothing here compiles native code** --
# which is true only since the collector's database became `node:sqlite` rather
# than `better-sqlite3`. That is the change that turned "a build per
# architecture, per Node ABI, with a prebuild service in the middle" into
# `docker build --platform linux/arm64` from an x86 laptop.
#
# ## What is NOT in it
#
# Playwright, and therefore the four web workloads. It is 400 MB of browser that
# a brain has no use for, `src/browser.ts` makes the import dynamic so nothing
# fails to start without it, and `fleet doctor` says so in a sentence. An image
# that needs them should install them in a layer of its own.
#
# STATUS: built, never run. The release workflow built and pushed it for
# linux/amd64 and linux/arm64 at v0.5.0, so the file is at least correct enough
# to assemble. Nothing has started a container from it -- Docker was not
# available on the machine that wrote it -- so whether `fleet up` actually comes
# up inside one is unknown.

# --- build the bundle ------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /src

# The dashboard first, because it is the slowest step and changes least often.
# Its output is optional -- the collector serves a "run the build" page without
# it -- but an image that shipped without a dashboard would be a worse default
# than one that takes another minute to build.
COPY collector/package.json collector/package-lock.json ./collector/
COPY collector/dash/package.json collector/dash/package-lock.json ./collector/dash/
RUN npm --prefix collector ci --ignore-scripts \
 && npm --prefix collector/dash ci --ignore-scripts

COPY fleet/package.json fleet/package-lock.json ./fleet/
RUN npm --prefix fleet ci --ignore-scripts

# esbuild's binary comes from a postinstall, which --ignore-scripts skipped.
# Named explicitly rather than dropping --ignore-scripts wholesale: an image
# build is exactly where an unexpected postinstall should not run.
RUN npm --prefix fleet rebuild esbuild

COPY VERSION ./
COPY collector ./collector
COPY runner-machine ./runner-machine
COPY fleet ./fleet

RUN npm --prefix collector run dash:build \
 && node fleet/build.mjs

# --- the image itself ------------------------------------------------------
FROM node:22-bookworm-slim

# git for the `build` workload's checkouts, ca-certificates so artifact
# downloads over TLS work, and tini so a `docker stop` reaches the supervisor as
# a signal rather than being swallowed by PID 1 -- which matters more here than
# in the agent-only image, because the supervisor's whole job is to pass that
# signal on to its children and wait for them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*

# Never root. The fleet makes outbound HTTP requests, listens on one port and
# writes to its own directory; a container that can do more than that is a
# container that can do more than that.
RUN useradd --create-home --uid 10001 fleet
USER fleet
WORKDIR /app

COPY --from=build --chown=fleet:fleet /src/fleet/dist /app

ENV FLEET_HOME=/home/fleet/.fleet
# Bind to every interface inside the container. The container's network is the
# boundary here, not the process's -- `-p 8788:8788` is the decision, and a
# loopback bind would make the published port answer nothing at all.
ENV FLEET_BIND=0.0.0.0
EXPOSE 8788

# Everything a running fleet keeps: the database, the artifact store, the
# config and the logs. Mount it, or a `docker rm` takes the fleet's history.
VOLUME ["/home/fleet/.fleet"]

# A health check the orchestrator can read, rather than "the process is alive".
# A collector whose port is bound but whose database will not open is exactly
# the failure that looks healthy from the outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLEET_PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/bin/fleet.mjs"]
CMD ["up", "--role", "brain,agent"]
