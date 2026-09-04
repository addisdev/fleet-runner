# fleet-runner-android

The Android half of **Fleet Runner**, a personal device lab. A foreground
service turns any phone or tablet back to Android 7 (minSdk 24) into a node
that a [collector](https://github.com/addisdev/fleet-collector) can send work
to: llama.cpp and LiteRT benchmarks, batch inference, and image-classification
evals, with a telemetry beacon reporting battery, charging and thermal state
every 60 seconds.

Old hardware is the point. A phone too slow for an LLM still runs the
synthetic backend and still produces a comparable number, which is what makes
a drawer of retired handsets useful as a test matrix instead of e-waste.

Real numbers from real silicon: Qwen2.5-0.5B Q4_K_M at **125 prefill / 47.4
decode tok/s** on an SM-X930 (Dimensity 9400), with the model fetched by
content hash from the collector's artifact store.

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

## License

MIT — see [LICENSE](LICENSE). llama.cpp, LiteRT, and the terms they carry are
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
