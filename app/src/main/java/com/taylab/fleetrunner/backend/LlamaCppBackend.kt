package com.taylab.fleetrunner.backend

import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.intParam

/**
 * llama.cpp over JNI: GGUF models fetched through the collector's
 * content-addressed artifact store, benchmarked llama-bench style
 * (prefill batch + token-by-token decode).
 */
class LlamaCppBackend(private val artifacts: ArtifactCache) : ModelBackend {
    override val name = "llama.cpp"

    private var handle = 0L

    override fun load(job: JobSpec): Long {
        val model = job.model
            ?: throw IllegalArgumentException("llama.cpp job needs a model ref")
        require(model.format == "gguf") { "llama.cpp needs gguf, got ${model.format}" }

        val file = artifacts.ensure(model.sha256)

        val pp = job.params.intParam("prompt_tokens", 512)
        val tg = job.params.intParam("gen_tokens", 128)
        val nCtx = maxOf(1024, pp + tg + 8)
        // Big cores only by default: all-core on big.LITTLE hurts throughput.
        val nThreads = job.params.intParam(
            "n_threads",
            minOf(Runtime.getRuntime().availableProcessors(), 6),
        )

        val t0 = System.nanoTime()
        handle = LlamaNative.nativeLoad(file.absolutePath, nCtx, nThreads)
        if (handle == 0L) throw IllegalStateException("llama.cpp failed to load ${model.name}")
        return (System.nanoTime() - t0) / 1_000_000
    }

    override fun runIteration(job: JobSpec): IterResult {
        check(handle != 0L) { "load() not called" }
        val pp = job.params.intParam("prompt_tokens", 512)
        val tg = job.params.intParam("gen_tokens", 128)

        val r = LlamaNative.nativeBench(handle, pp, tg)
            ?: throw IllegalStateException("llama.cpp decode failed (see logcat)")
        val (prefillMs, decodeMs, ttftMs) = Triple(r[0], r[1], r[2])

        return IterResult(
            prefillTokS = pp * 1000.0 / prefillMs.coerceAtLeast(1.0),
            decodeTokS = tg * 1000.0 / decodeMs.coerceAtLeast(1.0),
            ttftMs = ttftMs,
        )
    }

    override fun unload() {
        if (handle != 0L) {
            LlamaNative.nativeFree(handle)
            handle = 0L
        }
    }
}
