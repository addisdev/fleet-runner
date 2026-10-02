// The explore workload's checks, on their own: pure pieces plus one whole
// mission against a fake device and a scripted fake model. No phone, no model,
// no collector -- which is why it is a step of its own in `npm test` rather
// than part of the smoke run.
import { runExploreChecks } from "../src/workloads/explore/explore.test.js";

let failed = 0;
let passed = 0;
await runExploreChecks((name, cond, detail = "") => {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail.slice(0, 600)}` : ""}`);
});
console.log(failed ? `  ${failed} of ${passed + failed} explore checks failed` : `  ok — ${passed} explore checks`);
process.exit(failed ? 1 : 0);
