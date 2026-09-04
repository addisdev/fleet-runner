package com.taylab.fleetrunner

import com.taylab.fleetrunner.backend.SyntheticBackend
import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import org.junit.Assert.assertTrue
import org.junit.Test

class SyntheticBackendTest {

    private fun job(promptTokens: Int, genTokens: Int): JobSpec =
        FleetJson.decodeFromString(
            """
            { "schema": 1, "job_id": "t", "workload": "benchmark", "executor": "device",
              "backend": "synthetic",
              "params": { "prompt_tokens": $promptTokens, "gen_tokens": $genTokens } }
            """,
        )

    @Test
    fun `iteration produces positive, sane metrics`() {
        val backend = SyntheticBackend()
        val spec = job(promptTokens = 32, genTokens = 8)
        val loadMs = backend.load(spec)
        assertTrue("load time is non-negative", loadMs >= 0)

        val r = backend.runIteration(spec)
        backend.unload()

        assertTrue("prefill tok/s positive", r.prefillTokS > 0)
        assertTrue("decode tok/s positive", r.decodeTokS > 0)
        assertTrue("ttft positive", r.ttftMs > 0)
    }

    @Test
    fun `work scales with token count`() {
        val backend = SyntheticBackend()
        backend.load(job(1, 1))

        // Wide contrast + loose threshold: timing assertions on a loaded CI
        // host flake if the margins are tight (observed 1.5x where 2x was
        // demanded for 8x work under heavy parallel load).
        val t0 = System.nanoTime()
        backend.runIteration(job(promptTokens = 4, genTokens = 4))
        val small = System.nanoTime() - t0

        val t1 = System.nanoTime()
        backend.runIteration(job(promptTokens = 64, genTokens = 64))
        val large = System.nanoTime() - t1
        backend.unload()

        assertTrue("16x tokens should take measurably longer (small=$small large=$large)", large > small * 2)
    }
}
