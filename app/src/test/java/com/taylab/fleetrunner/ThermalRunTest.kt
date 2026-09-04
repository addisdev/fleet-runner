package com.taylab.fleetrunner

import com.taylab.fleetrunner.workload.ThermalRun
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The thermal loop's arithmetic, driven by a fake clock. A fifteen-minute run
 * on a warm phone is the worst possible place to discover that the duration is
 * off by an iteration or that the lease went un-renewed, so the parts that can
 * be checked without a device are checked here instead.
 */
class ThermalRunTest {

    private val t0 = 1_700_000_000_000L

    private fun run(durationS: Int, intervalS: Int = 0, beaconEveryMs: Long = 60_000L) =
        ThermalRun(
            startedAtMs = t0,
            durationMs = durationS * 1000L,
            intervalMs = intervalS * 1000L,
            beaconEveryMs = beaconEveryMs,
        )

    // --- duration ---------------------------------------------------------

    @Test
    fun `the loop keeps going until the duration elapses`() {
        val r = run(durationS = 900)
        assertTrue(r.hasTimeLeft(t0))
        assertTrue(r.hasTimeLeft(t0 + 899_999))
        assertFalse("at the duration the run is over", r.hasTimeLeft(t0 + 900_000))
        assertFalse(r.hasTimeLeft(t0 + 900_001))
    }

    @Test
    fun `an iteration that starts inside the window is allowed to finish`() {
        // The check is before the iteration, not after: a run asked for 900 s
        // overshoots by at most one iteration rather than stopping short of the
        // duration it was told to cover.
        val r = run(durationS = 900)
        assertTrue("starts at 899s", r.hasTimeLeft(t0 + 899_000))
        r.startedIteration(t0 + 899_000)
        r.record(elapsedS = 906.0, decode = 40.0, thermal = "fair")
        assertEquals(1, r.iterations)
        assertFalse(r.hasTimeLeft(t0 + 906_000))
    }

    @Test
    fun `a zero duration runs no iterations at all`() {
        assertFalse(run(durationS = 0).hasTimeLeft(t0))
    }

    @Test
    fun `elapsed is measured from the start of the measured loop`() {
        val r = run(durationS = 900)
        assertEquals(0.0, r.elapsedS(t0), 1e-9)
        assertEquals(7.5, r.elapsedS(t0 + 7_500), 1e-9)
    }

    // --- interval ---------------------------------------------------------

    @Test
    fun `the default interval runs iterations back to back`() {
        val r = run(durationS = 900, intervalS = 0)
        r.startedIteration(t0)
        assertEquals(0L, r.waitBeforeNextMs(t0 + 6_000))
    }

    @Test
    fun `interval_s paces iteration starts, not the gaps between them`() {
        // A 30 s interval after an iteration that itself took 6 s should wait
        // 24 s, not 30: the cadence is fixed, so it cannot drift as iterations
        // slow down -- which is the one thing this workload expects them to do.
        val r = run(durationS = 900, intervalS = 30)
        r.startedIteration(t0)
        assertEquals(24_000L, r.waitBeforeNextMs(t0 + 6_000))
    }

    @Test
    fun `an iteration slower than the interval never waits`() {
        val r = run(durationS = 900, intervalS = 30)
        r.startedIteration(t0)
        assertEquals("already late, so start now", 0L, r.waitBeforeNextMs(t0 + 45_000))
    }

    // --- beacons ----------------------------------------------------------

    @Test
    fun `the lease is beaconed at least once a minute`() {
        val r = run(durationS = 900)
        assertFalse(r.dueToBeacon(t0 + 59_999))
        assertTrue(r.dueToBeacon(t0 + 60_000))
        r.beaconed(t0 + 60_000)
        assertFalse(r.dueToBeacon(t0 + 119_999))
        assertTrue(r.dueToBeacon(t0 + 120_000))
    }

    @Test
    fun `beacons are due on elapsed time, not on iteration count`() {
        // Four fast iterations inside one minute owe the collector one beacon,
        // and a single slow iteration spanning two minutes also owes one: the
        // schedule cannot be tied to how many iterations happened to fit.
        val r = run(durationS = 900)
        for (t in listOf(5_000L, 10_000L, 15_000L, 20_000L)) assertFalse(r.dueToBeacon(t0 + t))
        assertTrue(r.dueToBeacon(t0 + 130_000))
    }

    // --- the curve's summary ----------------------------------------------

    @Test
    fun `the summary holds the cold and the sustained throughput`() {
        val r = run(durationS = 900)
        r.record(0.0, 142.0, "nominal")
        r.record(60.0, 128.0, "nominal")
        r.record(300.0, 96.0, "fair")
        assertEquals(3, r.iterations)
        assertEquals(142.0, r.firstDecodeTokS!!, 1e-9)
        assertEquals(96.0, r.lastDecodeTokS!!, 1e-9)
    }

    @Test
    fun `the thermal turn is the elapsed time of the first state change`() {
        val r = run(durationS = 900)
        r.record(0.0, 142.0, "nominal")
        assertNull("one sample cannot be a change", r.thermalTurnAtS)
        r.record(60.0, 128.0, "nominal")
        assertNull(r.thermalTurnAtS)
        r.record(300.0, 96.0, "fair")
        assertEquals(300.0, r.thermalTurnAtS!!, 1e-9)
        // It is the FIRST turn, so a later one does not move it.
        r.record(600.0, 71.0, "serious")
        assertEquals(300.0, r.thermalTurnAtS!!, 1e-9)
    }

    @Test
    fun `a run that never leaves its starting state reports no turn`() {
        val r = run(durationS = 900)
        r.record(0.0, 142.0, "nominal")
        r.record(300.0, 140.0, "nominal")
        r.record(600.0, 139.0, "nominal")
        assertNull(r.thermalTurnAtS)
    }

    @Test
    fun `a device already warm when the run starts turns on its own baseline`() {
        // The turn is relative to the state the run began in, not to "nominal":
        // a phone that was already fair at iteration 1 has not thermally
        // changed until it leaves fair.
        val r = run(durationS = 900)
        r.record(0.0, 100.0, "fair")
        r.record(60.0, 98.0, "fair")
        assertNull(r.thermalTurnAtS)
        r.record(120.0, 80.0, "serious")
        assertEquals(120.0, r.thermalTurnAtS!!, 1e-9)
    }

    @Test
    fun `the states are kept in order, one per iteration`() {
        val r = run(durationS = 900)
        r.record(0.0, 142.0, "nominal")
        r.record(300.0, 96.0, "fair")
        r.record(600.0, 71.0, "serious")
        assertEquals(listOf("nominal", "fair", "serious"), r.thermalStates)
    }

    @Test
    fun `a run with no completed iterations summarises to nothing rather than to zero`() {
        val r = run(durationS = 900)
        assertEquals(0, r.iterations)
        assertNull(r.firstDecodeTokS)
        assertNull(r.lastDecodeTokS)
        assertNull(r.thermalTurnAtS)
        assertTrue(r.thermalStates.isEmpty())
    }
}
