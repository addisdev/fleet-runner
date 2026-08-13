package com.taylab.fleetrunner.backend

import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.protocol.JobSpec

data class IterResult(
    val prefillTokS: Double,
    val decodeTokS: Double,
    val ttftMs: Double,
)

/** One implementation per inference engine. Load is timed separately from iterations. */
interface ModelBackend {
    val name: String

    /** Load the model; returns load time in ms. */
    fun load(job: JobSpec): Long

    fun runIteration(job: JobSpec): IterResult

    fun unload()

    companion object {
        fun forJob(job: JobSpec, artifacts: ArtifactCache): ModelBackend = when (job.backend) {
            null, "synthetic" -> SyntheticBackend()
            "llama.cpp" -> LlamaCppBackend(artifacts)
            else -> throw IllegalArgumentException("unknown backend: ${job.backend}")
        }
    }
}
