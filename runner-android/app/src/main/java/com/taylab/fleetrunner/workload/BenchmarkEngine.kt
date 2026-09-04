package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.JobCancellation
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
 * separation, excluded from measurement), a fixed `measure_iters` count of
 * per-iteration result rows, then a final summary row (iter 0) that closes the
 * job.
 *
 * This measures a cold device, and only that. It used to also take a
 * `sustained_minutes` param that swapped the iteration count for a wall-clock
 * deadline, which was the thermal curve done by hand: no elapsed axis on the
 * rows, no summary of where the device turned, and a beacon every fifth
 * iteration on the assumption that iterations keep their length — the one
 * assumption a warming device breaks. The `thermal` workload does that job
 * properly, so the param is gone rather than left as a second way to ask for a
 * curve and get a worse one.
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
            var i = 0
            while (i < measures) {
                // A cancelled job stops between iterations, never mid-iteration:
                // the rows already posted stay valid, this one just never starts.
                if (JobCancellation.isCancelled(job.jobId)) {
                    backend.unload()
                    client.postResult(
                        ResultPost(
                            kind = "result", jobId = job.jobId, deviceId = deviceId,
                            iter = 0, final = true, ok = false,
                            device = Telemetry.descriptor(context),
                            error = "cancelled",
                        ),
                    )
                    return
                }
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
