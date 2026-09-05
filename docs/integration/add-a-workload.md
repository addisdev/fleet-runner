# Add a workload

Teach the fleet to run something it has never heard of, without a release in the
collector.

## Why this works at all

`POST /jobs` accepts the workload names the collector and host executor ship
with, **plus any workload some registered agent declares in its capabilities**.
Anything else is a 422 naming the missing capability, at enqueue time, rather
than a job that sits queued forever with nothing to explain why.

So the entire path is: implement it in an agent, add it to that agent's route
table, restart the agent. The job becomes enqueueable the moment it registers.

See [Writing a runner](../writing-a-runner.md) for the agent side, and
[Capabilities](../concepts.md#capabilities) for the routing rules.

## A worked example: `benchmark:mlx`

The desktop agent already probes for MLX and correctly declines to declare it,
because there is no backend behind it. That makes it the honest example, and a
good first contribution.

**1. Probe honestly.** The capability appears only when the machine can actually
do the work:

```ts
// runner-machine/src/capabilities.ts
const hasMlx = await probe("python3", ["-c", "import mlx_lm"]);
if (hasMlx) capabilities.push("benchmark:mlx");
```

A capability claimed here that the machine cannot honour is a job the queue
hands over and the agent bounces, which looks from the dashboard exactly like a
broken workload.

**2. Route it.** Declaration and dispatch come from one table, so adding the
route is what declares it:

```ts
{ capability: "benchmark:mlx", workload: "benchmark", backend: "mlx",
  run: (job) => runMlxBench(job) }
```

**3. Report named metrics.** `prefill_tok_s` and `decode_tok_s` already exist in
the schema, so an MLX benchmark needs no new ones — which is the ideal case,
because it means the existing Results screen charts it with no changes.

**4. Enqueue it.**

```json
{ "schema": 1, "job_id": "mlx-1", "workload": "benchmark",
  "executor": "device", "backend": "mlx",
  "model": { "name": "qwen2.5-0.5b", "format": "gguf", "sha256": "…" },
  "targets": { "match": "capabilities ~ 'benchmark:mlx'" } }
```

Targeting on the capability rather than on the hardware is the point: the job
says what it needs, and any machine that grows the toolchain becomes eligible
without anybody editing a pool.

## If your workload needs a new metric

Add it to
[`result.schema.json`](https://github.com/addisdev/fleet-runner/blob/main/collector/schemas/result.schema.json)
**in the same change that emits it.**

A metric outside the schema is stored but unqueryable, and this project has
already lost one report's numbers exactly that way: an eval's accuracy rode in a
field named `decode_tok_s` because vision had no field of its own, and no query
can reproduce those numbers today.

The collector's test suite fails when the schema and its mirrored copy disagree,
which is one of the reasons all four components live in one repository.

If the quantity is **structured rather than scalar** — a per-check breakdown, a
build's provenance — give it a named top-level field instead of folding it into
`metrics`. The collector stores a result's whole payload, so a named field
survives and can be rendered later, whereas inventing metric names outside the
schema cannot.

## Say what it refuses

Every workload page in these docs ends with what the workload will not do, and
that section is usually the useful one.

When you cannot measure the thing asked for, **fail with a message naming what
is missing**. A wrong number recorded as a result is worse than a failure,
because a failure gets investigated and a number gets believed.
