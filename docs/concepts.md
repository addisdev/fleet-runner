# Concepts

How the queue thinks. Everything here is the collector's behaviour rather than
any one runner's, and it is what you need before writing a job spec that does
something more interesting than the one in [Get started](getting-started.md).

## Two kinds of job

**Device jobs** (`"executor": "device"`) are claimed by the agent running on the
device itself — benchmarks, batch inference, vision evals. The device
long-polls, claims, runs, and reports.

**Host jobs** (`"executor": "host"`) are claimed by an executor process on a Mac
and drive a device from *outside*, over adb or `simctl`. Installing an APK or
tapping through a UI test is not something an app can do to itself, so those
workloads have to live somewhere with a cable to the phone.

A host executor is not a device. It claims from `GET /executor/next-job` and
selects its own targets from whatever is physically attached to it.

## Capabilities

A pool is a label a person applied. A **capability** is a statement an agent
makes about its own code and toolchain, sent with every registration:

```json
{
  "device_id": "pixel-4a",
  "descriptor": { "…": "…" },
  "pools": ["ml-capable"],
  "capabilities": ["benchmark", "batch", "batch:litert", "pipeline"]
}
```

**The queue never hands an agent a workload it did not declare.** That is
checked before `targets.match`, on purpose: an expression narrows the set of
eligible agents, it cannot grant one a workload its code does not contain.

Two rules keep an upgrade from breaking a running shelf:

- **No `capabilities` key means "no opinion", not "nothing".** An agent that
  registered before the field existed is offered every workload, exactly as it
  was. An agent that sends `[]` is offered none — the two are different on
  purpose.
- **A re-registration that omits the key keeps what was declared last.** Rolling
  back to an older runner build must not silently widen it back to everything.

A job naming a backend is satisfied two ways: by an agent declaring the pairing
(`batch:litert`) or by one declaring the workload outright (`batch`), which
means it handles every backend it was built with.

Capabilities are readable from a match expression, so a job can target a
toolchain rather than hardware:

```json
{ "targets": { "match": "capabilities ~ 'build:xcode'" } }
```

### What this means for `POST /jobs`

The collector accepts the workload names it and the host executor ship with —
the ones that need no agent to vouch for them — **plus any workload some
registered agent declares.** Anything else is a 422 naming the missing
capability, at enqueue time, rather than a job that sits queued forever with
nothing to explain why.

That is what lets a new runner add a workload the collector has never heard of
without a release in the collector. [Writing a runner](writing-a-runner.md) is
the other half of it.

## Targeting

Pools still exist and devices still report them, but **nothing routes on them**
in the schedules that matter. Jobs target with `targets.match`: a statement
about what the job needs, evaluated against each device's own descriptor at
claim time.

```json
{ "targets": { "match": "os ~ 'android' && ram_mb >= 3000" } }
```

The plant-ID eval is the case that proves the difference. It is LiteRT with a
`.tflite` model, so it is Android-only. Under `pool: ml-capable` it fanned out
to three iOS simulators that cannot load it at all. As the expression above it
selects the two Android devices that can — the 3000 MB floor being what the
published eval actually demonstrates, on a 3922 MB emulator.

`targets.device_id` pins one device. `targets.executor` pins a host job to a
named executor; unset stays permissive, so anything not pinned is claimable by
whichever executor is free.

## Leases

A claim is a lease, not a permanent handoff. Without one, a runner that dies
mid-job — an emulator's low-memory killer taking out the process, a flat
battery, a yanked cable — leaves the job `claimed` forever and somebody has to
mark it failed by hand in SQLite.

- Claiming a job sets `lease_deadline = now + lease.ttl_s` and bumps `attempts`.
- The runner posts a beacon with the `job_id` to push the deadline out. The
  reply's `lease_renewed: false` means the claim is gone — swept, or already
  closed — and the runner should stop working the job.
- A sweep runs every 15 s and on startup, and can be forced with
  `POST /jobs/sweep`. Lapsed claims go back to `queued`; once `attempts` reaches
  `lease.max_attempts` the job is `failed` instead. Either way `last_error`
  records what happened.

Defaults are 600 s and 3 attempts. `drain` and `soak` default to 14400 s, since
they run for hours between beacons. **Pick a TTL longer than the worst-case gap
between beacons for that workload** — too short and the collector requeues a job
that is still running perfectly well.

## Constraints

`constraints` is enforced in two places, and which place matters.

**The runner enforces `require_charging` and `min_battery_pct`**, at claim time,
against live state. A device that fails one refuses the job with a failed
result. That is right for a contract about the device: a benchmark on a
throttling phone produces a number that lies, and a lie recorded as a result is
worse than a failure. An on-battery Samsung was observed throttling decode
roughly 100× with the screen off, which is exactly what those constraints exist
to prevent.

**The collector enforces `require_ac`, `require_idle_s`, `max_load` and
`window`**, before the claim, against the device's last beacon. An unsatisfied
one leaves the job queued and offers it again on the next poll. A laptop that is
on battery, or busy, or awake at the wrong hour has not failed at anything — it
is merely unsuitable right now, and burning an attempt on that would exhaust
`max_attempts` on a machine that was working perfectly.

```json
{ "constraints": { "require_ac": true, "require_idle_s": 300, "max_load": 2,
                   "window": { "from": 22, "to": 6 } } }
```

`window` crosses midnight when `from > to`: 22 to 06 is the night, not an empty
set. **Stale beacons fail closed** — a machine that stopped reporting cannot be
shown to be idle, and guessing permissively is how a benchmark ends up running
while someone is typing.

