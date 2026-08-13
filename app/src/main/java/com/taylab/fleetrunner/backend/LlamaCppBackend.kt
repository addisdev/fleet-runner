package com.taylab.fleetrunner.backend

import com.taylab.fleetrunner.protocol.JobSpec

/**
 * Phase 1b: llama.cpp over JNI (GGUF models, artifact download + cache).
 * Requires the NDK build of the llama.cpp checkout; until then jobs that
 * request this backend fail fast with an honest error in their final result.
 */
class LlamaCppBackend : ModelBackend {
    override val name = "llama.cpp"

    override fun load(job: JobSpec): Long =
        throw UnsupportedOperationException(
            "llama.cpp backend not built yet (Phase 1b: NDK + JNI); use backend \"synthetic\"",
        )

    override fun runIteration(job: JobSpec): IterResult =
        throw UnsupportedOperationException("llama.cpp backend not built yet")

    override fun unload() {}
}
