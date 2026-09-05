package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.JobCancellation
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.protocol.stringListParam
import com.taylab.fleetrunner.telemetry.Telemetry
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToLong

/** The moments of one HTTP request that the two platforms can both see. */
enum class RequestEvent {
    CALL_START,
    DNS_START,
    DNS_END,
    CONNECT_START,
    TLS_START,
    TLS_END,
    CONNECT_END,
    RESPONSE_START,
    CALL_END,
    ;

    /**
     * Starts keep the first timestamp they are given, ends the last. A request
     * that retries — a second address from a multi-A record, a happy-eyeballs
     * race — fires connectStart more than once, and the honest cost of getting
     * connected is the whole span, not the last attempt.
     */
    val keepsFirst: Boolean get() = name.endsWith("_START")
}

/**
 * The phases of one request in milliseconds, as they are reported.
 *
 * Every field is nullable and that is load-bearing: a request served over a
 * pooled connection resolves no name, opens no socket and shakes no hands, so
 * those phases did not happen. Reported as 0 they would read as "instant",
 * which is a different and much more flattering claim.
 */
data class RequestPhases(
    val dnsMs: Double?,
    val connectMs: Double?,
    val tlsMs: Double?,
    val ttfbMs: Double?,
    val loadMs: Long?,
)

/**
 * Turns raw event timestamps into the five reported phases.
 *
 * Split out from the OkHttp listener and given no sockets, no clock and no
 * client so the mapping can be tested exactly: the arithmetic here is the
 * whole workload, and "connect_ms accidentally included the TLS handshake" is
 * the kind of wrong that produces perfectly reasonable-looking numbers on
 * every device in the fleet at once.
 *
 * The definitions are chosen to mean the same thing as the iOS runner's
 * `URLSessionTaskMetrics`, which is the only reason a phone's number and a
 * laptop's number can be put in one column:
 *
 * | reported      | here                                   | URLSessionTaskMetrics                          |
 * |---------------|----------------------------------------|------------------------------------------------|
 * | `dns_ms`      | dnsStart → dnsEnd                      | domainLookupStart → domainLookupEnd            |
 * | `connect_ms`  | connectStart → secureConnectStart      | connectStart → secureConnectionStart           |
 * |               | (or connectEnd when there is no TLS)   | (or connectEnd)                                |
 * | `tls_ms`      | secureConnectStart → secureConnectEnd  | secureConnectionStart → secureConnectionEnd    |
 * | `ttfb_ms`     | callStart → responseHeadersStart       | fetchStart → responseStart                     |
 * | `load_ms`     | callStart → callEnd                    | fetchStart → responseEnd                       |
 *
 * `connect_ms` is deliberately TCP only. Apple's `connectEnd` sits *after* the
 * handshake, so taking connectStart → connectEnd on both sides would have
 * Android reporting TCP and iOS reporting TCP + TLS under one name, with the
 * TLS time then counted twice on iOS and once on Android.
 */
class RequestTimeline {
    private val at = HashMap<RequestEvent, Long>()

    /** Records [event] at [nanos] (a monotonic reading, not a wall clock). */
    fun mark(event: RequestEvent, nanos: Long) {
        if (event.keepsFirst && at.containsKey(event)) return
        at[event] = nanos
    }

    fun phases(): RequestPhases {
        val callStart = at[RequestEvent.CALL_START]
        // TLS is a sub-interval of Apple's connect, so the TCP part ends where
        // the handshake begins; with no TLS it ends at connectEnd.
        val tcpEnd = at[RequestEvent.TLS_START] ?: at[RequestEvent.CONNECT_END]
        return RequestPhases(
            dnsMs = span(RequestEvent.DNS_START, RequestEvent.DNS_END),
            connectMs = at[RequestEvent.CONNECT_START]?.let { s -> tcpEnd?.let { ms(s, it) } },
            tlsMs = span(RequestEvent.TLS_START, RequestEvent.TLS_END),
            ttfbMs = callStart?.let { s -> at[RequestEvent.RESPONSE_START]?.let { ms(s, it) } },
            loadMs = callStart?.let { s -> at[RequestEvent.CALL_END]?.let { ms(s, it).roundToLong() } },
        )
    }

    private fun span(from: RequestEvent, to: RequestEvent): Double? {
        val s = at[from] ?: return null
        val e = at[to] ?: return null
        return ms(s, e)
    }

    /** Never negative: a clamped 0 is a rounding artefact, a negative duration
     *  is nonsense that would poison a median. */
    private fun ms(from: Long, to: Long): Double = ((to - from) / 1_000_000.0).coerceAtLeast(0.0)
}

/** Feeds an OkHttp call's events into a [RequestTimeline]. */
private class VantageListener(private val timeline: RequestTimeline) : EventListener() {
    private fun now() = System.nanoTime()

