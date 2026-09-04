/**
 * Checks for the pure half of /api/evals: the family rule, the pivot, the
 * exclusion accounting, and the per-joule column.
 *
 * `npx tsx src/api/evals.test.ts`
 *
 * The case that matters most is the last one: a plant-ID-shaped row — a vision
 * batch carrying accuracy in `decode_tok_s` — must land in `excluded` with its
 * actual metric keys attached, never in a cell and never silently gone.
 *
 * Note this file imports src/api/evals.ts, which reaches src/db.ts through
 * src/power.ts, so running it opens a SQLite file in the current directory.
 * Point FLEET_DATA_DIR at a scratch directory when running it standalone; the
 * checks themselves touch no table.
 */
import { pathToFileURL } from "node:url";
import { familyOf, perJoule, pivotEvals, type EvalRow } from "./evals.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function row(over: Partial<EvalRow>): EvalRow {
  return {
    job_id: "j1",
    device_id: "pixel-8",
    device_model: "Pixel 8",
    simulator: false,
    at: "2026-09-01T10:00:00.000Z",
    input_sha256: SHA_A,
    workload: "batch",
    backend: "litert",
    model: "plantnet-r18",
    quant: "fp32",
    accel: "gpu",
    metrics: {},
    params: {},
    energy: null,
    ...over,
  };
}

