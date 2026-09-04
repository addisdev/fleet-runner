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

export interface Backend {
  readonly name: string;
  /** Prepares the backend and returns load time in ms. */
  load(job: JobSpec): Promise<number>;
  runIteration(job: JobSpec): Promise<IterResult>;
  unload(): void;
}
