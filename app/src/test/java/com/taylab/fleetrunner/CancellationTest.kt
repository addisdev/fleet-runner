package com.taylab.fleetrunner

import com.taylab.fleetrunner.net.CollectorClient
import com.taylab.fleetrunner.protocol.DeviceDescriptor
import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.RegisterPost
import kotlinx.serialization.encodeToString
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CancellationTest {

    @After
    fun tearDown() {
        JobCancellation.clear("job-a")
        JobCancellation.clear("job-b")
    }

    @Test
    fun `a job is not cancelled until it is cancelled`() {
        assertFalse(JobCancellation.isCancelled("job-a"))
        JobCancellation.cancel("job-a")
        assertTrue(JobCancellation.isCancelled("job-a"))
    }

    @Test
    fun `cancelling one job leaves the next one alone`() {
        JobCancellation.cancel("job-a")
        assertFalse("only the cancelled job stops", JobCancellation.isCancelled("job-b"))
    }

    @Test
    fun `clear lets the same job id run again`() {
        JobCancellation.cancel("job-a")
        JobCancellation.clear("job-a")
        assertFalse(JobCancellation.isCancelled("job-a"))
    }

    @Test
    fun `clearing a finished job does not unset a newer cancellation`() {
        JobCancellation.cancel("job-b")
        JobCancellation.clear("job-a")
        assertTrue(JobCancellation.isCancelled("job-b"))
    }

    // Only an explicit false may stop a run. Everything else — a collector that
    // doesn't send the field, an empty body, a proxy that returns HTML — has to
    // read as "lease still held", or a flaky network would cancel real work.
    @Test
    fun `an explicit false is the only thing that means cancelled`() {
        assertFalse(CollectorClient.leaseRenewedIn("""{"ok":true,"lease_renewed":false}"""))
        assertTrue(CollectorClient.leaseRenewedIn("""{"ok":true,"lease_renewed":true}"""))
    }

    @Test
    fun `an absent lease_renewed field means not cancelled`() {
        assertTrue(CollectorClient.leaseRenewedIn("""{"ok":true}"""))
        assertTrue(CollectorClient.leaseRenewedIn("{}"))
    }

    @Test
    fun `an empty or unreadable body means not cancelled`() {
        assertTrue(CollectorClient.leaseRenewedIn(null))
        assertTrue(CollectorClient.leaseRenewedIn(""))
        assertTrue(CollectorClient.leaseRenewedIn("   "))
        assertTrue(CollectorClient.leaseRenewedIn("<html>502 Bad Gateway</html>"))
        assertTrue(CollectorClient.leaseRenewedIn("[1,2,3]"))
        assertTrue(CollectorClient.leaseRenewedIn("""{"lease_renewed":null}"""))
        assertTrue(CollectorClient.leaseRenewedIn("""{"lease_renewed":{"nested":false}}"""))
    }

    @Test
    fun `registration declares the workloads this runner dispatches`() {
        val post = RegisterPost(
            deviceId = "d1",
            descriptor = DeviceDescriptor("Pixel", "tensor", 8192, "Android 15", "0.2.0"),
            pools = listOf("ml-capable"),
            capabilities = listOf("benchmark", "batch", "batch:litert", "pipeline"),
        )
        val json = FleetJson.encodeToString(post)
        assertTrue(json.contains("\"capabilities\":[\"benchmark\",\"batch\",\"batch:litert\",\"pipeline\"]"))
    }
}
