package com.taylab.fleetrunner.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Kotlin mirror of fleet-collector's schemas/{job,result}.schema.json ("schema": 1).
 * Shared protocol, not shared code: the iOS runner mirrors these independently.
 */
val FleetJson = Json {
    ignoreUnknownKeys = true
    // encodeDefaults so `schema = 1` is always on the wire (the collector
    // rejects rows without it); explicitNulls=false keeps unset fields out.
    encodeDefaults = true
    explicitNulls = false
}

@Serializable
data class ModelRef(
    val name: String,
    val format: String,
    val quant: String? = null,
    val sha256: String,
)

@Serializable
data class Targets(
    val pool: String? = null,
    val match: String? = null,
    val exclusive: Boolean? = null,
)

@Serializable
data class Constraints(
    @SerialName("require_charging") val requireCharging: Boolean? = null,
    @SerialName("min_battery_pct") val minBatteryPct: Int? = null,
)

@Serializable
data class JobSpec(
    val schema: Int,
    @SerialName("job_id") val jobId: String,
    val workload: String,
    val executor: String,
    val model: ModelRef? = null,
    val backend: String? = null,
    val params: JsonObject? = null,
    val targets: Targets? = null,
    val constraints: Constraints? = null,
)

fun JsonObject?.intParam(key: String, default: Int): Int =
    this?.get(key)?.jsonPrimitive?.intOrNull ?: default

fun JsonObject?.stringParam(key: String): String? =
    this?.get(key)?.jsonPrimitive?.contentOrNull

@Serializable
data class DeviceDescriptor(
    val model: String,
    val soc: String,
    @SerialName("ram_mb") val ramMb: Long,
    val os: String,
    @SerialName("app_ver") val appVer: String,
)

@Serializable
data class Metrics(
    @SerialName("load_ms") val loadMs: Long? = null,
    @SerialName("prefill_tok_s") val prefillTokS: Double? = null,
    @SerialName("decode_tok_s") val decodeTokS: Double? = null,
    @SerialName("ttft_ms") val ttftMs: Double? = null,
    @SerialName("peak_mem_mb") val peakMemMb: Long? = null,
    @SerialName("mem_method") val memMethod: String? = null,
    val thermal: List<String>? = null,
    @SerialName("battery_start_pct") val batteryStartPct: Int? = null,
    @SerialName("battery_end_pct") val batteryEndPct: Int? = null,
)

@Serializable
data class BeaconSample(
    @SerialName("battery_pct") val batteryPct: Int,
    val charging: Boolean,
    val thermal: String,
)

@Serializable
data class ResultPost(
    val schema: Int = 1,
    val kind: String,
    @SerialName("job_id") val jobId: String? = null,
    @SerialName("device_id") val deviceId: String,
    val iter: Int? = null,
    val final: Boolean? = null,
    val ok: Boolean? = null,
    val device: DeviceDescriptor? = null,
    val metrics: Metrics? = null,
    val beacon: BeaconSample? = null,
    val error: String? = null,
    /** sha256 refs of output artifacts (batch results, reports). */
    val artifacts: List<String>? = null,
)

@Serializable
data class RegisterPost(
    @SerialName("device_id") val deviceId: String,
    val descriptor: DeviceDescriptor,
    val pools: List<String>,
)
