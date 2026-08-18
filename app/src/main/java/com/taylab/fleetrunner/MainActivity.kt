package com.taylab.fleetrunner

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private const val FLEET_HOST_URL = "http://192.168.50.27:8788" // fleet-host (C02TF32MGTFM); give it a DHCP reservation

class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("fleet", MODE_PRIVATE) }

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

        val urlField = findViewById<EditText>(R.id.collector_url)
        val idField = findViewById<EditText>(R.id.device_id)
        val statusView = findViewById<TextView>(R.id.status)

        urlField.setText(prefs.getString("base_url", FLEET_HOST_URL))
        idField.setText(prefs.getString("device_id", defaultDeviceId()))

        findViewById<Button>(R.id.start).setOnClickListener {
            val url = urlField.text.toString().trim()
            val id = idField.text.toString().trim()
            prefs.edit().putString("base_url", url).putString("device_id", id).apply()
            RunnerService.start(this, url, id)
        }
        findViewById<Button>(R.id.stop).setOnClickListener { RunnerService.stop(this) }

        lifecycleScope.launch {
            RunnerService.status.collectLatest { statusView.text = it }
        }

        // Headless start for adb / the host executor:
        //   am start -n com.taylab.fleetrunner/.MainActivity --ez autostart true
        if (intent.getBooleanExtra("autostart", false)) {
            RunnerService.start(this, urlField.text.toString().trim(), idField.text.toString().trim())
        }
    }

    private fun defaultDeviceId(): String {
        val model = Build.MODEL.lowercase().replace(Regex("[^a-z0-9]+"), "-")
        val suffix = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            ?.takeLast(4) ?: "0000"
        return "$model-$suffix"
    }
}
