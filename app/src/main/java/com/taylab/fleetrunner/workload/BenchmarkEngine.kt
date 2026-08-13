package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.backend.IterResult
import com.taylab.fleetrunner.backend.ModelBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.telemetry.Telemetry

/**
 * Runs a benchmark job: timed load, mandatory warmups (reported via load_ms
 * separation, excluded from measurement), per-iteration result rows, then a
 * final summary row (iter 0) that closes the job.
 */
class BenchmarkEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val warmups = job.params.intParam("warmup_iters", 1)
        val measures = job.params.intParam("measure_iters", 3)
        val batteryStart = Telemetry.batteryPct(context)
        val thermals = mutableListOf<String>()

        val backend = ModelBackend.forJob(job, ArtifactCache(context, client))
        try {
            val loadMs = backend.load(job)
            repeat(warmups) { backend.runIteration(job) }

            val iters = mutableListOf<IterResult>()
            for (i in 1..measures) {
                val r = backend.runIteration(job)
                iters += r
                val thermal = Telemetry.thermal(context)
                thermals += thermal
                client.postResult(
                    ResultPost(
                        kind = "result", jobId = job.jobId, deviceId = deviceId, iter = i,
                        metrics = Metrics(
                            prefillTokS = r.prefillTokS, decodeTokS = r.decodeTokS,
                            ttftMs = r.ttftMs, peakMemMb = Telemetry.pssMb(),
                            memMethod = "pss", thermal = listOf(thermal),
                        ),
                    ),
                )
            }
            backend.unload()

            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = true,
                    device = Telemetry.descriptor(context),
                    metrics = Metrics(
                        loadMs = loadMs,
                        prefillTokS = iters.map { it.prefillTokS }.average(),
                        decodeTokS = iters.map { it.decodeTokS }.average(),
                        ttftMs = iters.map { it.ttftMs }.average(),
                        peakMemMb = Telemetry.pssMb(),
                        memMethod = "pss",
                        thermal = thermals,
                        batteryStartPct = batteryStart,
                        batteryEndPct = Telemetry.batteryPct(context),
                    ),
                ),
            )
        } catch (e: Exception) {
            backend.unload()
            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = false,
                    device = Telemetry.descriptor(context),
                    error = e.message ?: e.javaClass.simpleName,
                ),
            )
        }
    }
}
