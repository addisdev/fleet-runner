/**
 * The runner protocol, where it meets the control API.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../src/connect.js";
import { fakeDevice, startCollector, type Collector } from "./helpers.js";

let c: Collector;
before(async () => (c = await startCollector()));
after(async () => c?.stop());

test("a device that hangs up mid-poll does not swallow the next job", async () => {
  const first = await fakeDevice(c.base, "flaky-wifi");
  await new Promise((r) => setTimeout(r, 300));
  await first.stop();

  const client = connect({ url: c.base, source: "test" });
  const job = await client.createJob({ workload: "benchmark", executor: "device", targets: { device_id: "flaky-wifi" } });
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal((await client.getJobSummary(job.job_id)).verdict, "queued", "nobody is polling, so nobody may claim it");

  const second = await fakeDevice(c.base, "flaky-wifi");
  try {
    const s = await client.waitJob(job.job_id, { timeout_s: 20 });
    assert.equal(s.verdict, "passed");
    assert.deepEqual(second.claimed, [job.job_id]);
  } finally {
    await second.stop();
  }
});
