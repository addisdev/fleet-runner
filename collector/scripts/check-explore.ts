// The explore workload's checks, on their own: pure pieces plus one whole
// mission against a fake device and a scripted fake model. No phone, no model,
// no collector -- which is why it is a step of its own in `npm test` rather
// than part of the smoke run.
import { runExploreChecks } from "../src/workloads/explore/explore.test.js";
import { runRokuActuatorChecks } from "../src/workloads/explore/actuators/roku.test.js";
import { runAppleActuatorChecks } from "../src/workloads/explore/actuators/apple.test.js";

let failed = 0;
let passed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail.slice(0, 600)}` : ""}`);
};
await runExploreChecks(check);
await runRokuActuatorChecks(check);
await runAppleActuatorChecks(check);
console.log(failed ? `  ${failed} of ${passed + failed} explore checks failed` : `  ok — ${passed} explore checks`);
process.exit(failed ? 1 : 0);
