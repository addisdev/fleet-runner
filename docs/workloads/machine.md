# Machine workloads

Claimed by a
[desktop agent](https://github.com/addisdev/fleet-runner/tree/main/runner-machine)
— a laptop or desktop that has joined the fleet. These produce things the rest
of the fleet consumes, or inspect the fleet itself.

A machine is schedulable around, which is most of the point: `require_ac`,
`require_idle_s` and `max_load` read its beacon, so work waits for an idle box
on mains rather than starting while somebody is typing. See
[Constraints](../concepts.md#constraints).

## `build`

Check out a ref, build it, and publish the product as an artifact the next
`install` can name.

```json
{ "workload": "build", "executor": "device",
  "params": { "repo": "git@github.com:you/app.git", "ref": "main",
              "kind": "gradle", "task": "assembleRelease", "app": "app-android" } }
```

`kind: "xcode"` takes `scheme` instead of `task`, plus optional `configuration`
and `destination`. `kind: "npm"` runs `npm run <task>` (default `build`) and
publishes what `npm pack` makes of it. `artifact` names the product outright
when it is somewhere the defaults do not look.

**Metrics:** `build_s`, `artifact_bytes`.

Repos are cloned once into `FLEET_CACHE_DIR/repos/<name>-<hash of the remote>`
and fetched thereafter. The cache name is hashed because two remotes can both
end in `app.git`.

The build's stdout is tailed into a beacon every 30 s, which is what renews the
lease under a long Xcode build.

!!! note "A failed build's log is uploaded anonymously, on purpose"

    A log published under the app's name would become the thing a nightly asking
    for `"sha256": "latest"` picks up. The failing task or scheme is named in
    `error` instead.

Publishing is `POST /artifacts` with `x-artifact-app`, `x-artifact-build` and
`x-artifact-platform`. Those headers are what stamp the ordering that
`"latest"` reads; there is no separate publish endpoint.

`report_to.github_status` gets a `pending` at claim and a terminal state at the
end, under the context `fleet-runner/build`. The token comes from this
machine's own environment, never from the job spec. The separate context matters
because the collector posts its own terminal status under `fleet-runner`, and
sharing a context would mean two writers racing over one check.

## `model-convert`

Turns a checkpoint into GGUF, Core ML or TFLite on a machine with the memory for
it, uploading each output so a dependent job can name it with
`${jobs.<id>.artifact}`.

Reports `model_out` — format, quant, name, sha256 and bytes — as a named field
rather than in `metrics`, because it is structured rather than scalar.

## `dataset-prep`

Builds an eval set and **carries its licence and source on the row**. A prepared
set that loses its licence is one nobody can publish results from, which is the
whole reason this is a workload rather than a script somebody ran once.

## `serve`

Hosts a model for the length of a lease and announces its endpoint, so a
dependent job can consume it.

The endpoint is bound to **loopback or the tailnet, never `0.0.0.0`** — an
unauthenticated inference server on a laptop's hotel wifi is a different product
to the one anybody asked for.

## `shell`

Runs a pinned script. This is the one workload that cannot take the collector's
word for anything, because `POST /jobs` is unauthenticated by design.

The gating, in order:

1. The owner pins a sha256 by hand in a local allowlist file.
2. **The capability is declared only when that file exists and is non-empty.** A
   machine that has pinned nothing cannot be *offered* the job at all, rather
   than claiming it and refusing afterwards — refusing after the claim would
   still take the work off the queue.
3. The sha is checked **before** the artifact is fetched, never after.
4. A value that is not a well-formed sha256 is refused, which matters because
   that value arrives from an attacker-controllable job spec.

## `self-check`

The fleet inspecting its own hosts: disk, tool versions, NTP offset, and whether
the agent that is running is the one that is installed.

**Metrics:** `disk_free_gb`, `clock_offset_ms`, `checks_failed`, plus a
per-check breakdown in a named `checks` field.

Clock drift is on the list because every timestamp in the results database comes
from the machine that produced it, and a host an hour off makes a benchmark
trend meaningless in a way nothing else would reveal.

## What is not proven yet

Stated rather than implied, because the capability probes are honest and the
docs should be too:

- **`model-convert`, `dataset-prep` and `serve` have never run against a real
  toolchain.** None of the converters resolves on the development machine, the
  probes correctly decline to declare them, and the command lines are
  unit-tested rather than exercised.
- **`build` has only been run for `kind: "npm"`.** The gradle and xcode command
  lines are unit-tested but have never driven a real compiler.
- **The llama.cpp benchmark backend** is unit-tested against `llama-bench`'s
  documented JSON shape and has never run against a real binary.
- **`benchmark:mlx` has no backend at all.** The probe exists and correctly
  never declares it. It is a good first contribution.
- **The Windows probes are untested on Windows.**
