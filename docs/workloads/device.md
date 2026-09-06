# Device workloads

Claimed by the agent running on the device itself, with `"executor": "device"`.
These are the ones that produce hardware numbers.

## `benchmark`

Prefill and decode throughput, load time and peak memory.

```json
{ "schema": 1, "job_id": "bench-1", "workload": "benchmark",
  "executor": "device", "backend": "synthetic",
  "params": { "prompt_tokens": 256, "gen_tokens": 64,
              "warmup_iters": 1, "measure_iters": 3 },
  "targets": { "match": "ram_mb >= 4000" },
  "constraints": { "require_charging": true } }
```

**Metrics:** `prefill_tok_s`, `decode_tok_s`, `load_ms`, `ttft_ms`,
`peak_mem_mb`, `mem_method`, `thermal`, `battery_start_pct`, `battery_end_pct`.

Per-iteration rows at `iter: 1..n`, a summary at `iter: 0` that closes the job.
Warmups are mandatory and not counted — the first pass of anything on a phone
measures the scheduler waking up.

### The two backends are different claims

`backend: "llama.cpp"` is a real model, fetched by content hash and verified.
The model is named in `model`, and the numbers are LLM numbers.

`backend: "synthetic"` is a SHA-256 digest loop sized in tokens. It is **not**
an LLM and is never presented as one. It exists so that a device too slow to
hold a model still produces a comparable number: it is identical on every
platform token for token, which is what puts a 2019 phone and a current one in
the same table.

!!! warning "A benchmark on a device you did not pin is a number that lies"

    `require_charging` exists because an on-battery Samsung was observed
    throttling decode roughly 100× with the screen off. The runner takes a
    wakelock and asks for a doze exemption, and refuses the job outright rather
    than reporting a figure produced under thermal duress.

## `thermal`

The same benchmark, back to back, for about a quarter of an hour. The answer is
a curve rather than a number: does the cold figure survive the device getting
warm?

Nobody ships a cold device, so the sustained number is the honest one. Reports
per-iteration rows with `thermal_state` alongside throughput, so the point where
a device starts throttling is visible rather than averaged away.

## `batch`

Real generation over a set of inputs.

`params.input_sha256` names an artifact of `{"items": [...]}`. The device
processes each item — llama.cpp generates, synthetic digests — and uploads the
outputs as a new artifact referenced from the final result.

This is the workload the `digest` pipeline farms its LLM passes out to.

## `pipeline`

Staged work across several devices, with the collector as the broker.

A pipeline job subscribes to `params.topic`, processes each event's `prompt`,
and publishes to `<topic>.out`. Chaining two of them across two devices gives
you a tiered pipeline where a small model on a fast phone filters for a large
model on a slower one.

## `vision-eval`

Top-1 and top-5 accuracy and per-image latency for an image classifier, via
Core ML on iOS or LiteRT on Android.

**Metrics:** `top1_pct`, `top5_pct`, `p50_ms`, `p95_ms`, `images_per_s`.

Every device pulls the same eval set and the same model **by content hash** and
applies bit-identical preprocessing. That is what makes the accuracy figures
comparable, and in the published plant-ID eval accuracy came out identical to
the decimal on a tablet, an emulator and the host — only latency varied.

!!! danger "The failure this workload exists to catch"

    The iOS Simulator's emulated GPU returned an **all-zero logits tensor** for
    the plant-ID model. Silently: no error, no warning, just zeros, while
    `.cpuOnly` gave logits identical to the Mac. If the eval had not been
    cross-checked against another device, that would have shipped as a real
    accuracy number.

    The runner now forces CPU on simulators and labels it. Run any eval on at
    least two devices.

!!! note "Old rows read differently"

    Before 2026-08-19 vision metrics rode in the LLM slots — top-1 in
    `decode_tok_s`, p50 in `ttft_ms`. The Results screen prefers the named
    fields, falls back, and marks anything it inferred. **A pre-fix Core ML row
    reads `top1: 0.0` because the old code defaulted a missing accuracy to
    zero** — read those as unknown, not as a result.

## `speech-eval`

Word error rate and real-time factor for on-device transcription.

**Metrics:** `wer_pct`, `rtf`, `clips`.

## `embed-eval`

Recall-at-k and throughput for on-device embeddings.

**Metrics:** `recall_at_1`, `recall_at_5`, `recall_at_10`, `docs_per_s`, `dim`.

It asserts that two identical strings embed to cosine 1 **and that two different
strings do not**. The second half is the one that matters: a constant non-zero
vector passes the first check perfectly and scores a corpus at chance. That is
the same class of failure as the all-zero logits tensor above.

## `vantage`

DNS, connect, TLS and TTFB to your own sites, from wherever each agent actually
sits. Runs on phones and on machine agents.

**Metrics:** `dns_ms`, `connect_ms`, `tls_ms`, `ttfb_ms`, `network_type`.

The point is the vantage point. "The site is slow" and "my wifi is slow" are
different problems, and one agent on the house wifi plus one on a phone's
cellular connection tells you which you have.
