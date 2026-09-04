# Third-party notices

The runner links two pieces of software that are not ours. Both are permissive;
this file exists so their terms travel with the app rather than being something
you have to go and find.

| Component | Where | License | Notes |
|---|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `third_party/llama.cpp` (git submodule, pinned to `a94d563`, tag `b10423`) | MIT — Copyright (c) 2023-2026 The ggml authors | Compiled into `libfleetllama.so` via the JNI wrapper in `app/src/main/cpp/`. The pin matters: the iOS runner builds its xcframework from the same commit, which is what makes tok/s comparable across the fleet. |
| [LiteRT](https://ai.google.dev/edge/litert) (`com.google.ai.edge.litert:litert`, `litert-gpu`) | Maven dependency, see `app/build.gradle.kts` | Apache-2.0 | The vision backend for the `vision-eval` workload. |

Model weights are never bundled in the APK. Each runner fetches them from the
collector's artifact store by content hash, so a model's license is the
concern of whoever puts it on the shelf — see the collector's
`evals/greenfolio-plant-id.md` for the ones the fleet has actually run.

Everything else is standard AndroidX, Kotlin, and OkHttp, under their own
Apache-2.0 terms as declared by Gradle.
