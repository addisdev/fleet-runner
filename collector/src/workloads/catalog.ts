/**
 * What the fleet can be asked to do, said in a form a program can read.
 *
 * The workload pages in docs/ are for people. An agent composing a job spec
 * needs the same facts as data: which executor claims it, what the params are,
 * and a spec that is known to be valid. Before this the only machine-readable
 * hint was three example shapes pasted into the MCP tool's description, and
 * every other workload had to be guessed -- which an agent will do, fluently
 * and wrongly.
 *
 * The examples are the files in examples/jobs/, imported rather than copied:
 * `npm test` already validates every one of them against the job schema, so a
 * spec served here is one that check has passed. Directory workloads bring
 * their own manifest, whose params schema is the authority for that workload.
 *
 * Imported as JSON so a bundled release carries them; a release has no
 * examples directory next to the code to read at runtime.
 */
import a11yAudit from "../../examples/jobs/a11y-audit.json" with { type: "json" };
import appSoak from "../../examples/jobs/app-soak.json" with { type: "json" };
import archive from "../../examples/jobs/archive.json" with { type: "json" };
import batch from "../../examples/jobs/batch.json" with { type: "json" };
import benchmark from "../../examples/jobs/benchmark.json" with { type: "json" };
import build from "../../examples/jobs/build.json" with { type: "json" };
import coldStart from "../../examples/jobs/cold-start.json" with { type: "json" };
import datasetPrep from "../../examples/jobs/dataset-prep.json" with { type: "json" };
import digest from "../../examples/jobs/digest.json" with { type: "json" };
import drain from "../../examples/jobs/drain.json" with { type: "json" };
import embedEval from "../../examples/jobs/embed-eval.json" with { type: "json" };
import exploreEx from "../../examples/jobs/explore.json" with { type: "json" };
import installEx from "../../examples/jobs/install.json" with { type: "json" };
import localeShots from "../../examples/jobs/locale-shots.json" with { type: "json" };
import modelConvert from "../../examples/jobs/model-convert.json" with { type: "json" };
import pipeline from "../../examples/jobs/pipeline.json" with { type: "json" };
import selfCheck from "../../examples/jobs/self-check.json" with { type: "json" };
import serve from "../../examples/jobs/serve.json" with { type: "json" };
import shell from "../../examples/jobs/shell.json" with { type: "json" };
import speechEval from "../../examples/jobs/speech-eval.json" with { type: "json" };
import thermal from "../../examples/jobs/thermal.json" with { type: "json" };
import uiTest from "../../examples/jobs/ui-test.json" with { type: "json" };
import vantage from "../../examples/jobs/vantage.json" with { type: "json" };
import visionEval from "../../examples/jobs/vision-eval.json" with { type: "json" };
import webAudit from "../../examples/jobs/web-audit.json" with { type: "json" };
import webShots from "../../examples/jobs/web-shots.json" with { type: "json" };
import webTest from "../../examples/jobs/web-test.json" with { type: "json" };
import webUnfurl from "../../examples/jobs/web-unfurl.json" with { type: "json" };
import coldStartManifest from "./cold-start/manifest.json" with { type: "json" };
import enrolManifest from "./enrol/manifest.json" with { type: "json" };
import exploreManifest from "./explore/manifest.json" with { type: "json" };
import installManifest from "./install/manifest.json" with { type: "json" };
import sizeReportManifest from "./size-report/manifest.json" with { type: "json" };
import tvloopManifest from "./tvloop/manifest.json" with { type: "json" };
import upgradeTestManifest from "./upgrade-test/manifest.json" with { type: "json" };

/** Who physically does the work. A "machine" workload is claimed by an agent on a laptop or desktop. */
export type RunsOn = "device" | "host" | "machine";

export type CatalogEntry = {
  name: string;
  /** The `executor` a spec for it must say. */
  executor: "device" | "host";
  runs_on: RunsOn[];
  summary: string;
  /**
   * `shipped`: implemented in this repository. `reserved`: the collector
   * accepts the name, but no runner here implements it yet, so a job for it
   * would wait for an agent that does.
   */
  status: "shipped" | "reserved";
  docs: string | null;
  /** JSON Schema for `params`, when the workload publishes one. */
  params: Record<string, unknown> | null;
  /** A complete spec that validates against the job schema. */
  example: Record<string, unknown> | null;
  /** True when the workload runs scripts or reaches into a host; never offered to remote callers. */
  dangerous?: boolean;
};

const DOCS = "https://addisdev.github.io/fleet-runner/workloads";

type Manifest = { name: string; executor: "host" | "device"; description: string; params: object; example: object };

/**
 * A directory workload's example is a fragment; this makes it a whole spec.
 * Where examples/jobs/ has a file for it, that wins: the manifest's example is
 * a template with the blanks left blank, and a blank sha256 is not a valid spec.
 */
function fromManifest(m: Manifest, page: string, example?: object): CatalogEntry {
  return {
    name: m.name,
    executor: m.executor,
    runs_on: [m.executor === "host" ? "host" : "device"],
    summary: m.description,
    status: "shipped",
    docs: `${DOCS}/${page}#${m.name}`,
    params: m.params as Record<string, unknown>,
    example: (example as Record<string, unknown> | undefined) ??
      { schema: 1, job_id: `example-${m.name}`, workload: m.name, executor: m.executor, ...m.example },
  };
}

