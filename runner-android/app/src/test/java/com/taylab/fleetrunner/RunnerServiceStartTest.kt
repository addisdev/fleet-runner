package com.taylab.fleetrunner

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * RunnerService.start() on both sides of API 26, where startForegroundService first exists.
 * Robolectric runs each SDK's real framework jar, so on 25 a call to the API 26 method fails
 * with NoSuchMethodError exactly as it does on a phone; minSdk is 24, so 24-25 must startService.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class RunnerServiceStartTest {

    private fun startAndTakeIntent(): android.content.Intent {
        val app = RuntimeEnvironment.getApplication()
        RunnerService.start(app, "http://collector.invalid", "device-1")
        return shadowOf(app).nextStartedService
    }

    @Test @Config(sdk = [25])
    fun `API 25, start reaches the service without the API 26 call`() {
        val intent = startAndTakeIntent()
        assertEquals(RunnerService::class.java.name, intent.component?.className)
        assertEquals("http://collector.invalid", intent.getStringExtra("base_url"))
    }

    @Test @Config(sdk = [34])
    fun `API 34, start reaches the service`() {
        val intent = startAndTakeIntent()
        assertEquals(RunnerService::class.java.name, intent.component?.className)
        assertEquals("http://collector.invalid", intent.getStringExtra("base_url"))
    }
}
