package com.taylab.fleetrunner

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.BeaconSample
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.RegisterPost
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.telemetry.Telemetry
import com.taylab.fleetrunner.workload.BatchEngine
import com.taylab.fleetrunner.workload.BenchmarkEngine
import com.taylab.fleetrunner.workload.EmbedEvalEngine
import com.taylab.fleetrunner.workload.PipelineEngine
import com.taylab.fleetrunner.workload.ThermalEngine
import com.taylab.fleetrunner.workload.VantageEngine
import com.taylab.fleetrunner.workload.VisionEvalEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Foreground service hosting the agent loop and the telemetry beacon. */
class RunnerService : Service() {

    companion object {
        private const val CHANNEL = "fleet-runner"
        private const val NOTIF_ID = 1
        private const val EXTRA_BASE_URL = "base_url"
        private const val EXTRA_DEVICE_ID = "device_id"
        private const val BEACON_INTERVAL_MS = 60_000L
        private const val ERROR_BACKOFF_MS = 10_000L

        private val _status = MutableStateFlow("stopped")
        val status: StateFlow<String> = _status

        /**
         * What the agent is doing, as a value rather than as prose.
         *
         * [status] is still the sentence — it carries job ids and error text,
         * and Maestro flows read it off the screen. This is the same
         * information in the form a layout needs: something to colour a dot by
         * and to choose a headline from, without the Activity parsing English
         * out of a string.
         */
        enum class Phase {
            STOPPED, STARTING, REGISTERING, POLLING, RUNNING, FAILING;

            val headline: String
                get() = when (this) {
                    STOPPED -> "Stopped"
                    STARTING -> "Starting"
                    REGISTERING -> "Registering"
                    POLLING -> "Polling for work"
                    RUNNING -> "Running a job"
                    FAILING -> "Cannot reach the collector"
                }

            /** True while the agent is in contact with the collector. */
            val connected: Boolean get() = this == POLLING || this == RUNNING
        }

        /** A job this device is running, or has just finished. */
        data class JobState(
            val jobId: String,
            val workload: String,
            val startedAt: Long,
            val finishedAt: Long? = null,
        )

        private val _phase = MutableStateFlow(Phase.STOPPED)
        val phase: StateFlow<Phase> = _phase

        /**
         * The last beacon, so the screen shows the numbers the collector was
         * sent rather than readings taken a second later. Null until the first
         * beacon goes out; the Activity fills the tiles locally before then.
         */
        private val _beacon = MutableStateFlow<BeaconSample?>(null)
        val beacon: StateFlow<BeaconSample?> = _beacon

        private val _network = MutableStateFlow("unknown")
        val network: StateFlow<String> = _network

        /** When the last beacon went out, as elapsed-realtime millis. */
        private val _lastBeaconAt = MutableStateFlow<Long?>(null)
        val lastBeaconAt: StateFlow<Long?> = _lastBeaconAt

        private val _job = MutableStateFlow<JobState?>(null)
        val job: StateFlow<JobState?> = _job

        fun start(context: Context, baseUrl: String, deviceId: String) {
            val intent = Intent(context, RunnerService::class.java)
                .putExtra(EXTRA_BASE_URL, baseUrl)
                .putExtra(EXTRA_DEVICE_ID, deviceId)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RunnerService::class.java))
        }
    }

    private var scope: CoroutineScope? = null
    private var wakeLock: android.os.PowerManager.WakeLock? = null

    // The beacon stamps this onto its posts: a beacon carrying a job_id renews
    // that job's lease, so long benchmarks aren't swept mid-run.
    @Volatile
    private var currentJobId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL) ?: return START_NOT_STICKY
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return START_NOT_STICKY

        startForeground(NOTIF_ID, buildNotification(deviceId))
        _phase.value = Phase.STARTING

        // Screen-off CPU throttling silently poisons benchmarks (observed:
        // 0.6s -> 85s per batch item on an SM-X930 as the screen slept). A
        // fleet device with the agent running holds a partial wakelock.
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            wakeLock = pm.newWakeLock(
                android.os.PowerManager.PARTIAL_WAKE_LOCK, "fleetrunner:agent",
            ).also { it.setReferenceCounted(false); it.acquire() }
        }

        scope?.cancel()
        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s
        val client = CollectorClient(baseUrl)
        s.launch { agentLoop(client, deviceId) }
        s.launch { beaconLoop(client, deviceId) }
        return START_STICKY
    }

    /**
     * One workload this runner can run: what it declares to the collector, and
     * what it does when a job of that kind arrives.
     *
     * [capability] is the string the queue routes on. Usually that is the
     * workload name; where a runner can only serve one backend of a workload it
     * is the backend-qualified form the collector understands ("batch:litert").
     */
    private class Route(
        val capability: String,
        val workload: String,
        /** null matches any backend; a value claims only that backend. */
        val backend: String? = null,
        val run: (JobSpec) -> Unit,
    )

    /**
     * Every workload this runner dispatches, with what it declares for each.
     *
     * This list is the single source for both halves: the capabilities sent at
     * registration are its `capability` column, and the dispatch in [agentLoop]
     * is its `run` column, so declaring a workload and being able to run it are
     * now one act. They used to be a hand-kept list sitting next to a `when`,
     * which is a pair of things that agree only until someone edits one of them
     * — and the failure is silent in the worst direction: the collector routes
     * us work we bounce straight back as "not supported by this runner yet".
     */
    private fun routes(client: CollectorClient, deviceId: String) = listOf(
        Route("benchmark", "benchmark") { BenchmarkEngine(this, client, deviceId).run(it) },
        Route("batch", "batch") { BatchEngine(this, client, deviceId).run(it) },
        Route("batch:litert", "batch", "litert") { VisionEvalEngine(this, client, deviceId).run(it) },
        Route("pipeline", "pipeline") { PipelineEngine(this, client, deviceId).run(it) },
        Route("thermal", "thermal") { ThermalEngine(this, client, deviceId).run(it) },
        Route("embed-eval", "embed-eval") { EmbedEvalEngine(this, client, deviceId).run(it) },
        Route("vantage", "vantage") { VantageEngine(this, client, deviceId).run(it) },
    )

    /**
     * The route for a job, or null when this runner has none. A route naming a
     * backend wins over the workload's general route — that is what makes
     * `batch` + backend litert reach the vision eval — and declaration order
     * stays free to be the order we want to register in.
     */
    private fun routeFor(routes: List<Route>, job: JobSpec): Route? =
        routes.firstOrNull { it.workload == job.workload && it.backend != null && it.backend == job.backend }
            ?: routes.firstOrNull { it.workload == job.workload && it.backend == null }

    private suspend fun agentLoop(client: CollectorClient, deviceId: String) {
        val routes = routes(client, deviceId)
        while (true) {
            try {
                _status.value = "registering as $deviceId"
                _phase.value = Phase.REGISTERING
                client.register(
                    RegisterPost(
                        deviceId = deviceId,
                        descriptor = Telemetry.descriptor(this),
                        pools = listOf("ml-capable"),
                        // Derived from the routes above rather than written
                        // out again: the collector's routing only offers this
                        // runner work it can actually dispatch.
                        capabilities = routes.map { it.capability },
                    ),
                )
                while (true) {
                    _status.value = "polling for work"
                    _phase.value = Phase.POLLING
                    val job = client.nextJob(deviceId) ?: continue

                    // Enforce the job's device-state contract before burning
                    // battery or attempts on a run whose numbers would lie:
                    // on-battery + screen-off CPU throttling was observed to
                    // slow decode ~100x on Samsung hardware.
                    val constraintError = checkConstraints(job)
                    if (constraintError != null) {
                        client.postResult(
                            ResultPost(
                                kind = "result", jobId = job.jobId, deviceId = deviceId,
                                iter = 0, final = true, ok = false, error = constraintError,
                            ),
                        )
                        _status.value = "rejected ${job.jobId}: $constraintError"
                        continue
                    }

                    _status.value = "running ${job.jobId}"
                    _phase.value = Phase.RUNNING
                    _job.value = JobState(job.jobId, job.workload, System.currentTimeMillis())
                    currentJobId = job.jobId
                    try {
                        val route = routeFor(routes, job)
                        if (route != null) {
                            route.run(job)
                        } else {
                            client.postResult(
                                ResultPost(
                                    kind = "result", jobId = job.jobId, deviceId = deviceId,
                                    iter = 0, final = true, ok = false,
                                    error = "workload '${job.workload}' not supported by this runner yet",
                                ),
                            )
                        }
                    } finally {
                        currentJobId = null
                        JobCancellation.clear(job.jobId)
                    }
                    _status.value = "finished ${job.jobId}"
                    // No ok/failed verdict: the engines post their own final
                    // rows and the service never sees the outcome, so a badge
                    // here would be a guess. The collector has the verdict.
                    _job.value = _job.value?.copy(finishedAt = System.currentTimeMillis())
                }
            } catch (e: Exception) {
                _status.value = "error: ${e.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s"
                _phase.value = Phase.FAILING
                delay(ERROR_BACKOFF_MS)
            }
        }
    }

    private fun checkConstraints(job: JobSpec): String? {
        val c = job.constraints ?: return null
        if (c.requireCharging == true && !Telemetry.isCharging(this)) {
            return "constraint not met: require_charging (device is on battery)"
        }
        val minBattery = c.minBatteryPct
        if (minBattery != null && Telemetry.batteryPct(this) < minBattery) {
            return "constraint not met: min_battery_pct $minBattery (at ${Telemetry.batteryPct(this)}%)"
        }
        return null
    }

    private suspend fun beaconLoop(client: CollectorClient, deviceId: String) {
        while (true) {
            try {
                val jobId = currentJobId
                val ack = client.postResult(
                    ResultPost(
                        kind = "beacon", deviceId = deviceId,
                        jobId = jobId, // renews the running job's lease
                        beacon = Telemetry.beacon(this),
                    ),
                )
                // Published after the post, so the screen shows what was
                // actually sent rather than what we were about to send.
                _beacon.value = Telemetry.beacon(this)
                _network.value = Telemetry.networkType(this)
                _lastBeaconAt.value = System.currentTimeMillis()
                // The collector answering a job-carrying beacon with
                // lease_renewed:false means the claim is gone — cancelled from
                // the dashboard, or swept — so tell the engine to stop. Only
                // that explicit answer counts: an unreachable collector or a
                // non-2xx throws instead, and is swallowed below as before.
                if (jobId != null && !ack.leaseRenewed) JobCancellation.cancel(jobId)
            } catch (_: Exception) {
                // Beacon is best-effort; the agent loop owns error reporting.
            }
            delay(BEACON_INTERVAL_MS)
        }
    }

    private fun buildNotification(deviceId: String): android.app.Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Fleet Runner", NotificationManager.IMPORTANCE_LOW),
            )
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Fleet Runner")
            .setContentText("Agent active as $deviceId")
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        scope?.cancel()
        scope = null
        wakeLock?.release()
        wakeLock = null
        _status.value = "stopped"
        _phase.value = Phase.STOPPED
        _job.value = null
        super.onDestroy()
    }
}
