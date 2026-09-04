package com.taylab.fleetrunner.backend

/** JNI surface of libfleetllama (see app/src/main/cpp/fleet_llama.cpp). */
object LlamaNative {
    init {
        System.loadLibrary("fleetllama")
    }

    /**
     * Opens a model. [embeddings] builds the context for embedding extraction
     * (mean-pooled) instead of generation — a context can do one or the other,
     * so this is a load-time decision rather than a per-call one.
     */
    external fun nativeLoad(path: String, nCtx: Int, nThreads: Int, embeddings: Boolean): Long

    /** Returns [prefill_ms, decode_ms, ttft_ms], or null on decode failure. */
    external fun nativeBench(handle: Long, promptTokens: Int, genTokens: Int): DoubleArray?

    /** Greedy generation until EOG or maxTokens; null on failure. */
    external fun nativeGenerate(handle: Long, prompt: String, maxTokens: Int): String?

    /**
     * One mean-pooled embedding vector for [text]; null on failure, including
     * the case where the handle was not opened with `embeddings = true`. The
     * array's length is the model's embedding width — never a zero-filled
     * vector standing in for a failure, which is the whole reason embed-eval
     * can trust what it scores.
     */
    external fun nativeEmbed(handle: Long, text: String): FloatArray?

    external fun nativeFree(handle: Long)
}
