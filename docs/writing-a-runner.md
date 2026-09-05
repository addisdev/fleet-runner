# Writing a runner

An agent is a loop around five HTTP calls. This page is about the decisions that
make one *good*, using
[`runner-machine/`](https://github.com/addisdev/fleet-runner/tree/main/runner-machine)
as the worked example — it is the smallest of the three, it is plain TypeScript,
and it runs on the machine you are reading this on.

Read [the protocol](protocol.md) first for the wire format.

## Declare and dispatch from one list

The single most useful structural decision in all three runners: **the
capabilities you register and the dispatch that runs them come from the same
table.**

```kotlin
private fun routes(client: CollectorClient, deviceId: String) = listOf(
    Route("benchmark",    "benchmark")            { BenchmarkEngine(…).run(it) },
    Route("batch",        "batch")                { BatchEngine(…).run(it) },
    Route("batch:litert", "batch", "litert")      { VisionEvalEngine(…).run(it) },
    Route("pipeline",     "pipeline")             { PipelineEngine(…).run(it) },
    Route("thermal",      "thermal")              { ThermalEngine(…).run(it) },
)
```

Registration sends `routes.map { it.capability }`. Dispatch looks up
`routes.firstOrNull { … }`. Declaring a workload and being able to run it are
one act.

The alternative — a hand-kept capability list sitting next to a `when` — is a
pair of things that agree only until somebody edits one of them, and **the
failure is silent in the worst direction**: the collector routes you work you
bounce straight back as "not supported by this runner yet". You find out from a
failed nightly.

A route naming a backend wins over the workload's general route. That is what
makes `batch` with `backend: "litert"` reach the vision eval while plain `batch`
reaches the generic engine.

## Declare a capability only when it is true

The desktop agent probes rather than assumes:

- `benchmark:llama.cpp` needs a resolvable `llama-bench`.
- `benchmark:mlx` needs `import mlx_lm` to exit 0.
- `build:gradle`, `build:xcode` and `build:npm` each need their binary.
- A machine with none of them still declares `benchmark` and `self-check`,
  because neither needs anything installed.

This is a safety mechanism, not tidiness. A capability claimed here that the
machine cannot honour is a job the queue hands over and the agent bounces —
which looks, from the dashboard, exactly like a broken workload.

!!! note "One capability is both a claim and a label"

    `build` rides along with any specific kind. The collector matches a claim on
    the workload name, and a build job carries its `kind` in `params`, where
    capability matching cannot see it — so a machine declaring only
    `build:gradle` would never claim a build at all. Declare the bare workload
    too when the specific forms are a refinement rather than the whole set.

## Make your numbers comparable

Every runner here implements a `synthetic` backend: a SHA-256 digest loop, sized
in "tokens", **identical on every platform token for token**. It is not an LLM
and the runners never present it as one.

Its purpose is that a 2019 Android phone, a current iPhone and a laptop produce
numbers that belong in the same table. That is the difference between a fleet
and a pile of phones, and it is the reason a device too slow to run a model is
still worth having on the shelf.

If you write a runner for a new platform, **port the synthetic backend exactly**
before anything else. It is the calibration.

## Refuse rather than approximate

The most valuable behaviour in this codebase is declining to produce a number.
Some real examples:

- **The iOS runner forces CPU on simulators, and labels it.** The Simulator's
  emulated GPU returned an all-zero logits tensor for the plant-ID model —
  silently, no error — while `.cpuOnly` matched the Mac exactly. Only a second
  device disagreeing ever caught it.
- **`mem_method` names the measurement.** Off Linux the desktop agent reports
  `max_rss` even though the collector's schema does not list it, because calling
  an RSS reading `pss` would be laundering.
- **Network shaping refuses what it cannot do.** `3g` on a real phone is refused
  rather than approximated, because in-device shaping needs root and host
  shaping only affects traffic that transits the Mac.
- **An unknown profile name throws.** A typo that silently ran unshaped would
  turn an offline test into a test that proves nothing and still passes.

The pattern: when you cannot measure the thing asked for, **fail with a message
naming what is missing**. A wrong number recorded as a result is worse than a
failure, because a failure gets investigated.

## Handle these four things and you are done

**Long-poll properly.** A `204` is normal, not an error. Reconnect immediately.
Back off only on transport failures, and log the backoff so a silent agent is
distinguishable from a dead one.

**Beacon more often than the lease.** The beacon is what keeps the claim alive;
the reply is how you learn the claim is gone. Handle `lease_renewed: false` by
stopping — that single branch also handles cancellation, since cancelling
produces the same signal.

**Post results idempotently.** Rows collapse on `(job_id, device_id, iter)`, so
retry freely. Send `final: true` exactly once per device per job, and put a
useful sentence in `error` when `ok` is false.

**Enforce the device-state contract before you burn battery.** Check
`require_charging` and `min_battery_pct` at claim time and refuse if unmet. An
on-battery phone was observed throttling decode roughly 100× with the screen
off; that constraint is the difference between a benchmark and a fiction.

## Adding a workload the collector has never heard of

You do not need a collector release. `POST /jobs` accepts any workload some
registered agent declares in its capabilities, and refuses the rest with a 422
naming what is missing.

So the whole path is: implement it, add it to your route table, register. The
job becomes enqueueable the moment your agent checks in.

Two things to do alongside it:

- **Add any new metric names to
  [`result.schema.json`](https://github.com/addisdev/fleet-runner/blob/main/collector/schemas/result.schema.json)
  in the same change.** A metric outside the schema is stored but unqueryable,
  and this project has already lost one report's numbers that way.
- **Say what it refuses.** The workload pages in these docs each end with what
  the workload will not do, and that section is usually the useful one.

`benchmark:mlx` is a good first one to try: the desktop agent already probes for
it and declines to declare it, because there is no backend behind it yet.
