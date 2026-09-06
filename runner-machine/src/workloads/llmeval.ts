/**
 * The `llm-eval` workload: score what a device generated, on a machine with
 * room to judge it.
 *
 * ## The gap this closes
 *
 * The fleet has measured LLM tok/s since it existed and has never measured
 * whether the answers survived quantisation. Vision has `top1_pct`, speech has
 * `wer_pct`, embeddings have `recall_at_k` — generation has a speed and
 * nothing else. A Q4 model that is fast and wrong is not shippable, and the
 * product question the fleet was built to answer ("is on-device good enough")
 * cannot be answered by a rate.
 *
 * ## Why it is a machine workload and not a device one
 *
 * The generation happens on the device — that is the measurement. The SCORING
 * happens here, and deliberately not there, for three reasons.
 *
 * A judge model is bigger than the model under test, by design: a 0.5B model
 * grading its own output tells you what a 0.5B model thinks. It runs on the
 * machine with the memory, reached over the endpoint a `serve` job announced.
 *
 * The device should not be trusted to mark its own homework in a more literal
 * sense too: if the phone both generates and scores, a bug in its scorer is
 * indistinguishable from a bug in its model, and the same code produced both
 * numbers.
 *
 * And the eval set is the same on every device. Scoring in one place means one
 * scorer, so a tablet's 71% and a phone's 68% differ because the models differ.
 *
 * The chain is `batch` (device, generates) → `llm-eval` (machine, scores), with
 * `depends_on` and `${jobs.<id>.artifact}` carrying the completions between
 * them. That is a shape the collector already has; this is the workload that
 * finally uses it for the question it was built for.
 *
 * ## What it reports, and what it refuses to
 *
 * `score_pct` covers only the deterministically scorable items. Judged items
 * are counted separately in `judged_items` and folded into `judge_score_pct`
 * when a judge was configured. They are never averaged together: one number is
 * reproducible by anyone with the eval set, the other depends on which model
 * was serving on the day, and a single blended figure would quietly be neither.
 *
 * A judge that cannot be reached is a failed job, not a lower score. Silently
 * dropping to the deterministic subset would report a number that looks like
 * every other run and is measuring a different thing.
 */
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics } from "../protocol.js";
import { SCHEMA, compact, stringParam } from "../protocol.js";
import { BEACON_MS } from "../beaconing.js";
import { beacon } from "../telemetry.js";
import {
  parseEvalSet, parseVerdict, scoreItem, summarise,
  type EvalItem, type Judgement,
} from "../scoring.js";
import * as JobCancellation from "../cancellation.js";

/** A judge that has not answered in this long is not going to. */
const JUDGE_TIMEOUT_MS = 120_000;

type Completions = Record<string, string>;

/**
 * Completions, from either shape a producer might have uploaded.
 *
 * An object keyed by item id is the shape this workload asks for. An array of
 * `{id, completion}` is what a runner that was iterating naturally produces,
 * and refusing it would be pedantry. An array of bare strings is REFUSED,
 * though: positional matching means an eval set edited between the generate
 * and the score silently grades every answer against the wrong prompt.
 */
export function parseCompletions(raw: unknown): Completions {
  if (Array.isArray(raw)) {
    const out: Completions = {};
    for (const [i, entry] of raw.entries()) {
      if (typeof entry === "string") {
        throw new Error(
          "completions is an array of bare strings, which can only be matched to prompts by position — " +
          "upload objects carrying `id` instead, or an object keyed by item id",
        );
      }
      const o = entry as Record<string, unknown>;
      const id = o.id ?? o.item_id;
      const text = o.completion ?? o.output ?? o.text;
      if (typeof id !== "string") throw new Error(`completion ${i} has no id`);
      if (typeof text !== "string") throw new Error(`completion ${id} has no completion text`);
      out[id] = text;
    }
    return out;
  }
  if (typeof raw === "object" && raw !== null) {
    const o = (raw as { completions?: unknown }).completions ?? raw;
    if (Array.isArray(o)) return parseCompletions(o);
    const out: Completions = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "object" && v !== null && typeof (v as { completion?: unknown }).completion === "string") {
        out[k] = (v as { completion: string }).completion;
      }
    }
    if (Object.keys(out).length > 0) return out;
  }
  throw new Error("completions must be an object keyed by item id, or an array of {id, completion}");
}

