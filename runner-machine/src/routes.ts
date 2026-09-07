/**
 * One table: what this agent declares, and what it runs.
 *
 * These were two lists. `capabilities.ts` built the string array sent at
 * registration, and `agent.ts` had an `if` chain that dispatched a claimed job
 * — and they agreed only for as long as somebody remembered to edit both.
 *
 * That is the exact drift `docs/writing-a-runner.md` tells every other runner
 * author to avoid, using this agent as the worked example:
 *
 *   > The single most useful structural decision in all three runners: the
 *   > capabilities you register and the dispatch that runs them come from the
 *   > same table.
 *
 * The Kotlin and Swift agents do it. This one, the one the documentation points
 * at, did not. And the failure mode is silent in the worse direction: declare
 * something the chain cannot dispatch and the collector routes work here that
 * this agent bounces straight back as "not supported by this runner yet", which
 * from the dashboard looks exactly like a broken workload.
 *
 * ## Why `declares` is a function and not a string
 *
 * Because half of these are conditional and two of them are subtle.
 *
 * A workload whose code is in this repository and needs nothing installed --
 * `benchmark`, `self-check`, `llm-eval` -- declares unconditionally. One that
 * shells out to a toolchain declares only when the binary is actually there,
 * since a capability this machine cannot honour takes the job off the queue
 * from a machine that could have run it.
 *
 * And `build` and `model-convert` each declare a bare name *plus* labels. The
 * collector matches a claim on the workload name, and a build's `kind` lives in
 * `params` where `capabilityMatches` cannot see it -- so a machine declaring
 * only `build:gradle` would never claim a build at all. The bare name is the
 * claim; the labels are for `targets.match` to read.
 *
 * The ordering of this table is the ordering of the declared list, and the
 * capability tests assert on it exactly.
 */
import type { CollectorClient } from "./collector.js";
import type { Descriptor, JobSpec } from "./protocol.js";
import { runBenchmark } from "./workloads/benchmark.js";
import { runBuild } from "./workloads/build.js";
import { runSelfCheck } from "./workloads/selfcheck.js";
import { runModelConvert } from "./workloads/modelconvert.js";
import { runDatasetPrep } from "./workloads/datasetprep.js";
import { runServe } from "./workloads/serve.js";
import { runShell } from "./workloads/shell.js";
import { runLlmEval } from "./workloads/llmeval.js";

/** What the probes found on this machine. */
export type CapabilityFlags = {
  llamaBench: boolean;
  mlx: boolean;
  gradle: boolean;
  xcodebuild: boolean;
  node: boolean;
  /** Which model converters resolved: gguf, coreml, tflite. */
  converters?: string[];
  /** Whether a non-empty shell allowlist exists on this machine. */
  shellAllowlist?: boolean;
  /** Whether a llama-server binary resolved, for the serve workload. */
  llamaServer?: boolean;
};

export type Runner = (
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  device: Descriptor,
) => Promise<void>;

export type Route = {
  /** The `workload` field of a job spec this route claims. */
  workload: string;
  /**
   * What this route contributes to the registered capability list, given what
   * the probes found. Empty means "this machine cannot run it", and the queue
   * will never offer it.
   */
  declares: (flags: CapabilityFlags) => string[];
  run: Runner;
};

export const ROUTES: Route[] = [
  {
    workload: "benchmark",
    // Unconditional: the synthetic backend is in this repository and needs
    // nothing installed. That is the whole point of it -- a machine with no ML
    // toolchain at all is still a useful fleet member, because its synthetic
    // number is comparable with a phone's.
    //
    // The pairings are statements about the toolchain, readable from a
    // targets.match expression. They do not narrow what the queue offers:
    // declaring `benchmark` outright already means every backend this agent was
    // built with. `benchmark:mlx` is therefore honest about the machine and NOT
    // a claim that a backend exists -- there is no MLX backend here yet, and an
    // mlx-backed job is refused with an error row.
    declares: (f) => [
      "benchmark",
      ...(f.llamaBench ? ["benchmark:llama.cpp"] : []),
      ...(f.mlx ? ["benchmark:mlx"] : []),
    ],
    run: runBenchmark,
  },
  {
    workload: "build",
    declares: (f) => {
      const kinds = [
        ...(f.gradle ? ["build:gradle"] : []),
        ...(f.xcodebuild ? ["build:xcode"] : []),
        ...(f.node ? ["build:npm"] : []),
      ];
      // Bare `build` when at least one kind resolves, which is the honest
      // statement: this machine can build something. See the header.
      return kinds.length > 0 ? ["build", ...kinds] : [];
    },
    run: runBuild,
  },
  {
    workload: "self-check",
    // Unconditional for the same reason benchmark is: it shells out to whatever
    // is installed and reports a skipped check for whatever is not, so a machine
    // that can answer none of its questions still answers "I could not" -- which
    // is the reading the alert engine needs.
    declares: () => ["self-check"],
    run: runSelfCheck,
  },
  {
    workload: "llm-eval",
    // Needs nothing installed either. The deterministic rules are arithmetic
    // over strings, and the judge -- when a set has judged items -- is reached
    // over HTTP at an endpoint the JOB names, typically one a `serve` job
    // announced. So this is a statement about this agent's code, always true.
    // A job whose set needs a judge and whose spec names no endpoint is refused
    // with a result row saying exactly that: scoring only the deterministic
    // subset would report a different measurement under the same name.
    declares: () => ["llm-eval"],
    run: runLlmEval,
  },
  {
    workload: "model-convert",
    // Same bare-plus-specific shape as build, for the same reason: a job spec
    // has nowhere to put an output format that capabilityMatches would read.
    declares: (f) =>
      f.converters && f.converters.length > 0
        ? ["model-convert", ...f.converters.map((c) => `model-convert:${c}`)]
        : [],
    run: runModelConvert,
  },
  {
    workload: "dataset-prep",
    // Needs only Node and the image tooling the converters bring along, so it
    // rides on the converters' answer rather than probing twice.
    declares: (f) => (f.converters && f.converters.length > 0 ? ["dataset-prep"] : []),
    run: runDatasetPrep,
  },
  {
    workload: "serve",
    declares: (f) => (f.llamaServer ? ["serve"] : []),
    run: runServe,
  },
  {
    workload: "shell",
    // Declared ONLY when this machine has a non-empty allowlist. That is the
    // trust boundary: POST /jobs is unauthenticated by design, so a machine
    // whose owner has pinned nothing must be unable to CLAIM a shell job at
    // all, rather than claiming it and refusing it afterwards.
    declares: (f) => (f.shellAllowlist ? ["shell"] : []),
    run: runShell,
  },
];

/** The list, given the answers. Pure, so the ordering is testable. */
export function capabilitiesFrom(flags: CapabilityFlags): string[] {
  return ROUTES.flatMap((r) => r.declares(flags));
}

/** The handler for a claimed job, or null if this agent does not run it. */
export function routeFor(workload: string): Route | null {
  return ROUTES.find((r) => r.workload === workload) ?? null;
}
