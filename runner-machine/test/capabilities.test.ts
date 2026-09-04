/**
 * The capability probes are the fleet's only defence against a machine
 * claiming a toolchain it does not have, so what is tested here is the absent
 * case: a binary that is not there, a variable pointing at a path that was
 * deleted, an empty PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { capabilitiesFrom, resolveLlamaBench, hasMlx, probeCapabilities } from "../src/capabilities.js";
import { which } from "../src/probe.js";

test("benchmark is unconditional; the pairings are not", () => {
  assert.deepEqual(capabilitiesFrom({ llamaBench: false, mlx: false }), ["benchmark"]);
  assert.deepEqual(capabilitiesFrom({ llamaBench: true, mlx: false }), ["benchmark", "benchmark:llama.cpp"]);
  assert.deepEqual(capabilitiesFrom({ llamaBench: false, mlx: true }), ["benchmark", "benchmark:mlx"]);
  assert.deepEqual(capabilitiesFrom({ llamaBench: true, mlx: true }), [
    "benchmark", "benchmark:llama.cpp", "benchmark:mlx",
  ]);
});

test("llama-bench does not resolve with an empty PATH", async () => {
  assert.equal(await resolveLlamaBench({ PATH: "" }), null);
});

test("FLEET_LLAMA_BENCH pointing at nothing is not a declaration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-"));
  assert.equal(await resolveLlamaBench({ FLEET_LLAMA_BENCH: path.join(dir, "llama-bench"), PATH: "" }), null);
});

test("FLEET_LLAMA_BENCH pointing at a non-executable file is not a declaration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-"));
  const file = path.join(dir, "llama-bench");
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o644);
  assert.equal(await resolveLlamaBench({ FLEET_LLAMA_BENCH: file, PATH: "" }), null);
});

test("FLEET_LLAMA_BENCH pointing at a real executable resolves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-"));
  const file = path.join(dir, "llama-bench");
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  assert.equal(await resolveLlamaBench({ FLEET_LLAMA_BENCH: file, PATH: "" }), file);
});

test("a bare llama-bench on a supplied PATH resolves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frm-"));
  const file = path.join(dir, "llama-bench");
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  assert.equal(await resolveLlamaBench({ PATH: dir }), file);
});

test("which does not invent a binary that is not there", async () => {
  assert.equal(await which("definitely-not-a-real-binary-xyz", { PATH: "/usr/bin:/bin" }), null);
});

test("a missing python is not an mlx declaration", async () => {
  assert.equal(await hasMlx({ FLEET_PYTHON: "/nonexistent/python3" }), false);
});

test("a python that cannot import mlx_lm is not an mlx declaration", async () => {
  // /usr/bin/false stands in for an interpreter whose import fails: the probe
  // reads the exit status and nothing else, which is the point.
  assert.equal(await hasMlx({ FLEET_PYTHON: "/usr/bin/false" }), false);
});

test("probeCapabilities degrades to the synthetic-only list on a bare machine", async () => {
  // Exactly the CI runner's situation: no GPU, no llama-bench, no mlx.
  assert.deepEqual(await probeCapabilities({ PATH: "", FLEET_PYTHON: "/nonexistent/python3" }), ["benchmark"]);
});
