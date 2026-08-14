package com.taylab.fleetrunner.backend

/** JNI surface of libfleetllama (see app/src/main/cpp/fleet_llama.cpp). */
object LlamaNative {
    init {
        System.loadLibrary("fleetllama")
    }

    external fun nativeLoad(path: String, nCtx: Int, nThreads: Int): Long

    /** Returns [prefill_ms, decode_ms, ttft_ms], or null on decode failure. */
    external fun nativeBench(handle: Long, promptTokens: Int, genTokens: Int): DoubleArray?

    /** Greedy generation until EOG or maxTokens; null on failure. */
    external fun nativeGenerate(handle: Long, prompt: String, maxTokens: Int): String?

    external fun nativeFree(handle: Long)
}
