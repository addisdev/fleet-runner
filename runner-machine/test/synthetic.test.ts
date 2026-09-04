/**
 * The synthetic backend is the reason numbers compare across the fleet, so
 * these tests pin its arithmetic rather than its speed. A timing assertion
 * would be flaky on a CI runner and would not catch the failure that matters:
 * a refactor that quietly changes how much hashing a "token" is, which does not
 * break anything visibly and silently invalidates every historical row on
 * Android and iOS too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BLOCK_SIZE,
  ROUNDS_PER_TOKEN,
  SyntheticBackend,
  foldBlock,
  initBlock,
  iterResult,
} from "../src/backends/synthetic.js";

test("the constants are the ones both phone runners use", () => {
  assert.equal(ROUNDS_PER_TOKEN, 1000);
  assert.equal(BLOCK_SIZE, 4096);
});

test("the block starts as (i * 31) truncated to a byte", () => {
  const b = initBlock();
  assert.equal(b.length, BLOCK_SIZE);
  assert.equal(b[0], 0);
  assert.equal(b[1], 31);
  assert.equal(b[10], (10 * 31) & 0xff); // 310 & 0xff === 54
  assert.equal(b[4095], (4095 * 31) & 0xff);
});

test("one token is exactly ROUNDS_PER_TOKEN folded SHA-256 rounds", () => {
  // Recomputed here from first principles rather than from the module's own
  // loop, so a change to foldBlock has to be argued with rather than absorbed.
  const expected = initBlock();
  for (let i = 0; i < ROUNDS_PER_TOKEN; i++) {
    const digest = createHash("sha256").update(expected).digest();
    digest.copy(expected, 0, 0, digest.length);
  }

  const actual = initBlock();
  foldBlock(actual, ROUNDS_PER_TOKEN);
  assert.deepEqual(actual, expected);
});

test("one token of work has a fixed, documented digest", () => {
  // The golden value. If this changes, tok/s on this platform stopped being
  // comparable to the phones' and every stored row of every platform is now a
  // different measurement.
  const block = initBlock();
  foldBlock(block, ROUNDS_PER_TOKEN);
  assert.equal(
    block.subarray(0, 32).toString("hex"),
    "e9c09bf6b8ddbd8f57e3f9f2af5cadfa2e38cabb3de02d4d50179e11e4192a5a",
  );
});

test("zero and negative round counts do nothing, as repeat/0..<max do", () => {
  const untouched = initBlock();
  const a = initBlock();
  foldBlock(a, 0);
  assert.deepEqual(a, untouched);
  // genTokens = 0 reaches hashTokens(-1) on Android, where repeat() ignores it.
  const b = initBlock();
  foldBlock(b, -1000);
  assert.deepEqual(b, untouched);
});

test("tok/s arithmetic matches the phones, including the 1 ms clamp", () => {
  const r = iterResult(256, 64, 500, 10, 250);
  assert.equal(r.prefillTokS, (256 * 1000) / 500);
  assert.equal(r.decodeTokS, (64 * 1000) / 250);
  assert.equal(r.ttftMs, 510);

  // A sub-millisecond phase divides by 1, not by 0: a large number, never Infinity.
  const fast = iterResult(4, 4, 0, 0, 0);
  assert.equal(fast.prefillTokS, 4000);
  assert.equal(fast.decodeTokS, 4000);
  assert.ok(Number.isFinite(fast.prefillTokS!));
});

test("runIteration produces finite rates for a documented small input", async () => {
  const b = new SyntheticBackend();
  const loadMs = await b.load();
  assert.ok(loadMs >= 0);
  const r = await b.runIteration({
    schema: 1, job_id: "t", workload: "benchmark", executor: "device",
    params: { prompt_tokens: 2, gen_tokens: 2 },
  });
  assert.ok(Number.isFinite(r.prefillTokS!) && r.prefillTokS! > 0);
  assert.ok(Number.isFinite(r.decodeTokS!) && r.decodeTokS! > 0);
  assert.ok(Number.isFinite(r.ttftMs!) && r.ttftMs! >= 0);
  b.unload();
});

test("runIteration without load() refuses rather than hashing nothing", async () => {
  const b = new SyntheticBackend();
  await assert.rejects(
    () => b.runIteration({ schema: 1, job_id: "t", workload: "benchmark", executor: "device" }),
    /load\(\) not called/,
  );
});
