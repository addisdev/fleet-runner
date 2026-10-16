# Your first job

Before any CI, prove the loop by hand. Each step ends somewhere you can look at
the result.

This assumes a collector running — [Get started](../getting-started.md) if not —
and at least one agent registered.

## 1. Enqueue with fleetr

`fleetr` is installed beside `fleet` and is the same program. Point it at the
collector with `--url`, or set `FLEET_RUNNER_URL` once:

```bash
export FLEET_RUNNER_URL=http://fleet-host.local:8788

fleetr devices                  # what is online; a job can only land on these
fleetr workloads benchmark      # its params and a valid example spec
fleetr run benchmark --backend synthetic --match "os ~ 'android'" \
  --param prompt_tokens=256 --param gen_tokens=64 --param measure_iters=3
```

`fleetr run` validates the spec against [`/api/v1`](../api.md#control-api-apiv1)
before it queues anything, waits for the verdict, prints it per device, and
**exits with it**: 0 passed, 1 failed, 2 usage error or invalid spec, 3 still
running when `--timeout` ran out, 4 skipped (nothing ran), 5 refused or
unreachable. Add `--validate` to see where a job would land without queueing
it, and `--no-wait` to print the job id and return; `fleetr wait <job_id>`
picks it up later.

**A `job_id` you set must be unique.** Leave it out and the collector
generates one. Set it (`--id`, or `job_id` in a spec) and it is an idempotency
key: a second enqueue with the same id is refused with `duplicate_job` (a 409),
deliberately, so a retried CI step cannot silently overwrite an earlier
verdict. Building it from the commit sha and the run attempt is the pattern the
templates use.

If the job sits `waiting` rather than `queued`, it has a `depends_on` that has
not closed yet. If nothing ever claims it, the usual cause is a `targets`
clause no registered device satisfies, which `--validate` shows before you
queue.

### The same with curl

Where `fleetr` is not installed, the control API takes the same spec:

```bash
curl -s -X POST http://fleet-host.local:8788/api/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "workload": "benchmark",
    "executor": "device",
    "backend": "synthetic",
    "params": { "prompt_tokens": 256, "gen_tokens": 64, "measure_iters": 3 },
    "targets": { "match": "os ~ '\''android'\''" }
  }'

curl -s 'http://fleet-host.local:8788/api/v1/jobs/<job_id>/wait?timeout_s=120'
curl -s 'http://fleet-host.local:8788/api/v1/devices'
```

The first answers 201 with `job_id`, `status` and `links`; the second holds
for up to 120 seconds and returns the summary, whose `verdict` is `passed`,
`failed`, `mixed`, `skipped` or `cancelled` once `finished` is true. A collector
running with tokens on (see [Authentication](../deploy/auth.md)) also wants
`-H "authorization: Bearer $FLEET_TOKEN"`. The older `POST /jobs` and
`GET /api/devices` still answer, with a `Deprecation` header.

## 2. Upload a build and test it

Publish the build, then run the suite against it. From the collector's
checkout:

```bash
npx tsx scripts/ci-upload.ts \
  --collector http://fleet-host.local:8788 \
  --app your-app-android --build local --platform android \
  --artifact app/build/outputs/apk/debug/app-debug.apk

cat > job.json <<'JSON'
{
  "workload": "ui-test",
  "executor": "host",
  "app": { "name": "your-app-android", "build": "latest", "sha256": "latest" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" },
  "targets": { "exclusive": true },
  "lease": { "ttl_s": 1200 }
}
JSON

fleetr run --spec job.json
```

`"latest"` resolves at enqueue to the newest build published under that app
name, which from your own terminal is the one you just uploaded. Where two
uploads can race (two pull requests building at once), put the hash
`ci-upload` printed in `app.sha256` instead.

### Or in one step with `ci-enqueue`

`collector/scripts/ci-enqueue.ts` uploads, enqueues and polls in one command,
and the example workflow uses it:

```bash
cat > job.json <<'JSON'
{
  "schema": 1,
  "job_id": "ui-local-1",
  "workload": "ui-test",
  "executor": "host",
  "app": { "name": "your-app-android", "build": "local", "sha256": "replaced-by-upload" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" },
  "targets": { "exclusive": true },
  "lease": { "ttl_s": 1200 }
}
JSON

npx tsx scripts/ci-enqueue.ts \
  --collector http://fleet-host.local:8788 \
  --job job.json \
  --artifact app/build/outputs/apk/debug/app-debug.apk \
  --timeout 1200
```

It uploads the artifact, writes the returned hash into `app.sha256`, posts the
spec to the deprecated `POST /jobs`, polls `GET /jobs/<id>` every ten seconds,
and exits 0 when the job is `done`, 1 when it failed or timed out, and 2 on a
usage error. `"replaced-by-upload"` is only a placeholder for the script to
overwrite: it is not a hash, so `fleetr run --spec` and `/api/v1/jobs` refuse
it. Know three things before you let it block a pull request:

- **A skipped job exits 0.** A job where nothing ran (its `last_error` starts
  `skipped:`) is still `done`, so the check goes green. `fleetr run` exits 4
  for the same job.
- **It sends no token**, so against a collector with `FLEET_AUTH=tokens` the
  enqueue is refused and the step fails.
- **A duplicate `job_id` is not an error to it.** It prints "already queued"
  and reports the earlier job's verdict.

For a check that blocks a merge, prefer `ci-upload` followed by
`fleetr run --spec`.

## 3. Watch it on the dashboard

`/dash/jobs/<job_id>` shows the claim, the beacons, the per-device result rows
and any artifacts the run uploaded. A failed UI suite has its JUnit report
attached there.

If the job failed, `last_error` on the job row is where the reason is, and it is
written to be a sentence rather than a stack trace.

## Then

- **[Publish on merge](publish-on-merge.md)** so a nightly can stop pinning
  hashes by hand.
- **[Add your app](add-your-app.md)** for the flow and suite formats.