    override fun callStart(call: Call) = timeline.mark(RequestEvent.CALL_START, now())
    override fun dnsStart(call: Call, domainName: String) =
        timeline.mark(RequestEvent.DNS_START, now())
    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) =
        timeline.mark(RequestEvent.DNS_END, now())
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) =
        timeline.mark(RequestEvent.CONNECT_START, now())
    override fun secureConnectStart(call: Call) = timeline.mark(RequestEvent.TLS_START, now())
    override fun secureConnectEnd(call: Call, handshake: Handshake?) =
        timeline.mark(RequestEvent.TLS_END, now())
    override fun connectEnd(
        call: Call,
        inetSocketAddress: InetSocketAddress,
        proxy: Proxy,
        protocol: Protocol?,
    ) = timeline.mark(RequestEvent.CONNECT_END, now())
    override fun responseHeadersStart(call: Call) = timeline.mark(RequestEvent.RESPONSE_START, now())
    override fun callEnd(call: Call) = timeline.mark(RequestEvent.CALL_END, now())
    override fun callFailed(call: Call, ioe: IOException) =
        timeline.mark(RequestEvent.CALL_END, now())
}

/**
 * vantage: fetch a list of URLs and record connection timings from wherever
 * this device happens to be.
 *
 * A phone on cellular, a laptop on café wifi and a desktop on home fibre give
 * three different answers to the same question, and that spread *is* the
 * measurement — which is why `network_type` rides on every row. A latency
 * figure with no idea what carried it is not comparable to anything.
 *
 * One result row per URL per repetition. A URL that answers 500 is a row with
 * `ok: false`; so is one whose connection was refused. Neither fails the job —
 * the job failed only if it could not run at all (no URLs to fetch), because a
 * site being down is exactly the sort of thing this workload exists to notice,
 * not an error in the runner.
 */
class VantageEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    companion object {
        const val DEFAULT_TIMEOUT_S = 30
        /** A response the server meant to give. 4xx and 5xx are answers too,
         *  but they are answers to a question the caller got wrong or the
         *  server could not serve, so the row is marked not-ok and the timings
         *  stay — a 500 that took 4 s is a real 4 s. */
        fun ok(code: Int): Boolean = code in 100..399
    }

    fun run(job: JobSpec) {
        val urls = job.params.stringListParam("urls")
        val repeats = job.params.intParam("repeats", 1).coerceAtLeast(1)
        val timeoutS = job.params.intParam("timeout_s", DEFAULT_TIMEOUT_S).toLong()
        val batteryStart = Telemetry.batteryPct(context)
        try {
            require(urls.isNotEmpty()) { "vantage needs params.urls (a non-empty list)" }

            val pending = AtomicReference<RequestTimeline>()
            val http = OkHttpClient.Builder()
                .callTimeout(timeoutS, TimeUnit.SECONDS)
                .connectTimeout(timeoutS, TimeUnit.SECONDS)
                .readTimeout(timeoutS, TimeUnit.SECONDS)
                // Redirects are not followed: with them on, one call covers
                // several requests and `ttfb_ms` silently becomes "time to the
                // first byte of the last hop". A 301 is a row of its own, with
                // its own honest phases.
                .followRedirects(false)
                .followSslRedirects(false)
                .eventListenerFactory(object : EventListener.Factory {
                    // Requests run one at a time here, so the timeline this
                    // factory hands out is the one the next call will fill.
                    override fun create(call: Call) =
                        VantageListener(RequestTimeline().also(pending::set))
                })
                .build()

            var iter = 0
            var okRows = 0
            val dns = mutableListOf<Double>()
            val connect = mutableListOf<Double>()
            val tls = mutableListOf<Double>()
            val ttfb = mutableListOf<Double>()
            val load = mutableListOf<Double>()
            val networks = mutableListOf<String>()

            val rows = buildJsonArray {
                // Repetition-major: each repeat is one sweep of the whole list,
                // so the repeats of a single URL are spread across the run
                // rather than hammering one host back to back.
                for (repeat in 1..repeats) {
                    for (url in urls) {
                        // Cancellation lands between requests: the rows already
                        // posted stay valid, this one just never happens.
                        if (JobCancellation.isCancelled(job.jobId)) {
                            client.postResult(
                                ResultPost(
                                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                                    iter = 0, final = true, ok = false,
                                    device = Telemetry.descriptor(context), error = "cancelled",
                                ),
                            )
                            return
                        }

                        iter += 1
                        // Read per request, not once per job: a device can
                        // leave wifi mid-run, and the rows on either side of
                        // that are honestly different measurements.
                        val network = Telemetry.networkType(context)
                        var status: Int? = null
                        var failure: String? = null
                        var bytes = 0L
                        // Cleared per request: a URL so malformed that no call
                        // is ever made must not inherit the previous row's
                        // timings.
                        pending.set(null)
                        try {
                            val req = Request.Builder().url(url).build()
                            http.newCall(req).execute().use { res ->
                                status = res.code
                                // The body has to be read for load_ms to mean
                                // "until it was all here" rather than "until
                                // the headers arrived"; callEnd fires when the
                                // body is done.
                                bytes = res.body?.bytes()?.size?.toLong() ?: 0L
                            }
                        } catch (e: Exception) {
                            // A refused connection, a DNS failure or a timeout
                            // is this device's answer about this URL, which is
                            // data. The phases collected before it gave up are
                            // still reported.
                            failure = e.message ?: e.javaClass.simpleName
                        }

                        val phases = pending.get()?.phases()
                            ?: RequestPhases(null, null, null, null, null)
                        val rowOk = status?.let { ok(it) } ?: false
                        if (rowOk) {
                            okRows++
                            phases.dnsMs?.let(dns::add)
                            phases.connectMs?.let(connect::add)
                            phases.tlsMs?.let(tls::add)
                            phases.ttfbMs?.let(ttfb::add)
                            phases.loadMs?.let { load += it.toDouble() }
                        }
                        networks += network

                        client.postResult(
                            ResultPost(
                                kind = "result", jobId = job.jobId, deviceId = deviceId,
                                iter = iter, ok = rowOk,
                                error = failure ?: status?.takeIf { !ok(it) }?.let { "HTTP $it" },
                                metrics = Metrics(
                                    dnsMs = phases.dnsMs,
                                    connectMs = phases.connectMs,
                                    tlsMs = phases.tlsMs,
                                    ttfbMs = phases.ttfbMs,
                                    loadMs = phases.loadMs,
                                    networkType = network,
                                ),
                            ),
                        )

                        // The rows carry no URL — the result schema has no
                        // field for one — so the artifact is what says which
                        // iter was which URL. Without it the run is a column of
                        // anonymous latencies.
                        add(buildJsonObject {
                            put("iter", iter); put("repeat", repeat); put("url", url)
                            put("status", status); put("ok", rowOk); put("error", failure)
                            put("network_type", network)
                            put("dns_ms", phases.dnsMs); put("connect_ms", phases.connectMs)
                            put("tls_ms", phases.tlsMs); put("ttfb_ms", phases.ttfbMs)
                            put("load_ms", phases.loadMs); put("bytes", bytes)
                        })
                    }
                }
            }

            val report = buildJsonObject {
                put("job_id", job.jobId); put("device_id", deviceId)
                put("urls", urls.size); put("repeats", repeats)
                put("rows", iter); put("rows_ok", okRows)
                put("network_types", buildJsonArray { networks.distinct().forEach { add(JsonPrimitive(it)) } })
                put("requests", rows)
            }
            val sha = client.uploadArtifact(report.toString().toByteArray(), "${job.jobId}-vantage.json")

            client.postResult(
                ResultPost(
                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                    iter = 0, final = true,
                    // The job ran. Whether the internet answered is the finding,
                    // not the verdict.
                    ok = true,
                    device = Telemetry.descriptor(context),
                    metrics = Metrics(
                        // Medians over the ok rows only, so one refused
                        // connection cannot pull the summary toward a timeout
                        // that was never a latency. Same field names as the
                        // per-request rows because it is the same quantity
                        // aggregated — the per-URL rows above are the data, and
                        // the collector's views build series from the !final
                        // ones, so the two readings never land in one series.
                        dnsMs = medianOrNull(dns),
                        connectMs = medianOrNull(connect),
                        tlsMs = medianOrNull(tls),
                        ttfbMs = medianOrNull(ttfb),
                        loadMs = medianOrNull(load)?.roundToLong(),
                        // One word when the device stayed on one transport for
                        // the whole run, which is the normal case. A run that
                        // changed transport says so rather than picking one.
                        networkType = networks.distinct().sorted().joinToString("+").ifEmpty { "unknown" },
                        peakMemMb = Telemetry.pssMb(), memMethod = "pss",
                        thermal = listOf(Telemetry.thermal(context)),
                        batteryStartPct = batteryStart, batteryEndPct = Telemetry.batteryPct(context),
                    ),
                    artifacts = listOf(sha),
                ),
            )
        } catch (e: Exception) {
            // Only a job that could not run at all lands here: no URLs, or the
            // collector refusing the rows.
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

    private fun medianOrNull(values: List<Double>): Double? =
        values.takeIf { it.isNotEmpty() }?.let { Percentile.ofUnsorted(it, 50) }
}
