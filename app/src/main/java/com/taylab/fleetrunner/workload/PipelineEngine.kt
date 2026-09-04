package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.JobCancellation
import com.taylab.fleetrunner.backend.ModelBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.protocol.stringParam
import com.taylab.fleetrunner.telemetry.Telemetry
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pipeline node: subscribe to a collector event topic, run each event's
 * prompt through the backend, publish the output to "<topic>.out". The tiered
 * home-pipeline pattern: cheap devices publish triggers, capable devices
 * process them. Runs until max_events, with beacons renewing the lease.
 */
class PipelineEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val topic = job.params.stringParam("topic")
        val maxEvents = job.params.intParam("max_events", 1)
        val maxTokens = job.params.intParam("max_tokens", 64)
        var cursor = job.params.intParam("after", 0).toLong()
        val backend = ModelBackend.forJob(job, ArtifactCache(context, client))
        try {
            requireNotNull(topic) { "pipeline job needs params.topic" }
            backend.load(job)

            var processed = 0
            while (processed < maxEvents) {
                // Checked before each poll, so a cancelled pipeline node stops
                // within one long-poll instead of waiting out max_events.
                if (JobCancellation.isCancelled(job.jobId)) {
                    backend.unload()
                    client.postResult(
                        ResultPost(
                            kind = "result", jobId = job.jobId, deviceId = deviceId,
                            iter = 0, final = true, ok = false, error = "cancelled",
                        ),
                    )
                    return
                }
                val event = client.pollEvent(topic, cursor) ?: continue
                cursor = event.id
                val prompt = event.payload.stringParam("prompt") ?: event.payload.toString()
                val t0 = System.nanoTime()
                val output = backend.generate(prompt, maxTokens)
                val ms = (System.nanoTime() - t0) / 1_000_000
                client.publishEvent(
                    "$topic.out",
                    buildJsonObject {
                        put("input_id", event.id)
                        put("device_id", deviceId)
                        put("output", output)
                        put("ms", ms)
                    }.toString(),
                )
                processed += 1
                client.postResult(
                    ResultPost(kind = "result", jobId = job.jobId, deviceId = deviceId, iter = processed, ok = true),
                )
            }
            backend.unload()
            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = true, device = Telemetry.descriptor(context),
                ),
            )
        } catch (e: Exception) {
            backend.unload()
            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = false,
                    error = e.message ?: e.javaClass.simpleName,
                ),
            )
        }
    }
}
