package com.taylab.fleetrunner.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Kotlin mirror of the collector's schemas/{job,result}.schema.json ("schema": 1).
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

/**
 * A params array of strings — `params.urls` for vantage. Missing reads as
 * empty rather than as an error, so the workload owns the "you asked for no
 * URLs" message instead of the JSON layer throwing something less useful.
 */
fun JsonObject?.stringListParam(key: String): List<String> =
    (this?.get(key) as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()

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

    // vision-eval. These used to ride in the LLM slots above -- accuracy in
    // decode_tok_s, latency in ttft_ms, throughput in prefill_tok_s -- and
    // top-5 and p95 had nowhere to go at all, so they only ever reached the
    // uploaded report artifact and never the results table.
    @SerialName("top1_pct") val top1Pct: Double? = null,
    @SerialName("top5_pct") val top5Pct: Double? = null,
    @SerialName("p50_ms") val p50Ms: Double? = null,
    @SerialName("p95_ms") val p95Ms: Double? = null,
    @SerialName("images_per_s") val imagesPerS: Double? = null,

    // thermal. The `thermal` array above is the whole run's state sequence;
    // these two describe one sample, which is what makes a row a point on a
    // curve rather than a summary of one. thermal_state is a String and not an
    // enum on purpose: Android and iOS name their levels differently, and
    // flattening them here would invent a scale neither vendor publishes.
    @SerialName("elapsed_s") val elapsedS: Double? = null,
    @SerialName("thermal_state") val thermalState: String? = null,

    // embed-eval. A query counts at k when at least one of its relevant docs
    // is in its top k, which is how the collector's schema defines
    // recall_at_1 ("fraction of queries whose top hit is relevant") and so is
    // what the other two have to mean as well. `dim` rides along because
    // recall is only comparable within one embedding width -- two models at
    // 0.71 mean nothing to each other if one of them is 384-d and the other
    // 1024-d. p50_ms/p95_ms are per-embedding latency, the same quantity the
    // vision eval puts there (per-item inference), over this run's embeddings.
    @SerialName("recall_at_1") val recallAt1: Double? = null,
    @SerialName("recall_at_5") val recallAt5: Double? = null,
    @SerialName("recall_at_10") val recallAt10: Double? = null,
    @SerialName("docs_per_s") val docsPerS: Double? = null,
    val dim: Int? = null,

    // vantage. One row per URL per repetition carries this device's view of
    // one request. Every phase is nullable on purpose: a request that reuses a
    // pooled connection resolves no name, opens no socket and shakes no hands,
    // and reporting those as 0 ms would read as "instant" rather than as "did
    // not happen". `load_ms` here is the whole transfer, not a model load --
    // the same field name the benchmark uses for its own load, which is the
    // only name metrics.json offers for "how long until it was all here".
    // `network_type` is what the fleet is actually for: the same URL measured
    // from cellular and from fibre is two answers, and a latency figure with
    // no idea what carried it is not comparable to anything.
    @SerialName("dns_ms") val dnsMs: Double? = null,
    @SerialName("connect_ms") val connectMs: Double? = null,
    @SerialName("tls_ms") val tlsMs: Double? = null,
    @SerialName("ttfb_ms") val ttfbMs: Double? = null,
    @SerialName("network_type") val networkType: String? = null,
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
    /** Workloads this runner can actually dispatch; the queue routes on them. */
    val capabilities: List<String> = emptyList(),
)
