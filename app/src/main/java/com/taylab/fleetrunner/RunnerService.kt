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
import com.taylab.fleetrunner.workload.BenchmarkEngine
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

    // The beacon stamps this onto its posts: a beacon carrying a job_id renews
    // that job's lease, so long benchmarks aren't swept mid-run.
    @Volatile
    private var currentJobId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL) ?: return START_NOT_STICKY
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return START_NOT_STICKY

        startForeground(NOTIF_ID, buildNotification(deviceId))

        scope?.cancel()
        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s
        val client = CollectorClient(baseUrl)
        s.launch { agentLoop(client, deviceId) }
        s.launch { beaconLoop(client, deviceId) }
        return START_STICKY
    }

    private suspend fun agentLoop(client: CollectorClient, deviceId: String) {
        while (true) {
            try {
                _status.value = "registering as $deviceId"
                client.register(
                    RegisterPost(
                        deviceId = deviceId,
                        descriptor = Telemetry.descriptor(this),
                        pools = listOf("ml-capable"),
                    ),
                )
                while (true) {
                    _status.value = "polling for work"
                    val job = client.nextJob(deviceId) ?: continue
                    _status.value = "running ${job.jobId}"
                    currentJobId = job.jobId
                    try {
                        when (job.workload) {
                            "benchmark" -> BenchmarkEngine(this, client, deviceId).run(job)
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
                    }
                    _status.value = "finished ${job.jobId}"
                }
            } catch (e: Exception) {
                _status.value = "error: ${e.message} — retrying in ${ERROR_BACKOFF_MS / 1000}s"
                delay(ERROR_BACKOFF_MS)
            }
        }
    }

    private suspend fun beaconLoop(client: CollectorClient, deviceId: String) {
        while (true) {
            try {
                client.postResult(
                    ResultPost(
                        kind = "beacon", deviceId = deviceId,
                        jobId = currentJobId, // renews the running job's lease
                        beacon = Telemetry.beacon(this),
                    ),
                )
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
        _status.value = "stopped"
        super.onDestroy()
    }
}
