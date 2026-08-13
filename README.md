# fleet-runner-ios

Swift runner app for the Fleet Runner device fleet — **Phase 3, not started**.

This repo is a placeholder created alongside [`fleet-runner-android`](https://github.com/addisdev/fleet-runner-android)
so the fleet repos exist under one naming convention from day one. The Android
runner is being built first (Phase 1); this app mirrors it when Phase 3 starts.

## What it will be

A thin Swift 6 + SwiftUI app that mirrors the Android runner's JSON protocol
(shared protocol, not shared code):

- Agent loop long-polling the collector (`GET /devices/:id/next-job`)
- Telemetry beacon (battery, thermal state, memory pressure)
- `ModelBackend` implementations: llama.cpp via SPM (GGUF, Metal), then Core ML
  (`.mlmodelc`), possibly MLX later
- Benchmark workload engine with warmups, prefill/decode split, and
  `phys_footprint` memory reporting (labeled, never compared to Android PSS)
- Distribution via TestFlight internal

## Related

- Collector + protocol schemas: [`fleet-collector`](https://github.com/addisdev/fleet-collector)
  — `schemas/job.schema.json` and `schemas/result.schema.json` are the contract.
- Plan: `~/Desktop/Fleet Runner/fleet-runner-plan.html`
