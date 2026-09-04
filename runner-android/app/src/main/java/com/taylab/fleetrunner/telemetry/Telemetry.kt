package com.taylab.fleetrunner.telemetry

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import com.taylab.fleetrunner.BuildConfig
import com.taylab.fleetrunner.protocol.BeaconSample
import com.taylab.fleetrunner.protocol.DeviceDescriptor

object Telemetry {

    fun descriptor(context: Context): DeviceDescriptor {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val soc = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else Build.HARDWARE
        return DeviceDescriptor(
            model = Build.MODEL,
            soc = soc,
            ramMb = mem.totalMem / (1024 * 1024),
            os = "android-${Build.VERSION.RELEASE}",
            appVer = BuildConfig.VERSION_NAME,
        )
    }

    fun batteryPct(context: Context): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    fun isCharging(context: Context): Boolean {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.isCharging
    }

    /** Shared thermal enum: nominal / fair / serious / critical. Pre-API-29 has no signal → nominal. */
    fun thermal(context: Context): String {
        if (Build.VERSION.SDK_INT < 29) return "nominal"
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return when (pm.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
            PowerManager.THERMAL_STATUS_MODERATE -> "fair"
            PowerManager.THERMAL_STATUS_SEVERE -> "serious"
            else -> "critical"
        }
    }

    /**
     * What is carrying this device's traffic right now: wifi / cellular /
     * ethernet / unknown, the same four words the iOS runner reports.
     *
     * Recorded on every vantage row rather than derived later, because the
     * whole point of measuring from where the device happens to be is that a
     * phone on cellular and a desktop on fibre give different answers — and a
     * timing with no idea what carried it is not comparable to anything. The
     * reading is taken per request: a device can leave wifi mid-job, and the
     * rows on either side of that are honestly different measurements.
     *
     * "unknown" covers the cases where the OS will not say — no active
     * network, a VPN or a transport we do not name — and is deliberately a
     * word rather than a guess.
     */
    fun networkType(context: Context): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? android.net.ConnectivityManager ?: return "unknown"
        val caps = try {
            cm.getNetworkCapabilities(cm.activeNetwork) ?: return "unknown"
        } catch (_: SecurityException) {
            // ACCESS_NETWORK_STATE denied: say so rather than invent a link.
            return "unknown"
        }
        return when {
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "unknown"
        }
    }

    /** PSS in MB — labeled "pss" in results, never compared to iOS phys_footprint. */
    fun pssMb(): Long {
        val info = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
        return info.totalPss / 1024L
    }

    fun beacon(context: Context): BeaconSample = BeaconSample(
        batteryPct = batteryPct(context),
        charging = isCharging(context),
        thermal = thermal(context),
    )
}