const e = (
  name: string, executor: "device" | "host", runsOn: RunsOn[], summary: string,
  page: string | null, example: object | null, extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  name, executor, runs_on: runsOn, summary, status: "shipped",
  docs: page ? `${DOCS}/${page}#${name}` : null, params: null,
  example: example as Record<string, unknown> | null, ...extra,
});

const reserved = (name: string, executor: "device" | "host", runsOn: RunsOn[], summary: string): CatalogEntry => ({
  name, executor, runs_on: runsOn, status: "reserved", docs: null, params: null, example: null,
  summary: `${summary} Reserved: the collector accepts the name, but no runner in this repository implements it yet.`,
});

export const CATALOG: CatalogEntry[] = [
  e("benchmark", "device", ["device", "machine"], "Prefill and decode tok/s via llama.cpp, or a synthetic backend identical on every platform.", "device.md", benchmark),
  e("thermal", "device", ["device"], "The same benchmark back to back for a quarter hour: does the cold number survive.", "device.md", thermal),
  e("batch", "device", ["device"], "Real generation over a set of inputs.", "device.md", batch),
  e("pipeline", "device", ["device"], "Staged work across several devices, with the collector as the broker.", "device.md", pipeline),
  e("vision-eval", "device", ["device"], "Top-1/top-5 accuracy and per-image latency for an image classifier.", "device.md", visionEval),
  e("speech-eval", "device", ["device"], "Word error rate and real-time factor for on-device transcription.", "device.md", speechEval),
  e("embed-eval", "device", ["device"], "Recall-at-k and throughput for on-device embeddings.", "device.md", embedEval),
  e("vantage", "device", ["device", "machine"], "DNS, connect, TLS and TTFB to your own sites, from where each agent actually sits.", "device.md", vantage),
  e("llm-eval", "device", ["machine"], "Scores what a device generated, so a fast quantised model can be shown to also be right.", "machine.md", null),
  fromManifest(enrolManifest as Manifest, "host.md"),
  fromManifest(installManifest as Manifest, "host.md", installEx),
  e("ui-test", "host", ["host"], "Maestro flows or an XCUITest bundle, per attached device.", "host.md", uiTest),
  fromManifest(coldStartManifest as Manifest, "host.md", coldStart),
  e("app-soak", "host", ["host"], "Memory, jank and crashes over hours.", "host.md", appSoak),
  e("a11y-audit", "host", ["host"], "The accessibility tree diffed against a baseline at the largest dynamic type.", "host.md", a11yAudit),
  e("locale-shots", "host", ["host"], "A screenshot flow under every locale, including RTL, as a contact sheet.", "host.md", localeShots),
  fromManifest(exploreManifest as Manifest, "host.md", exploreEx),
  fromManifest(upgradeTestManifest as Manifest, "host.md"),
  fromManifest(sizeReportManifest as Manifest, "host.md"),
  fromManifest(tvloopManifest as Manifest, "host.md"),
  e("web-test", "host", ["host"], "Playwright suites, including on real phone screens.", "host.md", webTest),
  e("web-shots", "host", ["host"], "Visual regression captures diffed against an accepted baseline.", "host.md", webShots),
  e("web-audit", "host", ["host"], "Crawl-and-audit with a real browser.", "host.md", webAudit),
  e("web-unfurl", "host", ["host"], "The raw HTML link preview bots actually see.", "host.md", webUnfurl),
  e("drain", "host", ["host"], "Battery curve under a replayed GPX track.", "host.md", drain),
  e("soak", "host", ["host"], "Whether a runner is still alive hours later.", "host.md", null),
  e("archive", "host", ["host"], "Store reviews and Search Console data, kept past the vendor's retention.", "host.md", archive),
  e("digest", "host", ["host"], "The shelf summarising its own reviews using its own models.", "host.md", digest),
  e("build", "device", ["machine"], "Check out a ref, build it, publish the product as an artifact.", "machine.md", build),
  e("model-convert", "device", ["machine"], "A checkpoint into GGUF, Core ML or TFLite.", "machine.md", modelConvert),
  e("dataset-prep", "device", ["machine"], "An eval set, carrying its licence and source on the row.", "machine.md", datasetPrep),
  e("serve", "device", ["machine"], "Host a model for the length of a lease and announce its endpoint.", "machine.md", serve),
  e("shell", "device", ["machine"], "A pinned script, behind an allowlist the machine's owner controls.", "machine.md", shell, { dangerous: true }),
  e("self-check", "device", ["host", "machine"], "The fleet inspecting its own hosts: disk, tool versions, clock drift.", "machine.md", selfCheck),
  reserved("push-latency", "device", ["device"], "Push notification delivery latency."),
  reserved("camera-eval", "device", ["device"], "Model accuracy on the device's own camera."),
  reserved("desktop-ui-test", "host", ["machine"], "UI suites for desktop apps."),
];

const BY_NAME = new Map(CATALOG.map((c) => [c.name, c]));

export function catalogEntry(name: string): CatalogEntry | null {
  return BY_NAME.get(name) ?? null;
}
