import type { JobSpec } from "../protocol.js";

/**
 * One measured iteration. Every field is optional because a backend reports
 * only what it actually measured: llama-bench has no time-to-first-token to
 * give, and an absent `ttft_ms` is the honest way to say so.
 */
export type IterResult = {
  prefillTokS?: number;
  decodeTokS?: number;
  ttftMs?: number;
  /** Set by a backend that measured memory for a process of its own. */
  peakMemMb?: number;
  memMethod?: string;
  /**
   * Model-load time measured by this iteration, for a backend where loading
   * happens inside the run rather than in `load()` — llama-bench reloads the
   * model on every invocation, so its load time is a property of the iteration
   * and not of the backend's setup.
   */
  loadMs?: number;
};

/**
 * Proof that a backend is doing the arithmetic it claims to be doing.
 *
 * Only the synthetic backend can answer this, and only the synthetic backend
 * needs to: it is the one whose entire purpose is being IDENTICAL on every
 * platform, and the one whose numbers are compared across hardware that shares
 * no code. A digest over a fixed number of rounds on a fresh block is
 * deterministic everywhere, so a runner that disagrees with the specification
 * says so in a result row rather than in a subtly wrong tok/s.
 *
 * llama.cpp and the rest return null: their output depends on a model file and
 * a hardware backend, and there is no fixed answer to attest to.
 */
export type Attestation = { digest: string; rounds: number };

export interface Backend {
  readonly name: string;
  /** Prepares the backend and returns load time in ms. */
  load(job: JobSpec): Promise<number>;
  runIteration(job: JobSpec): Promise<IterResult>;
  unload(): void;
  /**
   * A fixed-work digest this backend can be checked against, or null when the
   * question does not apply. Must not disturb measured state: it runs on its
   * own block, so calling it mid-benchmark changes no number.
   */
  attest?(): Attestation | null;
}
