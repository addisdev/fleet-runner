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

        val t0 = System.nanoTime()
        backend.runIteration(job(promptTokens = 8, genTokens = 8))
        val small = System.nanoTime() - t0

        val t1 = System.nanoTime()
        backend.runIteration(job(promptTokens = 64, genTokens = 64))
        val large = System.nanoTime() - t1
        backend.unload()

        assertTrue("8x tokens should take measurably longer (small=$small large=$large)", large > small * 2)
    }
}
