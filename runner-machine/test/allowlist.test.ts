/**
 * The shell allowlist is the fleet's only trust boundary.
 *
 * `POST /jobs` is unauthenticated by design — anyone who can reach the
 * collector can enqueue work — so "run this script" is the one workload where
 * the collector's word cannot be enough. The machine's owner pins a sha by
 * hand, and nothing else runs. Every test here is about the refusal, because a
 * permissive bug in this file is arbitrary code execution and a restrictive
 * one is merely a job that does not run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAllowlist, isAllowlisted, loadAllowlist } from "../src/allowlist.js";
import { capabilitiesFrom } from "../src/capabilities.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("a listed sha is allowed and an unlisted one is not", () => {
  assert.equal(isAllowlisted(A, [A]), true);
  assert.equal(isAllowlisted(B, [A]), false);
});

test("one character of difference is a different script", () => {
  // The whole point of addressing a script by content: an attacker who can
  // enqueue jobs can name any sha they like, and only the exact bytes the
  // owner pinned may run.
  const nearly = `${"a".repeat(63)}b`;
  assert.equal(isAllowlisted(nearly, [A]), false);
});

test("case differs between shasum and a dashboard, and is the same hash", () => {
  assert.equal(isAllowlisted(A.toUpperCase(), [A]), true);
});

test("anything that is not a well-formed sha256 is refused", () => {
  // These arrive from a job spec, so they are attacker-controlled. A truthy
  // non-string must never reach a comparison that could coerce.
  for (const bad of ["", "not-a-sha", A.slice(0, 63), `${A}a`, "../../etc/passwd", null, undefined, 42, {}, [A]]) {
    assert.equal(isAllowlisted(bad, [A]), false, `refused: ${JSON.stringify(bad)}`);
  }
});

test("an empty allowlist allows nothing at all", () => {
  assert.equal(isAllowlisted(A, []), false);
});

test("comments and blank lines are ignored; malformed entries are reported, not allowed", () => {
  const { allowed, rejected } = parseAllowlist(
    ["# the deploy script", "", `${A}  # pinned 2026-09-04`, "  ", "nonsense-line", `${B}`].join("\n"),
  );
  assert.deepEqual(allowed, [A, B]);
  // Surfaced rather than silently dropped: a typo'd sha should look like a
  // mistake in the file, not like a script that mysteriously will not run.
  assert.deepEqual(rejected, ["nonsense-line"]);
});

test("a duplicate sha is listed once", () => {
  assert.deepEqual(parseAllowlist([A, A].join("\n")).allowed, [A]);
});

test("a missing allowlist file is empty, not an error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fleet-allow-"));
  const env = { FLEET_SHELL_ALLOWLIST: path.join(dir, "absent.txt") } as NodeJS.ProcessEnv;
  const res = await loadAllowlist(env);
  assert.equal(res.exists, false);
  assert.deepEqual(res.allowed, []);
});

test("a file that exists is read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fleet-allow-"));
  const file = path.join(dir, "shell-allowlist.txt");
  await writeFile(file, `# pinned by hand\n${A}\n`);
  const res = await loadAllowlist({ FLEET_SHELL_ALLOWLIST: file } as NodeJS.ProcessEnv);
  assert.equal(res.exists, true);
  assert.deepEqual(res.allowed, [A]);
});

test("shell is declared only when this machine has a non-empty allowlist", () => {
  const bare = { llamaBench: false, mlx: false, gradle: false, xcodebuild: false, node: false };
  // A machine whose owner has pinned nothing must be unable to CLAIM a shell
  // job at all, rather than claiming it and refusing it afterwards. Refusing
  // after the claim would still take the job off the queue.
  assert.equal(capabilitiesFrom({ ...bare, shellAllowlist: false }).includes("shell"), false);
  assert.equal(capabilitiesFrom({ ...bare, shellAllowlist: true }).includes("shell"), true);
});

test("model-convert is declared bare as well as per format", () => {
  const bare = { llamaBench: false, mlx: false, gradle: false, xcodebuild: false, node: false };
  const caps = capabilitiesFrom({ ...bare, converters: ["gguf", "tflite"] });
  // Bare, because the collector's capabilityMatches reads workload and backend
  // and a job spec has nowhere to put an output format — so the specific
  // labels alone would be a machine that can convert and never claims one.
  assert.equal(caps.includes("model-convert"), true);
  assert.equal(caps.includes("model-convert:gguf"), true);
  assert.equal(caps.includes("model-convert:tflite"), true);
  assert.equal(caps.includes("model-convert:coreml"), false);
  assert.equal(capabilitiesFrom({ ...bare, converters: [] }).includes("model-convert"), false);
});

test("serve is declared only where a llama-server resolved", () => {
  const bare = { llamaBench: false, mlx: false, gradle: false, xcodebuild: false, node: false };
  assert.equal(capabilitiesFrom({ ...bare, llamaServer: false }).includes("serve"), false);
  assert.equal(capabilitiesFrom({ ...bare, llamaServer: true }).includes("serve"), true);
});
