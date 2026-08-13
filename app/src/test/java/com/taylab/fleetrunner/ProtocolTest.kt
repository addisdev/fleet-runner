package com.taylab.fleetrunner

import com.taylab.fleetrunner.protocol.FleetJson
import com.taylab.fleetrunner.protocol.JobSpec
import com.taylab.fleetrunner.protocol.Metrics
import com.taylab.fleetrunner.protocol.ResultPost
import com.taylab.fleetrunner.protocol.intParam
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {

    // Exactly what the collector hands out (extra fields must be tolerated).
    private val collectorJob = """
        {
          "schema": 1,
          "job_id": "bench-qwen3-0.6b-q4",
          "workload": "benchmark",
          "executor": "device",
          "model": { "name": "qwen3-0.6b", "format": "gguf", "quant": "Q4_K_M",
                     "sha256": "${"a".repeat(64)}" },
          "backend": "llama.cpp",
          "params": { "prompt_tokens": 512, "gen_tokens": 128,
                      "warmup_iters": 2, "measure_iters": 5 },
          "targets": { "pool": "ml-capable" },
          "constraints": { "require_charging": true },
          "some_future_field": { "ignored": true }
        }
    """.trimIndent()

    @Test
    fun `job spec decodes with unknown fields ignored`() {
        val job = FleetJson.decodeFromString<JobSpec>(collectorJob)
        assertEquals("bench-qwen3-0.6b-q4", job.jobId)
        assertEquals("device", job.executor)
        assertEquals("qwen3-0.6b", job.model?.name)
        assertEquals(512, job.params.intParam("prompt_tokens", -1))
        assertEquals(5, job.params.intParam("measure_iters", -1))
        assertEquals(7, job.params.intParam("missing_key", 7))
        assertEquals("ml-capable", job.targets?.pool)
    }

    @Test
    fun `result rows serialize with snake_case keys and no nulls`() {
        val row = ResultPost(
            kind = "result", jobId = "j1", deviceId = "d1", iter = 0,
            final = true, ok = true,
            metrics = Metrics(decodeTokS = 9.8, memMethod = "pss"),
        )
        val json = FleetJson.encodeToString(row)
        assertTrue(json.contains("\"job_id\":\"j1\""))
        assertTrue(json.contains("\"device_id\":\"d1\""))
        assertTrue(json.contains("\"decode_tok_s\":9.8"))
        assertTrue(json.contains("\"mem_method\":\"pss\""))
        assertTrue(json.contains("\"schema\":1"))
        assertFalse("nulls must be omitted, not sent", json.contains("null"))
    }

    @Test
    fun `beacon rows omit job fields entirely`() {
        val row = ResultPost(
            kind = "beacon", deviceId = "d1",
            beacon = com.taylab.fleetrunner.protocol.BeaconSample(74, true, "nominal"),
        )
        val json = FleetJson.encodeToString(row)
        assertFalse(json.contains("job_id"))
        assertTrue(json.contains("\"battery_pct\":74"))
    }
}
