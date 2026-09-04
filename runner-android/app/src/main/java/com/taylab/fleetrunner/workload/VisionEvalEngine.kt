package com.taylab.fleetrunner.workload

import android.content.Context
import android.graphics.BitmapFactory
import com.taylab.fleetrunner.JobCancellation
import com.taylab.fleetrunner.backend.LiteRtBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.protocol.stringParam
import com.taylab.fleetrunner.telemetry.Telemetry
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.zip.ZipInputStream

/**
 * Vision model evaluation (a `batch` job with backend litert): pull a zipped
 * eval set ({manifest.json: {items:[{file,label,...}]}} + images), classify
 * every image, and report top-1 / top-5 accuracy alongside per-image latency.
 * The workload the plan calls "plant-ID model evaluation": which model, at
 * which accuracy, at which latency, on which minimum device.
 */
class VisionEvalEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val setSha = job.params.stringParam("input_sha256")
        val warmups = job.params.intParam("warmup_iters", 3)
        val limit = job.params.intParam("max_items", Int.MAX_VALUE)
        val cache = ArtifactCache(context, client)
        val backend = LiteRtBackend(cache)
        val batteryStart = Telemetry.batteryPct(context)
        try {
            requireNotNull(setSha) { "vision eval needs params.input_sha256 (zipped eval set)" }
            val loadMs = backend.load(job)

            val dir = unzip(cache.ensure(setSha), File(context.cacheDir, "evalset-$setSha"))
            val manifest = FleetJson.parseToJsonElement(File(dir, "manifest.json").readText()).jsonObject
            val items = manifest["items"]!!.jsonArray.map { it.jsonObject }.take(limit)

            // Warmups on the first image (delegate compilation etc.), excluded.
            val first = BitmapFactory.decodeFile(File(dir, items[0].stringParam("file")!!).path)
            repeat(warmups) { backend.classify(first, 1) }

            var top1 = 0; var top5 = 0
            val latencies = LongArray(items.size)
            val thermals = mutableListOf<String>()
            val perImage = buildJsonArray {
                items.forEachIndexed { i, item ->
                    // Cancellation lands between images: no half-classified
                    // image, and no accuracy computed over a truncated set.
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
                    val file = File(dir, item.stringParam("file")!!)
                    val label = item.intParam("label", -1)
                    val bmp = BitmapFactory.decodeFile(file.path)
                    val (top, ms) = backend.classify(bmp, 5)
                    latencies[i] = ms
                    val hit1 = top.isNotEmpty() && top[0] == label
                    val hit5 = label in top
                    if (hit1) top1++
                    if (hit5) top5++
                    if (i % 20 == 0) thermals += Telemetry.thermal(context)
                    add(buildJsonObject {
                        put("file", item.stringParam("file"))
                        put("label", label)
                        put("top1", top.firstOrNull() ?: -1)
                        put("hit1", hit1); put("hit5", hit5); put("ms", ms)
                    })
                    if ((i + 1) % 20 == 0) {
                        client.postResult(
                            ResultPost(kind = "result", jobId = job.jobId, deviceId = deviceId, iter = i + 1, ok = true),
                        )
                    }
                }
            }
            backend.unload()

            val sorted = latencies.sorted()
            val n = items.size
            val report = buildJsonObject {
                put("job_id", job.jobId); put("device_id", deviceId)
                put("model", job.model?.name); put("accelerator", backend.acceleratorUsed)
                put("input_size", backend.size); put("classes", backend.classes)
                put("items", n)
                put("top1_acc", top1.toDouble() / n); put("top5_acc", top5.toDouble() / n)
                put("latency_p50_ms", sorted[n / 2]); put("latency_p95_ms", sorted[(n * 95) / 100])
                put("latency_mean_ms", latencies.average())
                put("load_ms", loadMs)
                put("per_image", perImage)
            }
            val sha = client.uploadArtifact(report.toString().toByteArray(), "${job.jobId}-eval.json")

            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true, ok = true,
                    device = Telemetry.descriptor(context),
                    metrics = Metrics(
                        loadMs = loadMs,
                        // Named fields, not the LLM slots. Accuracy stored under
                        // decode_tok_s was never chartable anyway -- the bench
                        // page filters workload = 'benchmark' and this is a
                        // batch job -- and top-5 and p95 reached only the report
                        // artifact, which is why they had to be read by hand.
                        top1Pct = top1.toDouble() / n * 100.0,
                        top5Pct = top5.toDouble() / n * 100.0,
                        p50Ms = sorted[n / 2].toDouble(),
                        p95Ms = sorted[(n * 95) / 100].toDouble(),
                        imagesPerS = 1000.0 / sorted[n / 2].coerceAtLeast(1),
                        peakMemMb = Telemetry.pssMb(), memMethod = "pss",
                        thermal = thermals,
                        batteryStartPct = batteryStart, batteryEndPct = Telemetry.batteryPct(context),
                    ),
                    artifacts = listOf(sha),
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

    private fun unzip(zip: File, dest: File): File {
        if (File(dest, "manifest.json").exists()) return dest
        dest.mkdirs()
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            var entry = zin.nextEntry
            while (entry != null) {
                val out = File(dest, entry.name)
                if (!out.canonicalPath.startsWith(dest.canonicalPath)) throw SecurityException("zip slip")
                if (entry.isDirectory) out.mkdirs() else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zin.copyTo(it) }
                }
                entry = zin.nextEntry
            }
        }
        return dest
    }
}
