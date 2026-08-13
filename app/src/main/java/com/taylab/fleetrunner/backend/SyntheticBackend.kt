package com.taylab.fleetrunner.backend

import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.intParam
import java.security.MessageDigest

/**
 * Proves the rails end-to-end with real, device-comparable numbers before the
 * llama.cpp backend lands: each "token" is a fixed amount of SHA-256 hashing,
 * so tok/s measures actual sustained CPU throughput on this device. The
 * backend name in results is "synthetic" — these are hardware-comparison
 * numbers, never LLM numbers.
 */
class SyntheticBackend : ModelBackend {
    override val name = "synthetic"

    private var buffer: ByteArray? = null

    companion object {
        // Hash rounds per simulated token, over a 4 KiB block. ~1-3 s per
        // iteration on a modern phone at the default 512/128 token counts.
        const val ROUNDS_PER_TOKEN = 1000
        const val BLOCK_SIZE = 4096
    }

    override fun load(job: JobSpec): Long {
        val t0 = System.nanoTime()
        buffer = ByteArray(BLOCK_SIZE) { (it * 31).toByte() }
        // Warm the digest instance the way a real backend warms its context.
        MessageDigest.getInstance("SHA-256").digest(buffer)
        return (System.nanoTime() - t0) / 1_000_000
    }

    private fun hashTokens(tokens: Int): Long {
        val digest = MessageDigest.getInstance("SHA-256")
        val block = buffer ?: error("load() not called")
        val t0 = System.nanoTime()
        repeat(tokens * ROUNDS_PER_TOKEN) {
            // Hash the full 4 KiB block every round, folding the digest back
            // into it so each round does fixed work that can't be elided.
            val out = digest.digest(block)
            System.arraycopy(out, 0, block, 0, out.size)
        }
        return (System.nanoTime() - t0) / 1_000_000
    }

    override fun runIteration(job: JobSpec): IterResult {
        val promptTokens = job.params.intParam("prompt_tokens", 512)
        val genTokens = job.params.intParam("gen_tokens", 128)

        val prefillMs = hashTokens(promptTokens)
        val firstTokenMs = hashTokens(1)
        val decodeMs = firstTokenMs + hashTokens(genTokens - 1)

        return IterResult(
            prefillTokS = promptTokens * 1000.0 / prefillMs.coerceAtLeast(1),
            decodeTokS = genTokens * 1000.0 / decodeMs.coerceAtLeast(1),
            ttftMs = (prefillMs + firstTokenMs).toDouble(),
        )
    }

    override fun unload() {
        buffer = null
    }
}
