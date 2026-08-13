package com.taylab.fleetrunner.net

import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.RegisterPost
import com.taylab.fleetrunner.protocol.ResultPost
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Blocking HTTP client for the collector; call from Dispatchers.IO. */
class CollectorClient(baseUrl: String) {

    private val base = baseUrl.trimEnd('/')
    private val json = "application/json".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // The collector holds next-job long-polls for ~25 s; stay well above that.
        .readTimeout(40, TimeUnit.SECONDS)
        .build()

    fun register(post: RegisterPost) {
        val req = Request.Builder()
            .url("$base/devices/register")
            .post(FleetJson.encodeToString(post).toRequestBody(json))
            .build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("register failed: HTTP ${res.code}")
        }
    }

    /** Long-polls for work; null when the poll expired with no job (HTTP 204). */
    fun nextJob(deviceId: String): JobSpec? {
        val req = Request.Builder().url("$base/devices/$deviceId/next-job").build()
        http.newCall(req).execute().use { res ->
            return when {
                res.code == 204 -> null
                res.isSuccessful -> FleetJson.decodeFromString<JobSpec>(res.body!!.string())
                else -> throw IOException("next-job failed: HTTP ${res.code}")
            }
        }
    }

    /** Streams an artifact to [dest], verifying its content hash before the rename. */
    fun downloadArtifact(sha256: String, dest: File) {
        val req = Request.Builder().url("$base/artifacts/$sha256").build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("artifact $sha256 failed: HTTP ${res.code}")
            val tmp = File(dest.parentFile, "${dest.name}.part")
            val digest = MessageDigest.getInstance("SHA-256")
            tmp.outputStream().use { out ->
                val src = res.body!!.byteStream()
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = src.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                    out.write(buf, 0, n)
                }
            }
            val got = digest.digest().joinToString("") { "%02x".format(it) }
            if (got != sha256) {
                tmp.delete()
                throw IOException("artifact hash mismatch: wanted $sha256 got $got")
            }
            if (!tmp.renameTo(dest)) throw IOException("rename failed for $dest")
        }
    }

    fun postResult(row: ResultPost) {
        val req = Request.Builder()
            .url("$base/results")
            .post(FleetJson.encodeToString(row).toRequestBody(json))
            .build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IOException("results failed: HTTP ${res.code}")
        }
    }
}
