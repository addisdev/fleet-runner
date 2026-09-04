/**
 * Checks for the pure half of energy accounting: the watts path expression and
 * the integration arithmetic.
 *
 * `npx tsx src/power.test.ts` — no database, no collector, no plug.
 *
 * These live in a module rather than in scripts/smoke.ts (where the collector's
 * other pure-function checks sit, alongside `evalMatch` and `parseAmStart`)
 * only because that file was not mine to edit in this change. `runPowerChecks`
 * is exported with the same `check(name, cond)` shape smoke.ts uses so it can be
 * folded in there with one import and one call — and it imports src/watts.ts,
 * which touches no database, so it stays runnable from anywhere.
 */
import { pathToFileURL } from "node:url";
import {
  extractWatts,
  integrateWh,
  median,
  parsePath,
  percentile,
  readPath,
  type WattSample,
} from "./watts.js";

export function runPowerChecks(check: (name: string, cond: boolean, detail?: string) => void) {
  // --- path expressions -------------------------------------------------
  check("a dotted path parses", JSON.stringify(parsePath("StatusSNS.ENERGY.Power")) === '["StatusSNS","ENERGY","Power"]');
  check("an array index parses as a number", JSON.stringify(parsePath("meters[0].power")) === '["meters",0,"power"]');
  check(
    "a bracket-quoted segment keeps its colon",
    JSON.stringify(parsePath('["switch:0"].apower')) === '["switch:0","apower"]',
  );
  let threw = false;
  try {
    parsePath("meters[0");
  } catch {
    threw = true;
  }
  check("an unterminated bracket throws rather than silently truncating", threw);

  // The three vendors the config shape exists for, in their own shapes.
  const tasmota = { StatusSNS: { Time: "2026-09-04T12:00:00", ENERGY: { Power: 12.4, Voltage: 241 } } };
  const shelly1 = { meters: [{ power: 7.75, is_valid: true }] };
  const shelly2 = { "switch:0": { apower: 3.2, voltage: 239.1 } };
  const kasa = { emeter: { get_realtime: { power_mw: 8123, err_code: 0 } } };

  check("tasmota watts", extractWatts(tasmota, "StatusSNS.ENERGY.Power") === 12.4);
  check("shelly gen1 watts", extractWatts(shelly1, "meters[0].power") === 7.75);
  check("shelly gen2 watts", extractWatts(shelly2, '["switch:0"].apower') === 3.2);
  check("shelly gen2 watts, unquoted", extractWatts(shelly2, "switch:0.apower") === 3.2);
  check("kasa milliwatts scale to watts", extractWatts(kasa, "emeter.get_realtime.power_mw", 0.001) === 8.123);

  // A wrong path, or a plug answering with an error, must produce NO sample.
  // Returning 0 here would write "the pool drew nothing" into the table, which
  // is a measurement, and is exactly the lie this returns null to avoid.
  check("a path that misses yields null, not zero", extractWatts(tasmota, "StatusSNS.ENERGY.Watts") === null);
  check("a non-numeric value yields null", extractWatts({ p: { power: "off" } }, "p.power") === null);
  check("a quoted number is still a number", extractWatts({ p: { power: "4.5" } }, "p.power") === 4.5);
  check("indexing a non-array yields undefined", readPath(tasmota, "StatusSNS[0]") === undefined);
  check("a real zero is a real zero", extractWatts({ p: { power: 0 } }, "p.power") === 0);

  // --- integration ------------------------------------------------------
  // A known series: 10 W held flat for 60 s, sampled every 10 s.
  //   10 W × 60 s = 600 J = 600 / 3600 Wh = 0.166… Wh
  const t0 = Date.parse("2026-09-04T12:00:00Z");
  const flat: WattSample[] = [0, 10, 20, 30, 40, 50, 60].map((s) => ({ t: t0 + s * 1000, w: 10 }));
  const a = integrateWh(flat, t0, t0 + 60_000);
  check("flat 10 W for 60 s is 600 J", !!a.wh && Math.abs(a.wh - 600 / 3600) < 1e-9, String(a.wh));
  check("coverage is the whole window", a.covered_ms === 60_000 && a.window_ms === 60_000);
  check("all seven samples counted", a.samples === 7);

  // A ramp 0 → 60 W over 60 s. The trapezoid is exact for a straight line:
  //   mean 30 W × 60 s = 1800 J = 0.5 Wh
  const ramp: WattSample[] = [0, 10, 20, 30, 40, 50, 60].map((s) => ({ t: t0 + s * 1000, w: s }));
  const b = integrateWh(ramp, t0, t0 + 60_000);
  check("a linear ramp integrates exactly", !!b.wh && Math.abs(b.wh - 0.5) < 1e-9, String(b.wh));

  // Baseline subtraction: 4 W of it was the charger standing there.
  const c = integrateWh(flat, t0, t0 + 60_000, { baselineW: 4 });
  check("the idle baseline comes off", !!c.wh && Math.abs(c.wh - 360 / 3600) < 1e-9, String(c.wh));
  check("the pre-baseline figure is kept for checking", !!c.wh_raw && Math.abs(c.wh_raw - 600 / 3600) < 1e-9);

  // A gap longer than maxGapMs is NOT bridged. Interpolating across a plug that
  // was unreachable for ten minutes invents ten minutes of draw.
  const gapped: WattSample[] = [
    { t: t0, w: 10 },
    { t: t0 + 10_000, w: 10 },
    { t: t0 + 610_000, w: 10 }, // ten minutes later
    { t: t0 + 620_000, w: 10 },
  ];
  const d = integrateWh(gapped, t0, t0 + 620_000, { maxGapMs: 60_000 });
  check("a long gap is skipped, not interpolated", d.gaps === 1);
  check("only the covered seconds are integrated", d.covered_ms === 20_000, String(d.covered_ms));
  check("the gapped total is the two covered segments", !!d.wh && Math.abs(d.wh - 200 / 3600) < 1e-9, String(d.wh));

  // Fewer than two samples is not a small number, it is no number.
  check("one sample yields null, not zero", integrateWh([{ t: t0, w: 10 }], t0, t0 + 60_000).wh === null);
  check("no samples yields null", integrateWh([], t0, t0 + 60_000).wh === null);

  // Samples outside the claim window belong to whatever ran before or after.
  const spill: WattSample[] = [
    { t: t0 - 60_000, w: 900 },
    { t: t0, w: 10 },
    { t: t0 + 60_000, w: 10 },
    { t: t0 + 600_000, w: 900 },
  ];
  const e = integrateWh(spill, t0, t0 + 60_000);
  check("samples outside the window are ignored", !!e.wh && Math.abs(e.wh - 600 / 3600) < 1e-9, String(e.wh));

  // Unsorted input must not produce negative segments.
  const shuffled = [flat[3], flat[0], flat[6], flat[1], flat[5], flat[2], flat[4]];
  const f = integrateWh(shuffled, t0, t0 + 60_000);
  check("unsorted samples sort before integrating", !!f.wh && Math.abs(f.wh - 600 / 3600) < 1e-9, String(f.wh));

  // A baseline above the observed draw goes negative rather than clamping to
  // zero: a zero would read as "used no energy", and the truth is "the
  // configured idle_watts is wrong".
  const g = integrateWh(flat, t0, t0 + 60_000, { baselineW: 20 });
  check("an over-large baseline shows as negative rather than clamping", !!g.wh && g.wh < 0);

  // --- baseline helpers -------------------------------------------------
  check("median of an even list averages the middle two", median([1, 2, 3, 4]) === 2.5);
  check("median of an odd list is the middle", median([5, 1, 3]) === 3);
  check("median of nothing is null", median([]) === null);
  check("p10 of a mostly-idle series finds the idle level", percentile([3, 3, 3, 3, 3, 40, 41, 42, 39, 38], 0.1) === 3);
  check("p10 of nothing is null", percentile([], 0.1) === null);
}

// Run standalone: `npx tsx src/power.test.ts`. pathToFileURL, not a template
// string: this repo lives under a path with a space in it, and `file://${path}`
// does not percent-encode it, so the comparison silently fails and the checks
// never run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failures = 0;
  runPowerChecks((name, cond, detail = "") => {
    if (cond) console.log(`  ok    ${name}`);
    else {
      failures++;
      console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
  });
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
