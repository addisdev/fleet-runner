import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsTaskCommand } from "../src/service.js";

// The scheduled task's command line. execFile quotes and escapes this string
// itself when it hands it to schtasks, so any escaping written here survives
// into the task: `\"C:\...\node.exe\"` is what the first CI run found stored,
// and the task failed with "file not found" every time it ran.
test("the schtasks /TR string quotes each part with bare quotes", () => {
  const tr = windowsTaskCommand("C:\\Program Files\\nodejs\\node.exe", [
    "C:\\Users\\Jo Smith\\.fleet\\bin\\fleet.mjs",
    "up",
    "--role",
    "brain,agent",
  ]);
  assert.equal(
    tr,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jo Smith\\.fleet\\bin\\fleet.mjs" "up" "--role" "brain,agent"',
  );
  assert.ok(!tr.includes('\\"'), "no backslash-escaped quotes");
});
