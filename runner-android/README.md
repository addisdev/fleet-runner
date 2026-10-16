# runner-android

*Part of [Fleet Runner](../README.md). The collector is
[`../collector`](../collector).*

The Android half of **Fleet Runner**, a personal device lab. A foreground
service turns any phone or tablet back to Android 7 (minSdk 24) into a node
that a [collector](../collector) can send work
to: llama.cpp and LiteRT benchmarks, batch inference, and image-classification
evals, with a telemetry beacon reporting battery, charging and thermal state
every 60 seconds.

The same APK installs on Android TV, Google TV and Fire TV, on a Meta Quest
and on Wear OS, and works out at run time which of those it is on. That is
less proven than it sounds: the APK declares a leanback launcher and a banner
(checked with `aapt2 dump badging`) but no TV has run it, and no Quest or Wear
device ever has. [Platforms](../docs/platforms.md) has the state of each.

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
| Protocol | `protocol/Protocol.kt` | Kotlin mirror of `collector/schemas` (`schema: 1`) |
| Backends | `backend/` | `ModelBackend` interface; `synthetic` (SHA-256 CPU throughput — real, device-comparable numbers, never LLM numbers), `llama.cpp` (NDK and JNI over the pinned llama.cpp submodule) and `litert` (vision evals) |
| Routing | `RunnerService.kt` | One table is both the capabilities sent at registration and the dispatch that runs them, so declaring a workload and being able to run it are one act |
| Benchmark engine | `workload/BenchmarkEngine.kt` | timed load, mandatory warmups, per-iteration rows, final summary closes the job |

## Run against a local collector

```
cd ../collector && npm start              # collector on :8788
./gradlew :app:installDebug
adb reverse tcp:8788 tcp:8788             # device reaches the Mac via USB
```

Open the app, keep the default `http://127.0.0.1:8788`, tap **Start agent**,
then enqueue a job:

```
curl -X POST http://127.0.0.1:8788/api/v1/jobs -H 'content-type: application/json' -d '{
  "schema": 1, "job_id": "bench-synthetic-1", "workload": "benchmark",
  "executor": "device", "backend": "synthetic",
  "params": { "prompt_tokens": 256, "gen_tokens": 64, "warmup_iters": 1, "measure_iters": 3 },
  "targets": { "pool": "ml-capable" }
}'
```

Results appear on the collector dashboard (`/dash`). To let a device leave the
desk, set the collector URL to the host's address on your network — its
`.local` name, or its tailnet address if you run one — and no adb is needed.

## What works, and what does not

The agent loop, the telemetry beacon and every workload in the table above run
on real hardware — the tok/s figures at the top of this page came off an
SM-X930, not an emulator. `benchmark`, `batch`, `batch:litert`, `pipeline`,
`thermal`, `embed-eval` and `vantage` are declared at registration and
dispatched from the same table, so the collector is never offered work this
runner would bounce back.

**Android 7.0 and 7.1 (API 24-25) start the runner service with
`startService`**, because `startForegroundService` only exists from API 26 and
threw `NoSuchMethodError` there. That fix is covered by a Robolectric test and
has not run on a real API 24 or 25 device.

**There is no offline result queue.** Results retry through the agent loop's
backoff and nothing else, so a device that loses the collector for longer than
that loses those rows. This is the one gap worth knowing about before you trust
a long unattended run.

**The native library is not built in CI.** Compiling llama.cpp for arm64 takes
about fifteen minutes and needs a pinned NDK, so CI runs the JVM tests with
`-Pfleet.skipNative` and the native path is verified on a developer machine and
by the phones that actually run the benchmarks. That flag is also how you run
the suite with no NDK installed:

```
./gradlew :app:testDebugUnitTest -Pfleet.skipNative
```

CI also runs `./gradlew :app:lintDebug -Pfleet.skipNative`. Passing it meant
dropping the manifest's `android.hardware.type.watch` feature line, which lint
rejects as not-required and which a store reads as Wear-only; the runner still
detects a watch at run time. No Wear device has run the APK before or after
that change.

## License

MIT — see [LICENSE](LICENSE). llama.cpp, LiteRT, and the terms they carry are
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
