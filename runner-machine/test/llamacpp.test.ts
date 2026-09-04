/**
 * The llama-bench output parser.
 *
 * These fixtures are written from llama-bench's documented `-o json` fields,
 * not captured from a run: there is no llama.cpp build on the machine this was
 * developed on, which is exactly the situation the capability probe exists to
 * describe honestly. The parser is therefore verified against the shape and
 * NOT against a real binary — see the README's status section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLlamaBench, cacheDir } from "../src/backends/llamacpp.js";
import { backendFor } from "../src/workloads/benchmark.js";
import { CollectorClient } from "../src/collector.js";

const rows = [
  { n_prompt: 512, n_gen: 0, avg_ts: 125.4, avg_ns: 4_083_000_000, reps: 1 },
  { n_prompt: 0, n_gen: 128, avg_ts: 47.4, avg_ns: 2_700_000_000, reps: 1 },
];

test("a prompt row is prefill and a generation row is decode", () => {
  const p = parseLlamaBench(JSON.stringify(rows), 8000);
  assert.equal(p.prefillTokS, 125.4);
  assert.equal(p.decodeTokS, 47.4);
});

test("load_ms is the wall time the tests did not account for", () => {
  // 4.083 s + 2.700 s of measured work inside an 8.000 s process.
  const p = parseLlamaBench(JSON.stringify(rows), 8000);
  assert.equal(p.loadMs, 8000 - 4083 - 2700);
});

test("load_ms never goes negative when the wall clock disagrees", () => {
  const p = parseLlamaBench(JSON.stringify(rows), 1000);
  assert.equal(p.loadMs, 0);
});

test("reps multiply the measured time", () => {
  const p = parseLlamaBench(
    JSON.stringify([{ n_prompt: 512, n_gen: 0, avg_ts: 100, avg_ns: 1_000_000_000, reps: 3 }]),
    5000,
  );
  assert.equal(p.loadMs, 2000);
});

test("samples_ns stands in when avg_ns is absent", () => {
  const p = parseLlamaBench(
    JSON.stringify([{ n_prompt: 512, n_gen: 0, avg_ts: 100, samples_ns: [1_000_000_000, 1_000_000_000] }]),
    3000,
  );
  assert.equal(p.loadMs, 1000);
});

test("a results-wrapped object parses the same as a bare array", () => {
  const p = parseLlamaBench(JSON.stringify({ results: rows }), 8000);
  assert.equal(p.prefillTokS, 125.4);
  assert.equal(p.decodeTokS, 47.4);
});

test("no rows is an error, not a row of undefineds", () => {
  assert.throws(() => parseLlamaBench("[]", 100), /no result rows/);
  assert.throws(() => parseLlamaBench("not json", 100));
});

test("a run with only a generation row still reports decode", () => {
  const p = parseLlamaBench(JSON.stringify([{ n_prompt: 0, n_gen: 128, avg_ts: 47.4, avg_ns: 2_700_000_000 }]), 3000);
  assert.equal(p.prefillTokS, undefined);
  assert.equal(p.decodeTokS, 47.4);
});

test("the model cache is overridable and defaults under the home directory", () => {
  assert.equal(cacheDir({ FLEET_CACHE_DIR: "/tmp/models" }), "/tmp/models");
  assert.match(cacheDir({}), /fleet-runner-machine$/);
});

test("an unknown backend is refused by name rather than silently run as synthetic", () => {
  const client = new CollectorClient("http://127.0.0.1:1");
  const job = { schema: 1, job_id: "j", workload: "benchmark", executor: "device" as const };
  assert.equal(backendFor({ ...job }, client).name, "synthetic");
  assert.equal(backendFor({ ...job, backend: "synthetic" }, client).name, "synthetic");
  assert.equal(backendFor({ ...job, backend: "llama.cpp" }, client).name, "llama.cpp");
  // mlx is declared as a capability when the toolchain is there, but no backend
  // exists yet, and saying so beats producing a number from somewhere else.
  assert.throws(() => backendFor({ ...job, backend: "mlx" }, client), /backend 'mlx' not supported/);
  assert.throws(() => backendFor({ ...job, backend: "coreml" }, client), /backend 'coreml' not supported/);
});

test("the llama.cpp backend refuses to start without a binary", async () => {
  const client = new CollectorClient("http://127.0.0.1:1");
  const { LlamaCppBackend } = await import("../src/backends/llamacpp.js");
  const backend = new LlamaCppBackend(client, { PATH: "" });
  await assert.rejects(
    () => backend.load({
      schema: 1, job_id: "j", workload: "benchmark", executor: "device",
      model: { name: "m", format: "gguf", sha256: "0".repeat(64) },
    }),
    /llama.cpp backend unavailable/,
  );
});
