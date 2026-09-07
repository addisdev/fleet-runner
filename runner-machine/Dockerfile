# The machine runner, containerised -- the AGENT ONLY.
#
# For the whole program -- collector, dashboard, agent and the `fleet` CLI --
# use `fleet/Dockerfile`, which is what `ghcr.io/addisdev/fleet` publishes. This
# one stays because "a device that joins somebody else's fleet" is a smaller and
# genuinely different thing to want, and it is the image to reach for when the
# brain is elsewhere.
#
# One command turns any Linux box, NAS, Synology, Pi or cloud instance with
# Docker into a fleet device:
#
#   docker build -t fleet-runner-machine runner-machine/
#   docker run -d --restart unless-stopped \
#     -e FLEET_URL=http://fleet-host.local:8788 \
#     -e FLEET_DEVICE_ID=nas-downstairs \
#     fleet-runner-machine
#
# Multi-arch by construction: the base image is multi-platform and nothing here
# compiles native code, so `docker build --platform linux/arm64` produces a
# working image for a Raspberry Pi or a Jetson from an x86 laptop.
#
# ## What a container changes about honesty
#
# Two things, and both are handled in the agent rather than here.
#
# The descriptor's chassis probes answer questions about hardware, and inside a
# container the hardware belongs to somebody else -- so `processKind()` detects
# /.dockerenv and reports `kind: "container"`, overriding whatever the DMI
# tables said. A container reporting "desktop" would sit on the shelf beside
# machines that are still there tomorrow.
#
# And the capability probes ask what is INSTALLED, which in an image is exactly
# what this file put there. That is the point: an image with no llama.cpp
# declares `benchmark` and `self-check` and claims nothing it cannot run, which
# is the same answer the probes give on a bare laptop.

FROM node:22-bookworm-slim

# git for the `build` workload's checkouts, ca-certificates so artifact
# downloads over TLS work, and tini so a `docker stop` reaches the agent as a
# signal rather than being swallowed by PID 1. Nothing else: every package here
# is one the capability probes will find and declare.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json ./
# --ignore-scripts: nothing in this dependency tree needs a postinstall, and an
# image build is exactly where an unexpected one should not run.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY recipes ./recipes

# Never root. The agent needs no privilege: it makes outbound HTTP requests and
# writes to its own cache directory, and a container that can do more than that
# is a container that can do more than that.
RUN useradd --create-home --uid 10001 fleet \
 && mkdir -p /var/lib/fleet \
 && chown -R fleet:fleet /app /var/lib/fleet
USER fleet

# Written to on every job that fetches a model or checks out a repository.
# Mount a volume here to keep the cache across restarts:
#   -v fleet-cache:/var/lib/fleet
ENV FLEET_CACHE_DIR=/var/lib/fleet
VOLUME ["/var/lib/fleet"]

# The collector is not guessed. An agent that defaulted to some address would
# either find nothing or, worse, find somebody else's fleet.
ENV FLEET_URL=""

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "src/agent.ts"]