## Fan-out

`"fanout": true` enqueues one child per matching device, pinned with
`targets.device_id` and suffixed `--<device_id>`. A whole-shelf benchmark is one
request.

`"fanout": { "distinct": "os" }` enqueues one child per distinct value of that
descriptor field, newest-seen first. That is the canary shape: a smoke pass on
every OS on the shelf without paying for every phone.

Host jobs fan out too, and the executor's own target selection honours
`targets.device_id`, so an `install` plus `ui-test` pair can cover the OS matrix
with two job specs.

## Job chains

Build, then install what it built, then run the UI suite against it. That shape
used to need something outside the collector sitting on the queue, polling for
the build to close and posting the next job by hand — a piece of software with
no home, no restart story, and nothing watching *it*.

`depends_on` puts the relationship on the job that waits:

```json
{ "schema": 1, "job_id": "install-903", "workload": "install", "executor": "host",
  "depends_on": ["build-903"],
  "app": { "name": "your-app-android", "build": "903",
           "sha256": "${jobs.build-903.artifact}" } }
```

A job with an unfinished dependency is inserted as **`waiting`**, which is a
status of its own rather than a flag on a queued row. The claim loop asks for
`status = 'queued'`, so a waiting job is invisible to it by construction —
there is no second predicate somebody could forget to update. `waiting` is also
counted separately on the overview, because a chain parked on a dependency is
not work the fleet is failing to pick up.

- When the last dependency reaches `done`, the waiter is promoted **in the same
  transaction that closed the dependency**. A crash between the two would leave
  a chain stalled on a job that has already finished, and nothing would ever
  come back and fix it.
- When a dependency **fails or is cancelled**, the waiter fails with
  `last_error` naming it, and that cascades the whole way down. A broken build
  must not leave an install and a ui-test sitting in `waiting` until somebody
  notices next week.
- A dependency that does not exist, and a cycle, are refused at enqueue with a
  400. A chain naming a job nobody ever posted would otherwise sit in `waiting`
  forever, looking exactly like a chain whose build is merely slow.

### Template references

At promotion the waiter's stored spec is rewritten, so what the runner claims
has real values in it rather than instructions it would have to interpret:

| Reference | Resolves to |
|---|---|
| `${jobs.<id>.artifact}` | the first sha256 in that job's final result row's `artifacts` |
| `${jobs.<id>.metrics.<key>}` | that metric from the same row |

A reference that is the *whole* string **keeps the value's type**. A metric
substituted into `params.budget_s` stays a number; a budget silently turned into
the string `"91"` would compare wrong against every number it met afterwards. A
reference embedded in a longer string is interpolated as text.

Two refusals worth knowing:

- A reference may only name a job in this job's own `depends_on`. Otherwise it
  would be filled from whatever that job happened to have produced by the time
  this one was promoted, which is a race dressed up as a feature.
- A reference that cannot be resolved at promotion — the dependency finished
  `done` but uploaded no artifact, or reported no such metric — **fails the
  waiter** and says so. Promoting it with a blank hash would produce a job that
  dies at download time, hours later and nowhere near the cause.

## Preemption

A six-hour `app-soak` holds the only iPhone on the shelf. A one-minute smoke
test lands behind it. Without preemption the choice is to wait six hours or to
cancel the soak and throw away everything it measured — and cancelling is what
actually happens, which is why the soak never finishes.

`"preemptible": true` offers a third answer: the job agrees to be interrupted.

- **Asking.** The beacon reply gains `preempt: true` when the running job is
  preemptible *and* a queued job with **strictly higher** priority would go to
  the same claimant. Strictly higher, because equal priority is not a reason to
  throw away work in progress, and two jobs trading a device back and forth is
  worse than either finishing late.
- **Stopping.** The collector never kills anything. `preempt` is a request the
  runner honours on its own schedule: it stops at a point it can resume from,
  uploads its progress, and posts its final row with `preempted: true`.
- **Standing down.** That row does not close the job. It goes back to `queued`,
  the attempt it burned is **handed back**, the lock is released, and the
  uploaded sha256 is written into the spec as `params.resume_from`. It is not
  marked failed and does not appear in the failed list — being interrupted by
  the operator's own priorities is not evidence that a job is flaky.

A runner that ignores `preempt` simply keeps running. The field is additive and
the old behaviour is the default.

## Artifacts

Everything the fleet moves around — models, app builds, eval sets, reports — is
an artifact addressed by its sha256. `POST /artifacts` returns the hash;
`GET /artifacts/:sha256` serves it and supports range requests.

A build published with the `x-artifact-app`, `x-artifact-build` and
`x-artifact-platform` headers is stamped as *published*, which is what lets a
later job ask for `"sha256": "latest"` and get the newest build of that app.
There is no separate publish endpoint and none is needed. [Publish on
merge](integration/publish-on-merge.md) is why this matters.

**Two kinds of artifact are safe from garbage collection without appearing in
the reference scan.** Accepted visual baselines are referenced by a row rather
than by text in any spec, and their whole purpose is to still exist months later
to diff against. And anything pinned by hand carries a **reason**, stored
because a pin with no reason is one nobody will ever dare remove.

## Alerts are state, not events

One row per (rule, subject) for as long as the condition holds, resolved when it
stops. A device offline for six hours is one row with a rising `seen_count`, not
360 notifications — and nothing is notified twice, ever. [The alerts
page](deploy/alerts.md) lists the rules.
