package com.taylab.fleetrunner

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.taylab.fleetrunner.telemetry.Telemetry
import com.taylab.fleetrunner.ui.PulseTraceView
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// Loopback by default, so a fresh clone works over `adb reverse` and an
// emulator with no setup at all. A device that has walked away from the cable
// is pointed at the collector's real address through the URL field, or by
// enroll.sh with FLEET_URL set -- not by a constant compiled into the APK.
private const val FLEET_HOST_URL = "http://127.0.0.1:8788"

class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("fleet", MODE_PRIVATE) }

    private lateinit var pulse: PulseTraceView
    private lateinit var headline: TextView
    private lateinit var subtitle: TextView
    private lateinit var beaconAge: TextView
    private lateinit var liveDot: View
    private lateinit var liveLabel: TextView
    private lateinit var batteryValue: TextView
    private lateinit var batteryMeter: View
    private lateinit var thermalValue: TextView
    private lateinit var thermalSteps: List<View>
    private lateinit var networkValue: TextView
    private lateinit var jobCard: View
    private lateinit var jobLabel: TextView
    private lateinit var jobPill: TextView
    private lateinit var jobWorkload: TextView
    private lateinit var jobId: TextView
    private lateinit var jobElapsed: TextView
    private lateinit var urlField: EditText
    private lateinit var idField: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        if (Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        // One-tap doze exemption so the agent survives screen-off on battery.
        // Test images (ATD) ship without the Settings activity — never fatal.
        val pm = getSystemService(android.os.PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            runCatching {
                startActivity(
                    android.content.Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:$packageName"),
                    ),
                )
            }
        }

        bindViews()

        // `--es base_url http://host:port` lets enrollment point a device at a
        // collector without rebuilding the app — the whole shelf can be moved
        // to a new host with one loop.
        intent.getStringExtra("base_url")?.let { prefs.edit().putString("base_url", it).apply() }
        urlField.setText(prefs.getString("base_url", FLEET_HOST_URL))
        idField.setText(prefs.getString("device_id", defaultDeviceId()))

        findViewById<Button>(R.id.start).setOnClickListener {
            val url = urlField.text.toString().trim()
            val id = idField.text.toString().trim()
            prefs.edit().putString("base_url", url).putString("device_id", id).apply()
            RunnerService.start(this, url, id)
        }
        findViewById<Button>(R.id.stop).setOnClickListener { RunnerService.stop(this) }

        observeAgent()

        // Headless start for adb / the host executor:
        //   am start -n com.taylab.fleetrunner/.MainActivity --ez autostart true
        if (intent.getBooleanExtra("autostart", false)) {
            RunnerService.start(this, urlField.text.toString().trim(), idField.text.toString().trim())
        }
    }

    private fun bindViews() {
        pulse = findViewById(R.id.pulse)
        headline = findViewById(R.id.headline)
        subtitle = findViewById(R.id.subtitle)
        beaconAge = findViewById(R.id.beacon_age)
        liveDot = findViewById(R.id.live_dot)
        liveLabel = findViewById(R.id.live_label)
        batteryValue = findViewById(R.id.battery_value)
        batteryMeter = findViewById(R.id.battery_meter)
        thermalValue = findViewById(R.id.thermal_value)
        thermalSteps = listOf(
            findViewById(R.id.thermal_step_1),
            findViewById(R.id.thermal_step_2),
            findViewById(R.id.thermal_step_3),
            findViewById(R.id.thermal_step_4),
        )
        networkValue = findViewById(R.id.network_value)
        jobCard = findViewById(R.id.job_card)
        jobLabel = findViewById(R.id.job_label)
        jobPill = findViewById(R.id.job_pill)
        jobWorkload = findViewById(R.id.job_workload)
        jobId = findViewById(R.id.job_id)
        jobElapsed = findViewById(R.id.job_elapsed)
        urlField = findViewById(R.id.collector_url)
        idField = findViewById(R.id.device_id)
    }

    /**
     * Everything the screen shows, wired to the service's state.
     *
     * Collected on `lifecycleScope`, not through `repeatOnLifecycle`: that
     * operator lives in lifecycle-runtime-ktx, and this module deliberately
     * carries appcompat and nothing else. The thing it would have bought — not
     * redrawing while the screen is off — is what the ticker's own lifecycle
     * check below does, and it is only the ticker that would otherwise run on
     * a dark screen. The state flows push nothing while the agent is idle.
     */
    private fun observeAgent() {
        lifecycleScope.launch { RunnerService.status.collectLatest { findViewById<TextView>(R.id.status).text = it } }
        lifecycleScope.launch { RunnerService.phase.collectLatest { renderPhase(it) } }
        lifecycleScope.launch { RunnerService.beacon.collectLatest { renderTelemetry() } }
        lifecycleScope.launch { RunnerService.network.collectLatest { renderTelemetry() } }
        lifecycleScope.launch { RunnerService.job.collectLatest { renderJob() } }
        // The two ages on this screen — since the last beacon, and since the job
        // was claimed — are wall-clock, so nothing pushes them. One second is
        // fast enough to look live; a fleet phone spends its life with the
        // screen off, so it does nothing at all while the Activity is stopped.
        lifecycleScope.launch {
            while (isActive) {
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) renderAges()
                delay(1_000)
            }
        }
        // A reading before the agent has ever been started: deciding whether to
        // enrol a phone that is on 8% is exactly a pre-start question, and until
        // Start is pressed there is no beacon to show.
        renderTelemetry()
    }

    private fun renderPhase(phase: RunnerService.Companion.Phase) {
        headline.text = phase.headline
        pulse.active = phase.connected

        subtitle.text = when (phase) {
            RunnerService.Companion.Phase.STOPPED -> getString(R.string.not_registered)
            // The actual error, not a euphemism: "cannot reach the collector"
            // without the reason is the half of the message that does not help.
            RunnerService.Companion.Phase.FAILING -> RunnerService.status.value
            else -> "Registered as ${idField.text} in pool ml-capable"
        }

        val (label, color) = when (phase) {
            RunnerService.Companion.Phase.POLLING, RunnerService.Companion.Phase.RUNNING ->
                "live" to R.color.fleet_ok
            RunnerService.Companion.Phase.STOPPED -> "stopped" to R.color.fleet_ink_faint
            RunnerService.Companion.Phase.FAILING -> "offline" to R.color.fleet_bad
            else -> "connecting" to R.color.fleet_warn
        }
        liveLabel.text = label
        liveDot.background.setTint(ContextCompat.getColor(this, color))

        // Only "connecting" pulses. A dot that pulses forever stops being read.
        val connecting = phase == RunnerService.Companion.Phase.STARTING ||
            phase == RunnerService.Companion.Phase.REGISTERING
        liveDot.clearAnimation()
        if (connecting && animationsEnabled()) {
            liveDot.animate().alpha(0.25f).setDuration(600).withEndAction {
                liveDot.animate().alpha(1f).setDuration(600).withEndAction {
                    if (RunnerService.phase.value.let {
                            it == RunnerService.Companion.Phase.STARTING ||
                                it == RunnerService.Companion.Phase.REGISTERING
                        }
                    ) renderPhase(RunnerService.phase.value)
                }.start()
            }.start()
        } else {
            liveDot.animate().cancel()
            liveDot.alpha = 1f
        }
    }

    /** Zero means "do not animate" — the platform's own reduce-motion signal. */
    private fun animationsEnabled(): Boolean =
        Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

    private fun renderTelemetry() {
        // The beacon when there is one, a local reading before the first goes
        // out. Once the agent is running these are the numbers the collector
        // was actually sent, not readings taken a second later.
        val beacon = RunnerService.beacon.value
        val battery = beacon?.batteryPct ?: runCatching { Telemetry.batteryPct(this) }.getOrNull()
        val charging = beacon?.charging ?: runCatching { Telemetry.isCharging(this) }.getOrDefault(false)
        val thermal = beacon?.thermal ?: runCatching { Telemetry.thermal(this) }.getOrNull()
        val net = RunnerService.network.value.takeIf { it != "unknown" }
            ?: runCatching { Telemetry.networkType(this) }.getOrDefault("unknown")

        // An emulator reports a level of -1 rather than a reading; "-1%" would
        // look like a measurement rather than the absence of one.
        batteryValue.text = when {
            battery == null || battery < 0 -> "n/a"
            else -> "$battery%"
        }
        val batteryColor = when {
            battery == null || battery < 0 -> R.color.fleet_ink_faint
            charging -> R.color.fleet_ok
            battery < 15 -> R.color.fleet_bad
            battery < 30 -> R.color.fleet_warn
            else -> R.color.fleet_ok
        }
        batteryValue.setTextColor(ContextCompat.getColor(this, batteryColor))
        batteryMeter.background.setTint(ContextCompat.getColor(this, batteryColor))
        batteryMeter.post {
            val track = (batteryMeter.parent as View).width
            val pct = (battery ?: 0).coerceIn(0, 100)
            batteryMeter.layoutParams = batteryMeter.layoutParams.apply {
                width = if (battery == null || battery < 0) 0 else (track * pct / 100).coerceAtLeast(4)
            }
            batteryMeter.requestLayout()
        }

        thermalValue.text = thermal ?: getString(R.string.dash)
        thermalValue.setTextColor(ContextCompat.getColor(this, thermalColor(thermal)))
        val lit = when (thermal) {
            "nominal" -> 1; "fair" -> 2; "serious" -> 3; "critical" -> 4; else -> 0
        }
        val stepColors = listOf(R.color.fleet_ok, R.color.fleet_fair, R.color.fleet_warn, R.color.fleet_bad)
        thermalSteps.forEachIndexed { i, step ->
            val c = if (i < lit) stepColors[i] else R.color.fleet_panel_2
            step.background.setTint(ContextCompat.getColor(this, c))
        }

        networkValue.text = net
    }

    private fun thermalColor(state: String?): Int = when (state) {
        "nominal" -> R.color.fleet_ok
        "fair" -> R.color.fleet_fair
        "serious" -> R.color.fleet_warn
        "critical" -> R.color.fleet_bad
        else -> R.color.fleet_ink_faint
    }

    private fun renderJob() {
        val job = RunnerService.job.value
        if (job == null) {
            jobCard.visibility = View.GONE
            return
        }
        jobCard.visibility = View.VISIBLE
        val running = job.finishedAt == null
        jobLabel.setText(if (running) R.string.label_running else R.string.label_last_job)
        // No ok/failed verdict: the engines post their own final rows and this
        // process never sees the outcome, so a green badge here would be a
        // guess. The dashboard is where a job's verdict lives.
        jobPill.text = if (running) "claimed" else "finished"
        jobPill.setTextColor(
            ContextCompat.getColor(this, if (running) R.color.fleet_warn else R.color.fleet_ink_dim),
        )
        jobWorkload.text = job.workload
        jobId.text = job.jobId
        renderAges()
    }

    private fun renderAges() {
        val beaconAt = RunnerService.lastBeaconAt.value
        if (beaconAt == null) {
            beaconAge.visibility = View.GONE
        } else {
            beaconAge.visibility = View.VISIBLE
            beaconAge.text = "${duration((System.currentTimeMillis() - beaconAt) / 1000)} ago"
        }

        val job = RunnerService.job.value ?: return
        jobElapsed.text = if (job.finishedAt == null) {
            "started ${duration((System.currentTimeMillis() - job.startedAt) / 1000)} ago"
        } else {
            "took ${duration((job.finishedAt - job.startedAt) / 1000)}"
        }
    }

    /** Compact, like the dashboard's: read at a glance, not to the second. */
    private fun duration(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> "${s / 60}m ${s % 60}s"
            else -> "${s / 3600}h ${(s % 3600) / 60}m"
        }
    }

    private fun defaultDeviceId(): String {
        val model = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]+"), "-")
        val suffix = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeLast(4) ?: "0000"
        return "$model-$suffix"
    }
}