export function runEvalChecks(check: (name: string, cond: boolean, detail?: string) => void) {
  // --- families ---------------------------------------------------------
  check("a litert batch is a vision eval", familyOf("batch", "litert") === "vision");
  check("a coreml batch is a vision eval", familyOf("batch", "coreml") === "vision");
  check("a llama.cpp batch is an LLM eval", familyOf("batch", "llama.cpp") === "llm");
  check("speech-eval is speech whatever the backend", familyOf("speech-eval", "whisper.cpp") === "speech");
  check("embed-eval is embed", familyOf("embed-eval", null) === "embed");

  // --- the pivot --------------------------------------------------------
  const rows: EvalRow[] = [
    row({ job_id: "j-a1", device_id: "pixel-8", metrics: { top1_pct: 71.2, p50_ms: 30 } }),
    row({ job_id: "j-a2", device_id: "iphone-12", device_model: "iPhone 12 Pro", metrics: { top1_pct: 74.9, p50_ms: 18 } }),
    row({
      job_id: "j-a3", device_id: "pixel-8", model: "houseplants-v2",
      metrics: { top1_pct: 60.0, p50_ms: 12 },
    }),
  ];
  const p = pivotEvals(rows);
  check("one input_sha256 makes one set", p.sets.length === 1, String(p.sets.length));
  const set = p.sets[0];
  check("the set is a vision eval", set.family === "vision");
  check("two models in the set", set.models.length === 2, String(set.models.length));
  check("two devices as columns", set.devices.length === 2, JSON.stringify(set.devices.map((d) => d.device_id)));
  const plantnet = set.models.find((m) => m.model === "plantnet-r18")!;
  check("the pivot puts each device in its own cell", plantnet.cells["pixel-8"].metrics.top1_pct === 71.2);
  check("and the other device in the other cell", plantnet.cells["iphone-12"].metrics.top1_pct === 74.9);
  check("a model that ran on one device has one cell", Object.keys(set.models.find((m) => m.model === "houseplants-v2")!.cells).length === 1);
  check("named metrics with no value are present and null", plantnet.cells["pixel-8"].metrics.top5_pct === null);

  // Two eval sets never merge, even for the same model on the same device:
  // different bytes are different questions.
  const twoSets = pivotEvals([
    row({ job_id: "s1", input_sha256: SHA_A, metrics: { top1_pct: 70 } }),
    row({ job_id: "s2", input_sha256: SHA_B, metrics: { top1_pct: 40 } }),
  ]);
  check("different input_sha256 stay separate sets", twoSets.sets.length === 2);

  // A re-run replaces that one cell and leaves the rest of the table alone.
  const rerun = pivotEvals([
    row({ job_id: "old", device_id: "pixel-8", at: "2026-09-01T10:00:00.000Z", metrics: { top1_pct: 71.2 } }),
    row({ job_id: "new", device_id: "pixel-8", at: "2026-09-03T10:00:00.000Z", metrics: { top1_pct: 73.5 } }),
    row({ job_id: "other", device_id: "iphone-12", at: "2026-09-01T10:00:00.000Z", metrics: { top1_pct: 74.9 } }),
  ]);
  const cells = rerun.sets[0].models[0].cells;
  check("the newest run wins its cell", cells["pixel-8"].metrics.top1_pct === 73.5 && cells["pixel-8"].job_id === "new");
  check("a re-run on one device leaves the others alone", cells["iphone-12"].metrics.top1_pct === 74.9);
  check("both runs still count toward the set's run total", rerun.sets[0].runs === 3);

  // --- exclusions -------------------------------------------------------
  // The plant-ID shape: a vision batch whose accuracy is in decode_tok_s and
  // whose latency is in ttft_ms. It has numbers, but none of them are named
  // vision metrics, so nothing can be put in a cell.
  const legacy = pivotEvals([
    row({ job_id: "planteval-legacy", metrics: { decode_tok_s: 71.2, ttft_ms: 30, prefill_tok_s: 33 } }),
  ]);
  check("a pre-schema vision row is excluded, not pivoted", legacy.sets.length === 0 && legacy.excluded.length === 1);
  check(
    "the exclusion lists the keys the row does carry",
    legacy.excluded[0].present.sort().join(",") === "decode_tok_s,prefill_tok_s,ttft_ms",
    legacy.excluded[0].present.join(","),
  );
  check("the exclusion names the fields it wanted", legacy.excluded[0].reason.includes("top1_pct"));

  // The same numbers under an LLM backend are NOT legacy — decode_tok_s is the
  // named field there. The family decides, and it comes from the spec.
  const llm = pivotEvals([
    row({ job_id: "llm-1", backend: "llama.cpp", metrics: { decode_tok_s: 22.4, ttft_ms: 310 } }),
  ]);
  check("the same metrics under an LLM backend are named, not legacy", llm.sets.length === 1 && llm.excluded.length === 0);

  // A row with no eval set is excluded for a different, stated reason.
  const noSet = pivotEvals([row({ job_id: "loose", input_sha256: null, metrics: { top1_pct: 50 } })]);
  check("a row with no input_sha256 is excluded", noSet.excluded.length === 1 && noSet.sets.length === 0);
  check("and says so specifically", noSet.excluded[0].reason.includes("input_sha256"));

  // Mixed: the set still renders, and carries its own excluded count so the
  // page can say it beside that table rather than only in a global total.
  const mixed = pivotEvals([
    row({ job_id: "good", metrics: { top1_pct: 71.2 } }),
    row({ job_id: "legacy", device_id: "iphone-12", metrics: { decode_tok_s: 68.0 } }),
  ]);
  check("a set renders alongside its excluded rows", mixed.sets.length === 1 && mixed.excluded.length === 1);
  check("the set counts its own exclusions", mixed.sets[0].excluded === 1, String(mixed.sets[0].excluded));

  // --- per joule --------------------------------------------------------
  // 1 Wh = 3600 J. 120 images on 0.05 Wh = 120 / 180 J = 0.666… img/J.
  const pj = perJoule("vision", {}, { images: 120 }, 0.05);
  check("images per joule", !!pj && Math.abs(pj.value - 120 / 180) < 1e-9, JSON.stringify(pj));
  check("and names its unit", pj?.unit === "img/J");
  const tok = perJoule("llm", {}, { gen_tokens: 128 }, 0.01);
  check("tokens per joule", !!tok && Math.abs(tok.value - 128 / 36) < 1e-9, JSON.stringify(tok));
  const clips = perJoule("speech", { clips: 50 }, {}, 0.02);
  check("clips per joule reads the metric, not the spec", !!clips && clips.unit === "clips/J");

  // Omitted cleanly, never approximated: a rate times a duration would look
  // like a measurement and would not be one.
  check("no count means no column", perJoule("vision", { images_per_s: 40 }, {}, 0.05) === null);
  check("no energy means no column", perJoule("vision", {}, { images: 120 }, null) === null);
  check("zero energy means no column, not infinity", perJoule("vision", {}, { images: 120 }, 0) === null);

  // Cells carry it only where both halves exist.
  const withEnergy = pivotEvals([
    row({
      job_id: "e1", metrics: { top1_pct: 71.2 }, params: { images: 120 },
      energy: { wh: 0.05, method: "plug", includes_charging: true, source: "integrated", baseline_source: "config", note: "" },
    }),
    row({ job_id: "e2", device_id: "iphone-12", metrics: { top1_pct: 74.9 }, params: { images: 120 } }),
  ]);
  const m = withEnergy.sets[0].models[0];
  check("a cell with energy gets a per-joule figure", m.cells["pixel-8"].per_joule !== null);
  check("a cell without energy omits it", m.cells["iphone-12"].per_joule === null);
  check("the set knows it has energy somewhere", withEnergy.sets[0].has_energy === true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failures = 0;
  runEvalChecks((name, cond, detail = "") => {
    if (cond) console.log(`  ok    ${name}`);
    else {
      failures++;
      console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
  });
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
