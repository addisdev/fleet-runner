# fleet-runner-android

Kotlin runner app for the Fleet Runner device fleet — Phase 1 of the plan.

A foreground service turns any Android device (minSdk 24) into a fleet agent:
it registers with the [collector](https://github.com/addisdev/fleet-collector),
long-polls for `executor: "device"` jobs, runs them, and reports results plus a
60-second telemetry beacon (battery / charging / thermal).

## Architecture

| Component | File | Role |
|---|---|---|
| Agent loop | `RunnerService.kt` | register → long-poll → run → report, with error backoff |
| Telemetry beacon | `RunnerService.kt` / `telemetry/Telemetry.kt` | battery, thermal (shared enum), PSS; also runs during host-driven jobs |
| Protocol | `protocol/Protocol.kt` | Kotlin mirror of `fleet-collector/schemas` (`schema: 1`) |
| Backends | `backend/` | `ModelBackend` interface; `synthetic` (SHA-256 CPU throughput — real, device-comparable numbers, never LLM numbers) and `llama.cpp` (Phase 1b stub: fails fast with an honest error) |
| Benchmark engine | `workload/BenchmarkEngine.kt` | timed load, mandatory warmups, per-iteration rows, final summary closes the job |

## Run against a local collector

```
cd ../fleet-collector && npm start        # collector on :8788
./gradlew :app:installDebug
adb reverse tcp:8788 tcp:8788             # device reaches the Mac via USB
```

Open the app, keep the default `http://127.0.0.1:8788`, tap **Start agent**,
then enqueue a job:

```
curl -X POST http://127.0.0.1:8788/jobs -H 'content-type: application/json' -d '{
  "schema": 1, "job_id": "bench-synthetic-1", "workload": "benchmark",
  "executor": "device", "backend": "synthetic",
  "params": { "prompt_tokens": 256, "gen_tokens": 64, "warmup_iters": 1, "measure_iters": 3 },
  "targets": { "pool": "ml-capable" }
}'
```

Results appear on the collector dashboard (`/dash`). To let a device leave the
desk, set the collector URL to the host's address on your network — its
`.local` name, or its tailnet address if you run one — and no adb is needed.

## Phase 1 status

- [x] Agent loop, beacon, benchmark engine, synthetic backend
- [ ] Phase 1b: llama.cpp backend (NDK + JNI, GGUF artifact download/cache)
- [ ] Offline result queue (results currently retry only via the loop's backoff)
