# Your first job

Before any CI, prove the loop by hand. Each step ends somewhere you can look at
the result.

This assumes a collector running — [Get started](../getting-started.md) if not —
and at least one agent registered.

## 1. Enqueue with curl

```bash
curl -X POST http://fleet-host.local:8788/jobs \
  -H 'content-type: application/json' \
  -d '{
    "schema": 1,
    "job_id": "smoke-'"$(date +%s)"'",
    "workload": "benchmark",
    "executor": "device",
    "backend": "synthetic",
    "params": { "prompt_tokens": 256, "gen_tokens": 64, "measure_iters": 3 },
    "targets": { "match": "os ~ '\''android'\''" }
  }'
```

```json
{ "ok": true, "job_id": "smoke-1788635539", "status": "queued" }
```

**`job_id` must be unique** — a duplicate is a 409, deliberately, so a retried
CI step cannot silently overwrite an earlier verdict. Building it from the
commit sha and the run attempt is the pattern the templates use.

If the reply says `waiting` rather than `queued`, the job has a `depends_on`
that has not closed yet. If nothing ever claims it, the usual cause is a
`targets` clause no registered device satisfies:

```bash
curl -s 'http://fleet-host.local:8788/api/devices' | grep -o '"device_id":"[^"]*"'
```

## 2. Upload a build and test it

`ci-enqueue` is the script CI runs, and it works perfectly well from your own
terminal, which is where you should try it first.

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

It uploads the artifact, rewrites `app.sha256` with the returned hash, enqueues,
polls to a verdict, and **exits 0 or 1**. That exit code is the whole contract —
everything else is detail.

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