/** The prompt a judge is given. One line of verdict, then the reasoning. */
export function judgePrompt(item: EvalItem, completion: string, rubric: string): string {
  return [
    "You are grading one answer against a rubric. Reply with PASS or FAIL on the",
    "first line by itself, then one sentence of reasoning on the next line.",
    "",
    `RUBRIC: ${rubric}`,
    "",
    `QUESTION: ${item.prompt}`,
    "",
    `ANSWER: ${completion}`,
  ].join("\n");
}

/**
 * Ask a served model for a verdict.
 *
 * The endpoint is an OpenAI-compatible `/v1/chat/completions`, which is what
 * `llama-server` speaks — so the judge is a model this same fleet is serving,
 * reached at the address a `serve` job announced in its `endpoint` field.
 * Nothing here is specific to a vendor, and no key is read from anywhere: the
 * collector refuses to carry secrets in a spec, and a judge that needed one
 * would have to take it from this machine's environment, which is a different
 * decision than this workload should be making on its own.
 */
async function askJudge(endpoint: string, model: string | undefined, prompt: string): Promise<string> {
  const url = endpoint.replace(/\/+$/, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model ?? "local",
      messages: [{ role: "user", content: prompt }],
      // A verdict and a sentence. Left long enough for the sentence, short
      // enough that a runaway generation cannot stall the whole eval.
      max_tokens: 200,
      // Determinism matters more than variety here: the same answer graded
      // twice should get the same verdict, or the score is not reproducible.
      temperature: 0,
    }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`judge endpoint ${url} -> ${res.status}`);
  const body = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("judge returned no message content");
  return text;
}

