# Cookbook

One complete job spec per workload. **Every file on this page is included
verbatim from
[`collector/examples/jobs/`](https://github.com/addisdev/fleet-runner/tree/main/collector/examples/jobs)
and validated against
[`job.schema.json`](https://github.com/addisdev/fleet-runner/blob/main/collector/schemas/job.schema.json)
by `npm test`.** If one stops validating, CI fails — so what you copy from here
is what the collector accepts.

Post any of them to `POST /jobs`:

```bash
curl -X POST http://fleet-host.local:8788/jobs \
  -H 'content-type: application/json' \
  --data-binary @collector/examples/jobs/benchmark.json
```

!!! note "About the hashes"

    Every `sha256` below is the SHA-256 of the empty string, used as an obvious
    placeholder. Replace it with a real artifact hash, with `"latest"` where the
    field allows it, or with a `${jobs.<id>.artifact}` reference to a
    dependency's output.

## Device workloads

### `benchmark` — synthetic, fanned out across the shelf

```json title="examples/jobs/benchmark.json"
--8<-- "collector/examples/jobs/benchmark.json"
```

`fanout: true` turns this into one child job per matching device, so a
whole-shelf benchmark is one request.

### `benchmark` — a real model

```json title="examples/jobs/benchmark-llama.json"
--8<-- "collector/examples/jobs/benchmark-llama.json"
```

### `thermal` — does the cold number survive

```json title="examples/jobs/thermal.json"
--8<-- "collector/examples/jobs/thermal.json"
```

### `batch`

```json title="examples/jobs/batch.json"
--8<-- "collector/examples/jobs/batch.json"
```

### `pipeline`

```json title="examples/jobs/pipeline.json"
--8<-- "collector/examples/jobs/pipeline.json"
```

### `vision-eval`

```json title="examples/jobs/vision-eval.json"
--8<-- "collector/examples/jobs/vision-eval.json"
```

The `match` expression is the one from the plant-ID eval, and it is Android-only
for a reason: the model is a `.tflite`, which an iOS simulator cannot load at
all. Under a pool label this job fanned out to three simulators and failed on
every one.

### `speech-eval`

```json title="examples/jobs/speech-eval.json"
--8<-- "collector/examples/jobs/speech-eval.json"
```

### `embed-eval`

```json title="examples/jobs/embed-eval.json"
--8<-- "collector/examples/jobs/embed-eval.json"
```

### `vantage`

```json title="examples/jobs/vantage.json"
--8<-- "collector/examples/jobs/vantage.json"
```

`fanout: { "distinct": "os" }` is the canary shape — one device per distinct OS,
rather than every phone on the shelf.

## Host workloads

### `install`

```json title="examples/jobs/install.json"
--8<-- "collector/examples/jobs/install.json"
```

### `ui-test` — Maestro on Android

```json title="examples/jobs/ui-test.json"
--8<-- "collector/examples/jobs/ui-test.json"
```

### `ui-test` — XCUITest on iOS

```json title="examples/jobs/ui-test-ios.json"
--8<-- "collector/examples/jobs/ui-test-ios.json"
```

Pinned with `targets.executor` because `simctl` and `devicectl` ship with full
Xcode, which the Android host deliberately does not have.

### `cold-start`

```json title="examples/jobs/cold-start.json"
--8<-- "collector/examples/jobs/cold-start.json"
```

### `app-soak`

```json title="examples/jobs/app-soak.json"
--8<-- "collector/examples/jobs/app-soak.json"
```

`preemptible: true` lets a two-minute smoke test interrupt this six-hour run and
have it resume, rather than forcing a choice between waiting and throwing the
work away.

### `a11y-audit`

```json title="examples/jobs/a11y-audit.json"
--8<-- "collector/examples/jobs/a11y-audit.json"
```

### `locale-shots`

```json title="examples/jobs/locale-shots.json"
--8<-- "collector/examples/jobs/locale-shots.json"
```

### `web-test`

```json title="examples/jobs/web-test.json"
--8<-- "collector/examples/jobs/web-test.json"
```

### `web-shots`

```json title="examples/jobs/web-shots.json"
--8<-- "collector/examples/jobs/web-shots.json"
```

`android-device` expands to one profile per real Android device attached to the
claiming executor, and **fails its slot if it finds none** rather than quietly
shrinking the matrix.

### `web-audit`

```json title="examples/jobs/web-audit.json"
--8<-- "collector/examples/jobs/web-audit.json"
```

### `web-unfurl`

```json title="examples/jobs/web-unfurl.json"
--8<-- "collector/examples/jobs/web-unfurl.json"
```

### `drain`

```json title="examples/jobs/drain.json"
--8<-- "collector/examples/jobs/drain.json"
```

### `archive`

```json title="examples/jobs/archive.json"
--8<-- "collector/examples/jobs/archive.json"
```

`account` names a Keychain item on the executor host. The secret itself is never
in the spec — `POST /jobs` is unauthenticated, so a spec is not a place a
credential could safely live.

### `digest`

```json title="examples/jobs/digest.json"
--8<-- "collector/examples/jobs/digest.json"
```

## Machine workloads

### `build`

```json title="examples/jobs/build.json"
--8<-- "collector/examples/jobs/build.json"
```

The constraints are the point: this waits for a machine on mains that has been
idle five minutes, rather than starting an Xcode build while somebody is typing.

### A chain: build, install, test

```json title="examples/jobs/chain-build-install-test.json"
--8<-- "collector/examples/jobs/chain-build-install-test.json"
```

Post `build.json`, `install.json` and this, and the last two arrive as
`waiting`. `${jobs.build-903.artifact}` is substituted at promotion with the
real hash the build uploaded. A failed build fails both waiters, naming the
cause, rather than leaving them parked forever.

### `model-convert`

```json title="examples/jobs/model-convert.json"
--8<-- "collector/examples/jobs/model-convert.json"
```

### `dataset-prep`

```json title="examples/jobs/dataset-prep.json"
--8<-- "collector/examples/jobs/dataset-prep.json"
```

### `serve`

```json title="examples/jobs/serve.json"
--8<-- "collector/examples/jobs/serve.json"
```

### `shell`

```json title="examples/jobs/shell.json"
--8<-- "collector/examples/jobs/shell.json"
```

This one is refused unless the target machine's owner has pinned that exact
`script_sha256` in a local allowlist file by hand. A machine that has pinned
nothing does not declare the capability at all, so it is never offered the job.

### `self-check`

```json title="examples/jobs/self-check.json"
--8<-- "collector/examples/jobs/self-check.json"
```

## Adding one

New example specs go in `collector/examples/jobs/`, named for the workload they
demonstrate, and are picked up by the validator automatically.
