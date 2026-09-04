/**
 * The synthetic backend, ported from the two phone runners iteration for
 * iteration.
 *
 * Each "token" is ROUNDS_PER_TOKEN SHA-256 hashes of a 4 KiB block with the
 * digest folded back into the front of the block, so every round does fixed
 * work that cannot be elided and tok/s measures real sustained CPU throughput.
 * The whole reason this exists is that the number is comparable across the
 * fleet: a 2016 laptop, a Dimensity phone and an iPhone are doing the same
 * arithmetic. Changing the constants, the block initialisation or the fold
 * silently invalidates every historical row on every platform, so
 * `test/synthetic.test.ts` pins the block state after a fixed number of rounds
 * against an independently computed digest chain.
 *
 * Sources this was matched against, which agree with each other:
 *   runner-android/app/src/main/java/com/taylab/fleetrunner/backend/SyntheticBackend.kt
 *   runner-ios/FleetRunner/SyntheticBackend.swift
 *
 * The backend name in results is "synthetic": hardware-comparison numbers,
 * never LLM numbers.
 */
import { createHash } from "node:crypto";
import type { Backend, IterResult } from "./types.js";
import type { JobSpec } from "../protocol.js";
import { intParam } from "../protocol.js";

/** Hash rounds per simulated token, over a 4 KiB block. */
export const ROUNDS_PER_TOKEN = 1000;
export const BLOCK_SIZE = 4096;

/** block[i] = (i * 31) & 0xff — Kotlin's `(it * 31).toByte()`, Swift's `UInt8(truncatingIfNeeded:)`. */
export function initBlock(): Buffer {
  const b = Buffer.allocUnsafe(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) b[i] = (i * 31) & 0xff;
  return b;
}

/**
 * The measured loop, in one place so a test can drive it without a clock.
 * `rounds <= 0` does nothing, which is what Kotlin's `repeat` and Swift's
 * `0..<max(n, 0)` both do at the `genTokens - 1 == -1` edge.
 */
export function foldBlock(block: Buffer, rounds: number): void {
  for (let i = 0; i < rounds; i++) {
    const out = createHash("sha256").update(block).digest();
    out.copy(block, 0, 0, out.length);
  }
}

/**
 * The tok/s arithmetic, byte for byte the phones': the millisecond divisor is
 * clamped to 1 so an iteration that finished inside a millisecond reports a
 * large number rather than Infinity.
 */
export function iterResult(
  promptTokens: number,
  genTokens: number,
  prefillMs: number,
  firstTokenMs: number,
  decodeMs: number,
): IterResult {
  return {
    prefillTokS: (promptTokens * 1000) / Math.max(prefillMs, 1),
    decodeTokS: (genTokens * 1000) / Math.max(decodeMs, 1),
    ttftMs: prefillMs + firstTokenMs,
  };
}

const msSince = (t0: bigint): number => Number((process.hrtime.bigint() - t0) / 1_000_000n);

export class SyntheticBackend implements Backend {
  readonly name = "synthetic";
  private block: Buffer | null = null;

  async load(): Promise<number> {
    const t0 = process.hrtime.bigint();
    const block = initBlock();
    this.block = block;
    // Warm the digest the way a real backend warms its context.
    createHash("sha256").update(block).digest();
    return msSince(t0);
  }

  private hashTokens(tokens: number): number {
    const block = this.block;
    if (!block) throw new Error("load() not called");
    const t0 = process.hrtime.bigint();
    foldBlock(block, tokens * ROUNDS_PER_TOKEN);
    return msSince(t0);
  }

  async runIteration(job: JobSpec): Promise<IterResult> {
    const promptTokens = intParam(job.params, "prompt_tokens", 512);
    const genTokens = intParam(job.params, "gen_tokens", 128);

    const prefillMs = this.hashTokens(promptTokens);
    const firstTokenMs = this.hashTokens(1);
    const decodeMs = firstTokenMs + this.hashTokens(Math.max(genTokens - 1, 0));

    return iterResult(promptTokens, genTokens, prefillMs, firstTokenMs, decodeMs);
  }

  unload(): void {
    this.block = null;
  }
}