export async function runLlmEval(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-llmeval-"));
  try {
    const setSha = stringParam(job.params, "eval_set_sha256");
    const completionsSha = stringParam(job.params, "completions_sha256");
    if (!setSha) throw new Error("llm-eval needs params.eval_set_sha256 (the prompts and their scoring rules)");
    if (!completionsSha) {
      throw new Error(
        "llm-eval needs params.completions_sha256 — the artifact a device produced. " +
        "In a chain this is \"${jobs.<generate-job>.artifact}\"",
      );
    }

    const setPath = path.join(dir, "eval-set.json");
    const compPath = path.join(dir, "completions.json");
    await client.fetchArtifact(setSha, setPath);
    await client.fetchArtifact(completionsSha, compPath);

    const items = parseEvalSet(JSON.parse(await readFile(setPath, "utf8")));
    const completions = parseCompletions(JSON.parse(await readFile(compPath, "utf8")));

    // A completion for a prompt that is not in the set, or a prompt with no
    // completion, is reported rather than ignored. Either one means the two
    // artifacts came from different runs, and a score computed across a
    // mismatched pair is a number about nothing.
    const missing = items.filter((i) => completions[i.id] === undefined).map((i) => i.id);
    const extra = Object.keys(completions).filter((id) => !items.some((i) => i.id === id));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} of ${items.length} prompts have no completion (${missing.slice(0, 5).join(", ")}` +
        `${missing.length > 5 ? ", …" : ""}) — the eval set and the completions are from different runs`,
      );
    }

    // --- deterministic scoring ------------------------------------------------
    const judgements: Judgement[] = [];
    const texts: string[] = [];
    for (const item of items) {
      const completion = completions[item.id];
      texts.push(completion);
      judgements.push(scoreItem(item, completion));
    }

    // --- judged items ---------------------------------------------------------
    const endpoint = stringParam(job.params, "judge_endpoint");
    const judgeModel = stringParam(job.params, "judge_model") ?? undefined;
    const needJudging = items.filter((i) => i.score.kind === "judge");
    const judged: { id: string; ok: boolean | null; why: string }[] = [];

    if (needJudging.length > 0) {
      if (!endpoint) {
        throw new Error(
          `${needJudging.length} items need a judge model but params.judge_endpoint is unset. ` +
          "Serve one with a `serve` job and pass its announced endpoint, or remove the judge items. " +
          "Scoring the rest and reporting that as the score would report a different measurement " +
          "under the same name.",
        );
      }
      // Beacon on a clock while judging.
      //
      // Each judged item is one HTTP call with a two-minute ceiling, so a set
      // with a dozen of them against a slow local model outruns the default
      // ten-minute lease -- and a lapsed lease is requeued, so a second attempt
      // starts while the first is still calling the judge. Both then post a
      // final row for the same job, the judge is billed twice, and an attempt
      // is spent on a job that was never failing.
      //
      // This is also the only way a running llm-eval hears that it was
      // cancelled. Every other long machine workload does this already: build
      // and serve post explicit beacons, model-convert and dataset-prep use
      // the Beaconer.
      let lastBeaconAt = Date.now();
      for (const item of needJudging) {
        if (Date.now() - lastBeaconAt >= BEACON_MS) {
          lastBeaconAt = Date.now();
          const renewed = await client.postBeacon({
            schema: SCHEMA, kind: "beacon", job_id: job.job_id, device_id: deviceId,
            beacon: await beacon(),
          });
          // Only an explicit false cancels; a beacon that fails to post throws
          // to the catch below rather than quietly stopping the job.
          if (!renewed) JobCancellation.cancel(job.job_id);
        }
        if (JobCancellation.isCancelled(job.job_id)) {
          await client.postResult({
            schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
            iter: 0, final: true, ok: false, device: descriptor, error: "cancelled",
          });
          return;
        }
        const rubric = (item.score as { rubric: string }).rubric;
        const text = await askJudge(endpoint, judgeModel, judgePrompt(item, completions[item.id], rubric));
        const verdict = parseVerdict(text);
        judged.push({ id: item.id, ok: verdict, why: text.trim().slice(0, 300) });
      }
    }

    const summary = summarise(judgements, texts);
    const judgeAnswered = judged.filter((j) => j.ok !== null);
    const judgePassed = judgeAnswered.filter((j) => j.ok === true).length;

    // The full per-item report goes to the artifact store, because a score with
    // no way to see which items failed is a number nobody can act on.
    const reportPath = path.join(dir, "llm-eval-report.json");
    await writeFile(reportPath, JSON.stringify({
      eval_set_sha256: setSha,
      completions_sha256: completionsSha,
      judge_endpoint: endpoint ?? null,
      judge_model: judgeModel ?? null,
      items: items.map((i) => ({
        id: i.id,
        rule: i.score.kind,
        deterministic: judgements.find((j) => j.id === i.id) ?? null,
        judged: judged.find((j) => j.id === i.id) ?? null,
        completion: completions[i.id],
      })),
      unmatched_completions: extra,
    }, null, 2));
    const report = await client.uploadArtifact(reportPath, `llm-eval-${job.job_id}.json`);

    const metrics = compact<Metrics>({
      score_pct: summary.score_pct ?? undefined,
      scored_items: summary.scored_items,
      judged_items: summary.judged_items,
      // Only when a judge actually answered. A judge that returned something
      // unparseable for every item leaves this absent rather than reporting 0.
      judge_score_pct: judgeAnswered.length === 0 ? undefined : (judgePassed / judgeAnswered.length) * 100,
      judge_model: judgeModel,
      refusal_pct: summary.refusal_pct,
    });

    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true,
      // The job succeeded if it produced a score. A low score is a result, not
      // a failure — that distinction is the difference between "the model is
      // worse than we hoped" and "the eval did not run".
      ok: true,
      device: descriptor,
      metrics,
      artifacts: [report.sha256],
    });
  } catch (e) {
    await client.postResult({
      schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
      iter: 0, final: true, ok: false, device: descriptor,
      error: (e as Error).message.slice(0, 500),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
