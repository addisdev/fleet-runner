package com.taylab.fleetrunner.telemetry

import android.app.ActivityManager
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
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
            kind = formFactor(context),
        )
    }

    /**
     * What shape of thing this APK is running on.
     *
     * The same binary installs on a phone, a tablet, a TV stick, a watch and a
     * headset, and nothing in `Build` distinguishes them: a Fire TV reports a
     * model and an SoC exactly the way a handset does, so a fleet that reads
     * only `Build` puts a television in a table of phones.
     *
     * `UiModeManager` is the system's own answer and is asked first. It is
     * authoritative for the four cases it names, and it is the field the
     * launcher itself routes on.
     *
     * A headset is asked about separately, and before the TV check, because
     * Quest reports UI_MODE_TYPE_NORMAL — it presents as an ordinary Android
     * phone environment — and only the VR feature flag tells the truth. The
     * feature constant is compared by string rather than by symbol so this
     * still compiles against an SDK that predates it.
     *
     * Phone versus tablet is the one case with no system answer at all, so it
     * falls back to the 600dp rule the resource system itself uses for
     * `sw600dp`. That keeps this agreeing with which layout the OS chose.
     */
    fun formFactor(context: Context): String {
        val pm = context.packageManager
        if (pm.hasSystemFeature(PackageManager.FEATURE_WATCH)) return "watch"
        // FEATURE_VR_HEADSET landed in API 26; the literal is what that constant
        // holds, and comparing the string keeps minSdk 24 compiling.
        if (pm.hasSystemFeature("android.hardware.vr.headset")) return "headset"

        val ui = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        when (ui?.currentModeType) {
            Configuration.UI_MODE_TYPE_TELEVISION -> return "tv"
            Configuration.UI_MODE_TYPE_WATCH -> return "watch"
            Configuration.UI_MODE_TYPE_CAR -> return "automotive"
            Configuration.UI_MODE_TYPE_APPLIANCE -> return "appliance"
        }
        // A TV that does not set the UI mode still declares the leanback
        // feature, which is what its launcher requires to show the app at all.
        if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return "tv"

        // No system call answers phone-versus-tablet, so use the rule the
        // resource system uses: sw600dp is where Android itself switches.
        return if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
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
