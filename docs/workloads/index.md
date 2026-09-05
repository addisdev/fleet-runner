# Workloads

What the fleet can be asked to do. A workload is the `workload` field of a job
spec, and which agent claims it is decided by
[capabilities](../concepts.md#capabilities) rather than by anything hardcoded.

| Workload | Runs on | What it measures |
|---|---|---|
| [`benchmark`](device.md#benchmark) | device, machine | Prefill and decode tok/s via llama.cpp, or a synthetic backend identical on every platform |
| [`thermal`](device.md#thermal) | device | The same benchmark back to back for a quarter hour — does the cold number survive |
| [`batch`](device.md#batch) | device | Real generation over a set of inputs |
| [`pipeline`](device.md#pipeline) | device | Staged work across several devices, with the collector as the broker |
| [`vision-eval`](device.md#vision-eval) | device | Top-1/top-5 accuracy and per-image latency for an image classifier |
| [`speech-eval`](device.md#speech-eval) | device | Word error rate and real-time factor for on-device transcription |
| [`embed-eval`](device.md#embed-eval) | device | Recall-at-k and throughput for on-device embeddings |
| [`vantage`](device.md#vantage) | device, machine | DNS, connect, TLS and TTFB to your own sites, from where each agent actually sits |
| [`install`](host.md#install) | host | One artifact onto every attached device |
| [`ui-test`](host.md#ui-test) | host | Maestro flows or an XCUITest bundle per device |
| [`cold-start`](host.md#cold-start) | host | Launch from cold, warm and hot; p50 and p95 per state |
| [`app-soak`](host.md#app-soak) | host | Memory, jank and crashes over hours |
| [`a11y-audit`](host.md#a11y-audit) | host | The accessibility tree diffed against a baseline at the largest dynamic type |
| [`locale-shots`](host.md#locale-shots) | host | A screenshot flow under every locale, including RTL, as a contact sheet |
| [`web-test`](host.md#web-test) | host | Playwright suites, including on real phone screens |
| [`web-shots`](host.md#web-shots) | host | Visual regression captures diffed against an accepted baseline |
| [`web-audit`](host.md#web-audit) | host | Crawl-and-audit with a real browser |
| [`web-unfurl`](host.md#web-unfurl) | host | The raw HTML link-preview bots actually see, which is a different answer |
| [`drain`](host.md#drain) | host | Battery curve under a replayed GPX track |
| [`soak`](host.md#soak) | host | Whether a runner is still alive hours later |
| [`archive`](host.md#archive) | host | Store reviews and Search Console data, kept past the vendor's retention |
| [`digest`](host.md#digest) | host | The shelf summarising its own reviews using its own models |
| [`build`](machine.md#build) | machine | Check out a ref, build it, publish the product as an artifact |
| [`model-convert`](machine.md#model-convert) | machine | A checkpoint into GGUF, Core ML or TFLite |
| [`dataset-prep`](machine.md#dataset-prep) | machine | An eval set, carrying its licence and source on the row |
| [`serve`](machine.md#serve) | machine | Host a model for the length of a lease and announce its endpoint |
| [`shell`](machine.md#shell) | machine | A pinned script, behind an allowlist the owner controls |
| [`self-check`](machine.md#self-check) | host, machine | The fleet inspecting its own hosts: disk, tool versions, clock drift |

## How to read these pages

Each workload says what it measures, the shape of the job spec, the metrics it
reports, and — usually the useful part — **what it refuses to do**. Those
refusals are deliberate. A workload that quietly approximates something it
cannot measure produces a number indistinguishable from a real one, and this
project has been bitten by exactly that.

## The three families

**[Device workloads](device.md)** run inside the agent app, on the phone or
laptop itself. They are the ones that produce hardware numbers.

**[Host workloads](host.md)** run in an executor process on a Mac and drive a
device from outside, over adb or `simctl`. Installing a build or tapping through
a UI test is not something an app can do to itself.

**[Machine workloads](machine.md)** run on a laptop or desktop agent and are
about producing things the rest of the fleet consumes — builds, converted
models, prepared datasets — or about the fleet inspecting itself.

## Adding one

You do not need a collector release. The collector accepts any workload a
registered agent declares in its capabilities; see [Writing a
runner](../writing-a-runner.md).
