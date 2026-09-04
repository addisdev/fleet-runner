package com.taylab.fleetrunner.workload

import android.content.Context
import com.taylab.fleetrunner.JobCancellation
import com.taylab.fleetrunner.backend.ModelBackend
import com.taylab.fleetrunner.net.ArtifactCache
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import com.taylab.fleetrunner.telemetry.Telemetry

/**
 * The bookkeeping half of a thermal run: when the next iteration is due, when
 * the lease needs another beacon, and what the accumulated curve says.
 *
 * Split out from [ThermalEngine] and kept free of Context, of the backend and
 * of the clock — every method takes `nowMs` — because the thing most likely to
 * be wrong here is the loop arithmetic, and a loop that only reveals itself
 * after fifteen minutes on a warm phone is a loop nobody checks. This part runs
 * in a JVM test in microseconds.
 */
class ThermalRun(
    private val startedAtMs: Long,
    private val durationMs: Long,
    private val intervalMs: Long,
    private val beaconEveryMs: Long = BEACON_EVERY_MS,
) {
    companion object {
        /** Agents beacon every 60 s and the collector stops trusting a claim
         *  after three minutes; a measured iteration can easily outlast that,
         *  so the engine beacons on its own schedule rather than hoping the
         *  service loop gets a turn. */
        const val BEACON_EVERY_MS = 60_000L
        const val DEFAULT_DURATION_S = 900
    }

    private var lastBeaconAtMs = startedAtMs
    private var nextDueAtMs = startedAtMs
    private val states = mutableListOf<String>()
    private val decodeTokS = mutableListOf<Double>()
    private var turnAtS: Double? = null

    fun elapsedS(nowMs: Long): Double = (nowMs - startedAtMs) / 1000.0

    /** True while the fixed duration has not run out. Checked before each
     *  iteration starts, so the run overshoots by at most one iteration rather
     *  than stopping short of the duration it was asked for. */
    fun hasTimeLeft(nowMs: Long): Boolean = nowMs - startedAtMs < durationMs

    /**
     * How long to wait before starting the next iteration. `interval_s` paces
     * iteration *starts*, so it stays a fixed cadence rather than drifting by
     * however long each iteration took; at the default of 0 they run back to
     * back, which is the shape that actually heats a device.
     */
    fun waitBeforeNextMs(nowMs: Long): Long = (nextDueAtMs - nowMs).coerceAtLeast(0L)

    fun startedIteration(nowMs: Long) {
        nextDueAtMs = nowMs + intervalMs
    }

    fun dueToBeacon(nowMs: Long): Boolean = nowMs - lastBeaconAtMs >= beaconEveryMs

    fun beaconed(nowMs: Long) {
        lastBeaconAtMs = nowMs
    }

    /** Folds one finished iteration into the curve. */
    fun record(elapsedS: Double, decode: Double, thermal: String) {
        if (turnAtS == null && states.isNotEmpty() && states.first() != thermal) turnAtS = elapsedS
        states += thermal
        decodeTokS += decode
    }

    val iterations: Int get() = decodeTokS.size

    /** Throughput on the cold device. */
    val firstDecodeTokS: Double? get() = decodeTokS.firstOrNull()

    /** Throughput once the device has been running for the whole duration —
     *  the number the question is actually about. */
    val lastDecodeTokS: Double? get() = decodeTokS.lastOrNull()

    /** Every state in order, one per iteration: the thermal half of the curve. */
    val thermalStates: List<String> get() = states.toList()

    /** Elapsed seconds at the first iteration whose thermal state differed from
     *  the one the run started in, or null if it never left it. */
    val thermalTurnAtS: Double? get() = turnAtS
}

/**
 * Runs a thermal job: measured benchmark iterations back to back for a fixed
 * duration, one result row each, so the output is a curve rather than a number.
 *
 * The benchmark workload measures a cold device. This measures the same thing
 * repeatedly on a warming one — same backend, same [ModelBackend.runIteration]
 * measure step, no second inference path — because what a feature ships against
 * is the sustained figure, not the first-minute burst.
 *
 * Metric names are mirrored from the collector's schemas/metrics.json.
 * `elapsed_s` and `thermal_state` carry the curve's two axes. `battery_pct` is
 * not a metric name there — it is a beacon field — so per-iteration battery
 * rides `battery_end_pct`, as it does in the benchmark's rows.
 */
