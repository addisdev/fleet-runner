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
import com.taylab.fleetrunner.protocol.RegisterPost
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.telemetry.Telemetry
import com.taylab.fleetrunner.workload.BatchEngine
import com.taylab.fleetrunner.workload.BenchmarkEngine
import com.taylab.fleetrunner.workload.PipelineEngine
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
     * What this runner declares at registration, so the collector's capability
     * routing only offers it work it can run. Defined here, immediately beside
     * the dispatch `when` in [agentLoop] that it mirrors, so the declared list
     * and the dispatched workloads cannot drift apart.
     */
    private val capabilities = listOf("benchmark", "batch", "batch:litert", "pipeline")

    private suspend fun agentLoop(client: CollectorClient, deviceId: String) {
        while (true) {
            try {
                _status.value = "registering as $deviceId"
                client.register(
                    RegisterPost(
                        deviceId = deviceId,
                        descriptor = Telemetry.descriptor(this),
                        pools = listOf("ml-capable"),
                        capabilities = capabilities,
                    ),
                )
                while (true) {
                    _status.value = "polling for work"
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
                    currentJobId = job.jobId
                    try {
                        when (job.workload) {
                            "benchmark" -> BenchmarkEngine(this, client, deviceId).run(job)
                            "batch" ->
                                if (job.backend == "litert") VisionEvalEngine(this, client, deviceId).run(job)
                                else BatchEngine(this, client, deviceId).run(job)
                            "pipeline" -> PipelineEngine(this, client, deviceId).run(job)
                            else -> client.postResult(
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
                }
            } catch (e: Exception) {
                _status.value = "error: ${e.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s"
                delay(ERROR_BACKOFF_MS)
            }
        }
    }

    private fun checkConstraints(job: com.taylab.fleetrunner.protocol.JobSpec): String? {
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
        super.onDestroy()
    }
}
