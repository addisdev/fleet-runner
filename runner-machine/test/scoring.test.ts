/**
 * The scorer, checked without a model.
 *
 * Every case here is a way a score could quietly be wrong rather than
 * obviously broken — which is the only failure mode that matters for a number
 * whose whole job is being compared against the same number from other
 * hardware and other quantisations. A scorer that is 5% too generous does not
 * fail; it just stops showing the degradation somebody is looking for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalise, extractJson, scoreItem, summarise, looksLikeRefusal, parseEvalSet, parseVerdict,
  type EvalItem,
} from "../src/scoring.js";
import { parseCompletions, judgePrompt } from "../src/workloads/llmeval.js";

const item = (score: EvalItem["score"], id = "i1"): EvalItem => ({ id, prompt: "p", score });

// --- normalisation is narrow on purpose -------------------------------------

test("normalisation is case and outer whitespace, and nothing else", () => {
  assert.equal(normalise("  Yes  "), "yes");
  // Punctuation is NOT stripped. Every extra normalisation makes a score look
  // better and mean less; "yes." is a different answer from "yes" and the eval
  // set should say which it wants.
  assert.notEqual(normalise("yes."), normalise("yes"));
  // Inner whitespace is preserved for the same reason.
  assert.notEqual(normalise("a  b"), normalise("a b"));
});

// --- exact / contains / regex ------------------------------------------------

test("exact ignores case and surrounding space", () => {
  assert.equal(scoreItem(item({ kind: "exact", expect: "Paris" }), "  paris ").ok, true);
  assert.equal(scoreItem(item({ kind: "exact", expect: "Paris" }), "Paris, France").ok, false);
});

test("contains needs every substring, not any of them", () => {
  const rule = item({ kind: "contains", expect: ["refund", "30 days"] });
  assert.equal(scoreItem(rule, "You may request a refund within 30 days.").ok, true);
  assert.equal(scoreItem(rule, "You may request a refund.").ok, false);
});

test("a regex the eval set got wrong is not the model's failure", () => {
  // ok: null, not false. Scoring an unusable pattern as a miss blames the model
  // for somebody's typo and silently lowers the score of a good run.
  const bad = scoreItem(item({ kind: "regex", pattern: "([unclosed" }), "anything");
  assert.equal(bad.ok, null);
  assert.match(bad.why, /unusable pattern/);
});

test("regex matches against the raw completion, not the normalised one", () => {
  // Case-sensitivity has to be the pattern's decision, or an eval set cannot
  // ask for an uppercase code.
  assert.equal(scoreItem(item({ kind: "regex", pattern: "^ORD-\\d{4}$" }), "ORD-1234").ok, true);
  assert.equal(scoreItem(item({ kind: "regex", pattern: "^ORD-\\d{4}$" }), "ord-1234").ok, false);
});

// --- json: the rule that exists because models wrap things -------------------

test("JSON inside a code fence still counts as JSON", () => {
  const completion = 'Sure! Here you go:\n```json\n{"city":"Paris","ok":true}\n```\nHope that helps.';
  assert.deepEqual(extractJson(completion), { city: "Paris", ok: true });
});

test("JSON surrounded by prose is found", () => {
  assert.deepEqual(extractJson('The answer is {"n": 3} as requested.'), { n: 3 });
});

test("a brace inside a string does not end the object", () => {
  assert.deepEqual(extractJson('{"text": "a } brace", "n": 1}'), { text: "a } brace", n: 1 });
});

test("invalid JSON is not repaired", () => {
  // A model that emits a trailing comma has failed the item. A scorer that
  // fixes it is measuring the fixer.
  assert.equal(extractJson('{"a": 1,}'), null);
  assert.equal(scoreItem(item({ kind: "json" }), '{"a": 1,}').ok, false);
});

test("required keys are checked, and an array has none", () => {
  const rule = item({ kind: "json", require_keys: ["city", "country"] });
  assert.equal(scoreItem(rule, '{"city":"Paris","country":"FR"}').ok, true);
  const missing = scoreItem(rule, '{"city":"Paris"}');
  assert.equal(missing.ok, false);
  assert.match(missing.why, /country/);
  // Valid JSON, no keys: a list cannot satisfy a key requirement, and saying
  // "parsed as JSON" here would pass an item that did not answer the question.
  assert.equal(scoreItem(rule, "[1,2,3]").ok, false);
});

// --- judged items are never folded into the deterministic score --------------

test("a judged item is not scored here", () => {
  const j = scoreItem(item({ kind: "judge", rubric: "is it polite" }), "anything");
  assert.equal(j.ok, null);
});

test("judged items are excluded from score_pct, not counted as failures", () => {
  const judgements = [
    { id: "a", ok: true, why: "" },
    { id: "b", ok: false, why: "" },
    { id: "c", ok: null, why: "needs a judge" },
    { id: "d", ok: null, why: "needs a judge" },
  ];
  const s = summarise(judgements, ["x", "y", "z", "w"]);
  // 1 of 2 deterministic, not 1 of 4.
  assert.equal(s.score_pct, 50);
  assert.equal(s.scored_items, 2);
  assert.equal(s.judged_items, 2);
  assert.equal(s.items, 4);
});

test("a set with nothing deterministic reports no score rather than zero", () => {
  const s = summarise([{ id: "a", ok: null, why: "" }], ["x"]);
  // 0% would read as a model that got everything wrong.
  assert.equal(s.score_pct, null);
});

// --- refusals ----------------------------------------------------------------

test("a refusal is detected at the start of an answer", () => {
  assert.equal(looksLikeRefusal("I cannot help with that."), true);
  assert.equal(looksLikeRefusal("As an AI language model, I..."), true);
  assert.equal(looksLikeRefusal("Paris is the capital of France."), false);
});

test("a refusal is not counted as a wrong answer", () => {
  // The two numbers are independent on purpose: a model that refuses and a
  // model that answers wrongly need different fixes.
  const s = summarise([{ id: "a", ok: false, why: "" }], ["I cannot help with that."]);
  assert.equal(s.score_pct, 0);
  assert.equal(s.refusal_pct, 100);
});

// --- loading an eval set -----------------------------------------------------

test("an eval set is refused rather than silently partly scored", () => {
  assert.throws(() => parseEvalSet([{ prompt: "p", score: { kind: "exact", expect: "x" } }]), /no id/);
  assert.throws(() => parseEvalSet([{ id: "a", score: { kind: "exact", expect: "x" } }]), /no prompt/);
  // An unknown rule dropped silently would raise the average of every item
  // around it, which is the worst possible way for this to go wrong.
  assert.throws(() => parseEvalSet([{ id: "a", prompt: "p", score: { kind: "vibes" } }]), /unknown score.kind/);
  assert.throws(() => parseEvalSet([{ id: "a", prompt: "p", score: { kind: "judge" } }]), /rubric/);
  assert.throws(() => parseEvalSet([{ id: "a", prompt: "p", score: { kind: "exact" } }]), /expect/);
});

test("an eval set may be a bare array or an object with items", () => {
  const one = [{ id: "a", prompt: "p", score: { kind: "exact", expect: "x" } }];
  assert.equal(parseEvalSet(one).length, 1);
  assert.equal(parseEvalSet({ items: one }).length, 1);
});

// --- completions -------------------------------------------------------------

test("completions keyed by id, or objects carrying one, are accepted", () => {
  assert.deepEqual(parseCompletions({ a: "one", b: "two" }), { a: "one", b: "two" });
  assert.deepEqual(parseCompletions([{ id: "a", completion: "one" }]), { a: "one" });
  assert.deepEqual(parseCompletions({ completions: [{ id: "a", output: "one" }] }), { a: "one" });
});

test("a bare array of strings is refused, because position is not identity", () => {
  // This is the failure worth refusing: an eval set edited between generating
  // and scoring would grade every answer against the wrong prompt, and every
  // number would look entirely normal.
  assert.throws(() => parseCompletions(["one", "two"]), /by position/);
});

// --- the judge ---------------------------------------------------------------

test("a verdict is read from the first line only", () => {
  assert.equal(parseVerdict("PASS\nIt answered the question."), true);
  assert.equal(parseVerdict("FAIL\nIt invented a policy."), false);
  assert.equal(parseVerdict("  pass  \nreason"), true);
});

test("a judge that did not answer in the shape asked for is null, not a guess", () => {
  // "The judge rambled" and "the answer was wrong" are different outcomes, and
  // inferring one from a paragraph is how a judged score stops being
  // reproducible.
  assert.equal(parseVerdict("Well, it depends on how you look at it."), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("I would say this passes."), null);
});

test("the judge prompt carries the rubric, the question and the answer", () => {
  const p = judgePrompt(item({ kind: "judge", rubric: "must cite the policy" }), "we refund in 30 days", "must cite the policy");
  assert.match(p, /RUBRIC: must cite the policy/);
  assert.match(p, /QUESTION: p/);
  assert.match(p, /ANSWER: we refund in 30 days/);
  assert.match(p, /PASS or FAIL on the/);
});