class ThermalEngine(
    private val context: Context,
    private val client: CollectorClient,
    private val deviceId: String,
) {
    fun run(job: JobSpec) {
        val durationS = job.params.intParam("duration_s", ThermalRun.DEFAULT_DURATION_S)
        val intervalS = job.params.intParam("interval_s", 0)
        val warmups = job.params.intParam("warmup_iters", 1)
        val batteryStart = Telemetry.batteryPct(context)

        val backend = ModelBackend.forJob(job, ArtifactCache(context, client))
        try {
            val loadMs = backend.load(job)
            // Warmups are excluded from the curve for the same reason they are
            // excluded from the benchmark: a first iteration pays for lazy
            // allocation, and here it would also be mistaken for the cold-device
            // reading the whole comparison hangs off.
            repeat(warmups) { backend.runIteration(job) }

            val run = ThermalRun(
                startedAtMs = System.currentTimeMillis(),
                durationMs = durationS * 1000L,
                intervalMs = intervalS * 1000L,
            )
            var iter = 0
            while (run.hasTimeLeft(System.currentTimeMillis())) {
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

                val wait = run.waitBeforeNextMs(System.currentTimeMillis())
                if (wait > 0) Thread.sleep(wait)

                run.startedIteration(System.currentTimeMillis())
                iter += 1
                val r = backend.runIteration(job)
                val now = System.currentTimeMillis()
                val thermal = Telemetry.thermal(context)
                val elapsedS = run.elapsedS(now)
                run.record(elapsedS, r.decodeTokS, thermal)

                client.postResult(
                    ResultPost(
                        kind = "result", jobId = job.jobId, deviceId = deviceId, iter = iter,
                        metrics = Metrics(
                            prefillTokS = r.prefillTokS, decodeTokS = r.decodeTokS,
                            ttftMs = r.ttftMs, peakMemMb = Telemetry.pssMb(),
                            // elapsed_s is the curve's x axis, measured by the
                            // runner rather than inferred from when the row
                            // happened to reach the collector. thermal_state is
                            // this sample; the thermal array is kept alongside
                            // it because a one-element array is what every
                            // existing reader of these rows already understands,
                            // and the two answer different questions.
                            elapsedS = elapsedS,
                            thermalState = thermal,
                            memMethod = "pss", thermal = listOf(thermal),
                            batteryEndPct = Telemetry.batteryPct(context),
                        ),
                    ),
                )

                // A quarter-hour run outlives the 600 s default lease, and the
                // collector gives thermal a long lease precisely so the curve
                // stays unbroken — but the lease still has to be renewed. Beacon
                // on elapsed time rather than every Nth iteration: iteration
                // length is exactly the thing this workload expects to change.
                if (run.dueToBeacon(now)) {
                    val ack = client.postResult(
                        ResultPost(
                            kind = "beacon", deviceId = deviceId, jobId = job.jobId,
                            beacon = Telemetry.beacon(context),
                        ),
                    )
                    run.beaconed(System.currentTimeMillis())
                    // Explicit false only: an unreachable collector throws to
                    // the catch below, as it does everywhere else.
                    if (!ack.leaseRenewed) JobCancellation.cancel(job.jobId)
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
                        // The sustained figure, not the mean. Averaging across a
                        // curve that is falling by design produces a number that
                        // describes no moment of the run; the cold reading is on
                        // the iter=1 row, where it can be read back exactly.
                        decodeTokS = run.lastDecodeTokS,
                        peakMemMb = Telemetry.pssMb(),
                        memMethod = "pss",
                        // The turn: elapsed seconds at the first iteration whose
                        // thermal state differed from the one the run started
                        // in. Same units and same origin as the per-iteration
                        // elapsed_s, so it reads as a point on the same axis —
                        // null when the device never left its starting state,
                        // which is the answer "it never got warm", not zero.
                        elapsedS = run.thermalTurnAtS,
                        // The state it turned into, so the summary says what
                        // happened and not merely when.
                        thermalState = run.thermalStates.lastOrNull(),
                        // Ordered, one per iteration: the whole sequence, for
                        // readers that want the shape rather than the turn.
                        thermal = run.thermalStates,
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
