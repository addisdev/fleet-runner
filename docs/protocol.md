# The protocol

Everything an agent has to speak. It is deliberately small: five HTTP calls,
JSON in and JSON out, no websockets, no SDK and no client library. The three
runners in this repository share it and share **no code** — the Kotlin, Swift
and TypeScript agents each implement it independently — which is the point.
Anything that can make an HTTP request can be a fleet device.

The wire version is `"schema": 1`. Both shapes are defined in
[`collector/schemas/`](https://github.com/addisdev/fleet-runner/tree/main/collector/schemas)
and those files are the authority; this page is the narrative version.

## The loop

![The protocol in five calls: register, then long-poll for a job and get 204 no content held about 25 seconds, poll again and get 200 with the job spec and a running lease, beacon and be answered with lease_renewed and preempt, then post result rows and a final row that closes the job](img/protocol.png)

## 1. Register

```
POST /devices/register
```

```json
{
  "device_id": "living-room-tv",
  "descriptor": {
    "model": "AFTKA", "soc": "Amlogic S905Y4", "ram_mb": 2048,
    "os": "android-11", "app_ver": "0.3.0", "arch": "arm64",
    "platform": "android", "kind": "tv"
  },
  "pools": ["ml-capable"],
  "capabilities": ["benchmark"],
  "ttl_s": 300
}
```

An upsert — call it on every startup and after every reconnect. `device_id` is
yours to choose and is what job specs pin; make it stable across restarts.

**`descriptor` is what `targets.match` is evaluated against**, so a field you
omit is a field no job can select you by. `ram_mb` and `os` are the two that
matter most in practice.

**`capabilities` is a promise about your own dispatch.** See
[Capabilities](concepts.md#capabilities) for the three rules that govern it; the
one to internalise is that omitting the key means "no opinion" and sending `[]`
means "nothing", and they are different on purpose.

### `platform` and `kind`

**`platform`** is which OS family you run. An open string: `android`, `ios`,
`tvos`, `watchos`, `visionos`, `macos`, `linux`, `windows`, `web` are the ones
in use. Send it. An agent that omits it gets the old rule — iOS if `os` looks
like iOS, Android otherwise — which is kept so that a collector upgrade does
not relabel agents written before the field existed. That rule is also why the
field had to exist: it does not report a platform, it reports a guess, and
every desktop agent registered as an Android phone until it could say
otherwise.

**`kind`** is the form factor: `phone`, `tablet`, `laptop`, `desktop`, `tv`,
`watch`, `headset`, `sbc`, `browser`, `ci`, `container`. Null when you do not
say, never guessed — a phone and a TV stick running the same Android build are
indistinguishable from a descriptor, and inventing an answer puts a television
in a table of handsets.

Both are open sets. A platform nobody has thought of yet does not need a
collector release before it can be named.

### `ttl_s`, if you are temporary

Omit it and you are a shelf device: a phone that is switched off is still a
phone and should stay in the registry reading offline until somebody picks it
up. Send it and you are saying the opposite — that your absence is the end of
you rather than a fault.

```
ttl_s: 300     # remember me for five minutes of silence
```

This is for agents whose disappearance is normal: a browser tab that was
closed, a CI runner whose job finished, a container that exited. Without it,
every CI run leaves a permanent offline device behind and the shelf fills with
ghosts.

The window slides against `last_seen`, which every poll and every beacon
already refreshes, so an agent that is still working never expires out from
under its own job. When it does expire the row is kept, not deleted: the
results you posted stay attributable and `GET /api/devices/:id` still resolves
you. What changes is that the queue stops offering you work and you leave the
shelf.

## 2. Claim work

```
GET /devices/{device_id}/next-job     → 200 job spec, or 204
GET /executor/next-job?name={label}   → the host-job equivalent
```

This is a **long poll**, held open for about 25 seconds. A `204` means the poll
expired with nothing to do; call it again immediately. That is the whole
scheduling mechanism — there is no push channel and no broker.

A `200` returns the spec, and the job is now claimed by you with a lease
running.

```json
{
  "schema": 1, "job_id": "bench-1", "workload": "benchmark",
  "executor": "device", "backend": "synthetic",
  "model": { "name": "qwen2.5-0.5b", "format": "gguf", "quant": "Q4_K_M",
             "sha256": "…" },
  "params": { "prompt_tokens": 256, "gen_tokens": 64, "measure_iters": 3 },
  "constraints": { "require_charging": true, "min_battery_pct": 30 },
  "lease": { "ttl_s": 600, "max_attempts": 3 }
}
```

**Enforce `constraints.require_charging` and `min_battery_pct` yourself, before
you start**, and refuse with a failed result if they are not met. Those are the
two the runner owns; the collector enforces the rest before it ever offers you
the job. See [Constraints](concepts.md#constraints) for why the split is where
it is.

## 3. Beacon

```
POST /results
```

```json
{
  "schema": 1, "kind": "beacon", "device_id": "pixel-4a", "job_id": "bench-1",
  "beacon": { "battery_pct": 82, "charging": true, "thermal": "nominal",
              "mem_mb": 412 }
}
```

A beacon does three things at once, which is why there is no separate endpoint
for it:

1. **It renews the lease.** The reply's `lease_renewed: false` means your claim
   is gone — swept, or the job already closed — and you should stop working it.
   That is the same signal a cancelled job produces, so handling one handles
   both.
2. **It carries telemetry**, which is what the battery and thermal charts are
   built from. Send one every 60 s or so even when idle (omit `job_id` then).
3. **It answers `preempt`.** If the reply says `preempt: true` and your job is
   `preemptible`, stop at a resumable point, upload your progress, and post a
   final row with `"preempted": true`. See
   [Preemption](concepts.md#preemption). Ignoring the field is fine — it is
   additive, and not stopping is the old behaviour.

**Beacon more often than the lease TTL.** A `drain` job with a 4-hour TTL still
beacons every minute; a benchmark with a 600 s TTL must not go 10 minutes
silent.

## 4. Report results

The same endpoint, with `kind: "result"`.

```json
{
  "schema": 1, "kind": "result", "device_id": "pixel-4a", "job_id": "bench-1",
  "iter": 1,
  "metrics": { "prefill_tok_s": 125.0, "decode_tok_s": 47.4, "load_ms": 310 }
}
```

Rows are **idempotent by `(job_id, device_id, iter)`**, so a retry after a
network failure is safe and duplicates collapse. Use `iter: 1..n` for
per-iteration rows and `iter: 0` for the summary.

The last row for a device carries `final`:

```json
{ "schema": 1, "kind": "result", "device_id": "pixel-4a", "job_id": "bench-1",
  "iter": 0, "final": true, "ok": true,
  "device": { "model": "Pixel 4a", "soc": "…", "os": "android-13" },
  "metrics": { "prefill_tok_s": 125.0, "decode_tok_s": 47.4 },
  "artifacts": ["<sha256>"] }
```

**`final: true` closes the job** and promotes anything waiting on it. `ok` is
the verdict. `error` carries the reason on a failure, and it is what the
dashboard shows against the job — so make it a sentence a person can act on.

### Metric names are not free-form

`metrics` keys come from
[`result.schema.json`](https://github.com/addisdev/fleet-runner/blob/main/collector/schemas/result.schema.json).
Inventing one means it is stored but nothing queries it, which is a specific
mistake this project has already made: an eval's accuracy once rode in a field
named `decode_tok_s` because vision had no field of its own, and **no query can
reproduce that report's numbers today**.

If you need a quantity that has no name, add it to the schema in the same change
that emits it. If it is structured rather than scalar, put it in a named
top-level field instead of `metrics` — the collector stores a result's whole
payload, so it survives and can be rendered later, whereas folding it into
`metrics` means inventing metric names outside the schema.

Say how you measured, when it is ambiguous. `mem_method` exists because RSS on
macOS and PSS on Android are not the same quantity, and reporting one under the
other's name would be laundering.

### `backend` and `model.format` are open too

Both were closed enums and are now open strings, for the same reason `workload`
is: the thing that makes a runtime real is a runner that can load it, and
closing the set meant a new runtime could not be named in a job until the
collector shipped a release.

Enforcement moved to capabilities, where it already was for workloads. An agent
declaring `benchmark:onnx` is what makes that pairing runnable; a backend no
registered agent declares is refused at enqueue with a 422 naming it.

Name your backend for what it actually is. The browser runner declares
`benchmark:jssha` and `benchmark:webcrypto` rather than `benchmark:synthetic`,
because a browser's only native hash is asynchronous and its rate is not the
same quantity as a phone's — see [Make your numbers
comparable](writing-a-runner.md#make-your-numbers-comparable).

## 5. Artifacts

```
POST /artifacts              → { "sha256": "…" }
GET  /artifacts/{sha256}     → the bytes, with Range support
```

Everything the fleet moves is content-addressed. **Verify the hash after
downloading a model** rather than trusting the transfer — the runners do, and a
corrupted GGUF otherwise fails much later and much less clearly.

Uploading with `x-artifact-app`, `x-artifact-build` and `x-artifact-platform`
stamps the upload as a published build, which is what makes
`"sha256": "latest"` resolvable. There is no separate publish call.

## Writing your own agent

The contract above is the whole thing. [Writing a runner](writing-a-runner.md)
walks through the design decisions — capability routing, the synthetic backend
that makes numbers comparable, and what to refuse rather than approximate —
using the desktop agent as the worked example, because it is the smallest and
it is plain TypeScript.

## What the collector will not do

Worth stating, because each of these is a design decision rather than a gap:

- **It never pushes.** No websockets to the devices, no FCM, no APNs. Agents
  poll, which is what lets a phone behind NAT on a guest network participate
  with no configuration.
- **It never kills a running job.** Cancelling sets the row to `cancelled`,
  which makes the next beacon return `lease_renewed: false`. Work in flight
  finishes; nothing new starts.
- **It carries no secrets in job specs.** A job names a credential; the agent
  reads it from its own environment or Keychain. This is enforced by the design
  rather than by validation — `POST /jobs` is unauthenticated, so a spec is not
  a place a secret could safely live.
