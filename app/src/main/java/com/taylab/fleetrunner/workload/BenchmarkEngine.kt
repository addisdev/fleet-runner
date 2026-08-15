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
        // Sustained mode: keep iterating for N minutes instead of a fixed count.
        // The per-iteration rows ARE the thermal curve — tok/s over wall time
        // is the honest number for real workloads, not the first-minute burst.
        val sustainedMinutes = job.params.intParam("sustained_minutes", 0)
        val batteryStart = Telemetry.batteryPct(context)
        val thermals = mutableListOf<String>()

        val backend = ModelBackend.forJob(job, ArtifactCache(context, client))
        try {
            val loadMs = backend.load(job)
            repeat(warmups) { backend.runIteration(job) }

            val iters = mutableListOf<IterResult>()
            val deadline = if (sustainedMinutes > 0) System.currentTimeMillis() + sustainedMinutes * 60_000L else 0L
            var i = 0
            while (if (sustainedMinutes > 0) System.currentTimeMillis() < deadline else i < measures) {
                i += 1
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
                            batteryEndPct = Telemetry.batteryPct(context),
                        ),
                    ),
                )
                if (sustainedMinutes > 0 && i % 5 == 0) {
                    // Sustained runs outlive the lease TTL: renew explicitly.
                    client.postResult(
                        ResultPost(kind = "beacon", deviceId = deviceId, jobId = job.jobId, beacon = Telemetry.beacon(context)),
                    )
                }
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
