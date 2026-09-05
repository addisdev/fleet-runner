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
import { capabilitiesFrom, resolveLlamaBench, hasMlx, probeCapabilities, probeBuildKinds } from "../src/capabilities.js";
import { which } from "../src/probe.js";

/** Nothing installed: the floor every other case is a delta from. */
const bare = { llamaBench: false, mlx: false, gradle: false, xcodebuild: false, node: false };

test("benchmark and self-check are unconditional; the pairings are not", () => {
  assert.deepEqual(capabilitiesFrom(bare), ["benchmark", "self-check"]);
  assert.deepEqual(capabilitiesFrom({ ...bare, llamaBench: true }), [
    "benchmark", "benchmark:llama.cpp", "self-check",
  ]);
  assert.deepEqual(capabilitiesFrom({ ...bare, mlx: true }), ["benchmark", "benchmark:mlx", "self-check"]);
  assert.deepEqual(capabilitiesFrom({ ...bare, llamaBench: true, mlx: true }), [
    "benchmark", "benchmark:llama.cpp", "benchmark:mlx", "self-check",
  ]);
});

test("a build kind is declared only when its binary resolves", () => {
  assert.deepEqual(capabilitiesFrom({ ...bare, gradle: true }), [
    "benchmark", "build", "build:gradle", "self-check",
  ]);
  assert.deepEqual(capabilitiesFrom({ ...bare, xcodebuild: true }), [
    "benchmark", "build", "build:xcode", "self-check",
  ]);
  assert.deepEqual(capabilitiesFrom({ ...bare, node: true }), [
    "benchmark", "build", "build:npm", "self-check",
  ]);
});

test("bare `build` rides along with any kind, and only with a kind", () => {
  // The collector's claim path matches a job's workload against this list, and
  // a build job's spec carries its kind in params where capabilityMatches
  // cannot see it. Without bare `build` a machine with every toolchain
  // installed would never claim a build job at all.
  assert.ok(!capabilitiesFrom(bare).includes("build"));
  for (const kind of ["gradle", "xcodebuild", "node"] as const) {
    const caps = capabilitiesFrom({ ...bare, [kind]: true });
    assert.ok(caps.includes("build"), `${kind} alone should still declare bare build`);
  }
  const all = capabilitiesFrom({ ...bare, gradle: true, xcodebuild: true, node: true });
  assert.equal(all.filter((c) => c === "build").length, 1, "build is declared once, not once per kind");
  assert.deepEqual(all, ["benchmark", "build", "build:gradle", "build:xcode", "build:npm", "self-check"]);
});

test("an empty PATH declares no build kind at all", async () => {
  assert.deepEqual(await probeBuildKinds({ PATH: "" }), {
    gradle: false, xcodebuild: false, node: false,
  });
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
  // No GPU, no llama-bench, no mlx, and no toolchain — and still a useful
  // fleet member, because both remaining workloads need nothing installed.
  assert.deepEqual(
    await probeCapabilities({ PATH: "", FLEET_PYTHON: "/nonexistent/python3" }),
    ["benchmark", "self-check"],
  );
});
