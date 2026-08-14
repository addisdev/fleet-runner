package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.backend.ModelBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.protocol.stringParam
import com.taylab.fleetrunner.telemetry.Telemetry
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Batch: pull an items artifact ({"items": ["...", ...]}), process each item
 * through the backend (llama.cpp generates; synthetic digests), upload the
 * outputs as a new artifact, and reference it from the final result.
 */
class BatchEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val inputSha = job.params.stringParam("input_sha256")
        val maxTokens = job.params.intParam("max_tokens", 64)
        val cache = ArtifactCache(context, client)
        val backend = ModelBackend.forJob(job, cache)
        try {
            requireNotNull(inputSha) { "batch job needs params.input_sha256" }
            backend.load(job)

            val inputFile = cache.ensure(inputSha)
            val input = FleetJson.parseToJsonElement(inputFile.readText()) as JsonObject
            val items = input["items"]?.jsonArray
                ?: throw IllegalArgumentException("input artifact has no items array")

            val outputs = buildJsonArray {
                items.forEachIndexed { i, item ->
                    val prompt = item.jsonPrimitive.content
                    val t0 = System.nanoTime()
                    val output = backend.generate(prompt, maxTokens)
                    val ms = (System.nanoTime() - t0) / 1_000_000
                    add(buildJsonObject {
                        put("item", i)
                        put("output", output)
                        put("ms", ms)
                    })
                    client.postResult(
                        ResultPost(kind = "result", jobId = job.jobId, deviceId = deviceId, iter = i + 1, ok = true),
                    )
                }
            }
            backend.unload()

            val report = buildJsonObject {
                put("job_id", job.jobId)
                put("device_id", deviceId)
                put("backend", backend.name)
                put("outputs", outputs)
            }
            val sha = client.uploadArtifact(report.toString().toByteArray(), "${job.jobId}-outputs.json")
            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = true,
                    device = Telemetry.descriptor(context), artifacts = listOf(sha),
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
