/**
 * What a workload is, and what it is allowed to reach for.
 *
 * The executor used to be one file with every handler in it and a chain of
 * `else if` at the bottom. That shape had two costs. The module has a `main()`
 * loop, so importing it starts polling the collector — which meant no handler
 * in it could ever be unit-tested, and the only way to exercise one was to plug
 * in a phone. And every new workload was another edit to the file everybody
 * else was also editing, so adding one meant a merge conflict with whoever was
 * fixing an unrelated handler that week.
 *
 * A workload is now a directory: a manifest saying what it is and what it
 * needs, and an `index.ts` exporting `run`. Nothing registers it; the loader
 * finds it because the directory is there.
 *
 * The `ctx` below is the other half of that. Handlers used to import
 * `postResult`, `uploadArtifact` and the rest straight from `fleet-client.js`,
 * which made every dependency ambient: you could not tell from a handler's
 * signature whether it talked to the collector, moved artifacts, or read the
 * Keychain, and a test had no seam to substitute any of it. Passing them in
 * makes the dependency list part of the type, and lets a test hand a handler a
 * fake collector and watch what it posts.
 *
 * What ctx deliberately does NOT carry is `exec`. Shelling out to adb, simctl,
 * devicectl, xcodebuild and npx is the job, not a dependency worth abstracting:
 * a fake `exec` would be a re-implementation of four toolchains, and a test
 * written against it would pass while the real thing was broken. So a handler
 * is testable exactly up to its first shell-out — which, in practice, covers
 * every refusal, precondition and result-shaping path, and those are the ones
 * that have actually been wrong.
 */
import type { Job } from "../executor.js";

// Type-only, and it has to stay that way: executor.ts calls main() at the
// bottom, so a runtime import of it from here would start a second poll loop
// inside whatever imported the workload. `import type` is erased, which is why
// src/web/* has always imported Job the same way.
export type { Job };

/** One thing this executor can drive. Mirrors executor.ts's own Target. */
export type Target = {
  id: string;
  platform: "android" | "ios";
  kind?: "device" | "simulator";
};

/** What a suite needs to sign in. `password` is resolved on the host, never carried in a spec. */
export type SuiteCredentials = {
  account: string;
  password: string;
  emailVar: string;
  passwordVar: string;
};

/**
 * The secrets seam.
 *
 * Narrow on purpose. A workload can ask for a suite's sign-in details and can
 * scrub a string before it becomes an artifact; it cannot enumerate the
 * Keychain. `credentialsFor` throws with a remedy rather than returning null on
 * failure — null means "this suite did not ask to sign in", which is a
 * different thing from "it asked and we could not".
 */
export type WorkloadSecrets = {
  credentialsFor(
    suite: NonNullable<Job["suite"]>,
    who: string,
  ): Promise<SuiteCredentials | null>;
  redact(text: string, secrets: string[]): string;
};

/**
 * Everything a handler is given. If it is not here, a handler either does not
 * need it or is shelling out for it.
 */
export type WorkloadCtx = {
  /**
   * This executor's name. Every workload closes with a final row on
   * `host:<host>`, because a result row needs a device_id and the host is what
   * actually ran when the answer is about the job rather than a device.
   */
  host: string;
  /** Prefixed, line-per-event logging. The executor's log is read as a narrative. */
  log(msg: string): void;
  /** Post one result row. `final: true` closes the job. */
  postResult(row: Record<string, unknown>): Promise<void>;
  /** Post a beacon. Renews the lease as a side effect, which is often the point. */
  postBeacon(jobId: string, deviceId: string, extra: Record<string, unknown>): Promise<void>;
  /** Fetch an artifact by hash to `dest`, verifying the hash. */
  fetchArtifact(sha256: string, dest: string): Promise<void>;
  /** Upload a file to the artifact store under `name`; returns its sha256. */
  uploadArtifact(file: string, name: string): Promise<string>;
  /** Everything attached to this host that the fleet owns. */
  listTargets(): Promise<Target[]>;
  /** Narrow those to the ones this job asked for (device_id, kind, match). */
  selectTargets(job: Job, all: Target[]): Promise<Target[]>;
  secrets: WorkloadSecrets;
  /**
   * The per-unit time budget the lease allows, in seconds. A unit of work that
   * does not beacon must finish inside this, or the sweep requeues a job that
   * is still running and a second executor runs it concurrently.
   */
  leaseBudgetS(job: Job, fallbackS?: number): number;
};

/**
 * The signature every `index.ts` exports.
 *
 * A handler reports by posting rows, not by returning: a job with ten devices
 * has eleven answers and no single return value describes them. It throws only
 * when the job cannot start at all — a missing app ref, a spec that names
 * nothing — and the executor turns that into the failed final row.
 */
export type WorkloadRun = (job: Job, ctx: WorkloadCtx) => Promise<void>;

/**
 * What a host must have before this workload can honestly run on it.
 *
 * Three, because there are three real answers on these machines:
 *
 *   devices  -- attached hardware or simulators, driven over adb / simctl /
 *               devicectl. Every workload whose result is about a phone.
 *   browsers -- a Playwright install. Present on one machine in the fleet, so
 *               a job needing it and landing elsewhere must say so rather than
 *               download a browser onto a 2016 laptop mid-nightly.
 *   network  -- a route to the site or API under test and nothing else. These
 *               run anywhere.
 *
 * It is advisory today: the loader records it and the dispatcher does not yet
 * refuse on it, because the workloads that gate (web-test on FLEET_WEB) still
 * do their own gating and this refactor changes no behaviour. It is stated in
 * the manifest so the check has one place to move to.
 */
export type WorkloadCapability = "devices" | "browsers" | "network";

/** manifest.json, as it is on disk. */
export type WorkloadManifest = {
  /** The `workload` string in a job spec. Must equal the directory name. */
  name: string;
  capability: WorkloadCapability;
  /** One sentence, in the composer's voice: what this does and what you get. */
  description: string;
  /** Which executor claims it. Host workloads run here; device ones run on the phone's agent. */
  executor: "host" | "device";
  /** JSON Schema for `params`. Documentation and, one day, validation. */
  params: Record<string, unknown>;
  /** A starting-point spec for the composer. Edited by a person, not validated. */
  example: Record<string, unknown>;
};
