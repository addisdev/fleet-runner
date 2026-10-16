// Every example job spec in examples/jobs/ is validated against the job schema
// /api/v1 enforces (strict; see below), and the docs include those files
// rather than copies of them.
//
// This exists because the schema is documentation that nothing enforced. The
// collector does not validate POST /jobs against it — it never has — so the
// file was free to drift from the thing it describes, and it had:
//
//   - `backend` did not list `synthetic`, which all three runners emit and the
//     collector reads as the default a result row assumes. Widened here to the
//     values that actually ship; the waves-4-8 branch opens the field entirely,
//     the way `workload` already is, which is the better fix and supersedes
//     this one.
//   - `app.sha256` required 64 hex characters, so `"latest"` — the value the
//     CI documentation tells everyone to schedule, and the one resolveLatestBuild
//     exists to serve — was invalid against its own schema.
//   - Neither sha256 accepted a `${jobs.<id>.artifact}` reference, which the
//     `depends_on` description two properties below promises by name.
//
// A schema that states a contract confidently and wrongly is worse than no
// schema, which is the same argument schemas/metrics.json is checked under.
// The examples are the enforcement: they are what the docs show a reader, so
// if they stop validating, the docs are lying to somebody.
//
// ## Strict, since 0.9
//
// The check used to be the loose job.schema.json, which allows keys it does not
// know and has no opinion about a workload's params. `/api/v1` is stricter: an
// unknown key is refused, and params are checked against the workload's
// manifest. An example that passed here could still be refused by the API it
// documents, so this now runs the API's own check -- the same compiled schemas,
// imported from src/api/v1/spec-check.ts, not a copy.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { specProblems } from "../src/api/v1/spec-check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "examples/jobs");

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("examples/jobs is empty; refusing to pass");
  process.exit(1);
}

const problems: string[] = [];

for (const file of files) {
  const full = path.join(DIR, file);
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(full, "utf8"));
  } catch (e) {
    problems.push(`${file}  does not parse: ${(e as Error).message}`);
    continue;
  }

  // What POST /api/v1/jobs fills in before it validates, and nothing more.
  const raw = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {};
  const asPosted = { ...raw, schema: raw.schema ?? 1, job_id: raw.job_id ?? `example-${file}` };
  for (const err of specProblems(asPosted)) problems.push(`${file}${err.path}  ${err.message}`);

  // The docs promise the filename names the workload it demonstrates, and a
  // reader looking for `drain` should not have to open every file to find it.
  const workload = (spec as { workload?: string }).workload;
  const stem = file.replace(/\.json$/, "");
  if (workload && !stem.startsWith(workload) && !stem.startsWith("chain-")) {
    problems.push(`${file}  is workload "${workload}"; name it "${workload}*.json" or "chain-*.json"`);
  }
}

if (problems.length) {
  console.error(`  ${problems.length} problem(s):`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(
    "\nThese files are included verbatim in docs/integration/cookbook.md, so a\n" +
      "spec that does not validate is a documented example POST /api/v1/jobs would refuse.\n",
  );
  process.exit(1);
}

console.log(`  ok — ${files.length} example job specs pass /api/v1's strict schema and their params manifests`);
