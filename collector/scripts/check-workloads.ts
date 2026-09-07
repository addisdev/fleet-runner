/**
 * The two workload lists agree.
 *
 * src/workloads/ is walked at startup by the registry, and named literally in
 * static.ts so that a bundled executor -- which has no directory to walk -- can
 * still load them. Two lists drift; this is what stops them.
 *
 * The two directions fail differently and both are bad:
 *
 * - a directory missing from static.ts works in a checkout and disappears from
 *   the bundle, so the workload exists on the developer's machine and on
 *   nobody else's
 * - a name in static.ts with no directory throws at import time, inside the
 *   executor, the first time anyone enqueues it
 */
import { discoverWorkloads } from "../src/workloads/registry.js";
import { bundledNames } from "../src/workloads/static.js";

const problems: string[] = [];
const onDisk = [...discoverWorkloads((m) => problems.push(m)).keys()].sort();
const bundled = bundledNames();

let failed = false;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed = true;
};

check("every workload directory has a readable manifest", problems.length === 0, problems.join("; "));
check("at least one workload was found", onDisk.length > 0, "the walk found nothing, so this check checks nothing");

const missing = onDisk.filter((n) => !bundled.includes(n));
const stale = bundled.filter((n) => !onDisk.includes(n));
check("every workload directory is named in static.ts", missing.length === 0, `not bundled: ${missing.join(", ")}`);
check("every name in static.ts has a directory", stale.length === 0, `no directory: ${stale.join(", ")}`);

// And each one actually loads through the bundled path, which is what a release
// runs. Importing is the only way to find out; a name that resolves to a module
// with no `run` export is a workload that fails on its first job.
for (const name of bundled) {
  const { bundledRun } = await import("../src/workloads/static.js");
  let ok = false;
  let why = "";
  try {
    ok = typeof (await bundledRun(name)) === "function";
  } catch (e) {
    why = (e as Error).message;
  }
  check(`${name} loads through the bundled path`, ok, why);
}

console.log(failed ? "\nworkloads: FAILED" : `\nworkloads: ALL PASS (${bundled.length})`);
process.exit(failed ? 1 : 0);
