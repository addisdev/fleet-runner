/**
 * How a completion is judged. Pure, so every rule can be checked without a
 * model, a network, or a phone.
 *
 * The fleet has measured tok/s for LLMs since it existed and has never measured
 * whether the answers survived quantisation. That gap is the whole reason this
 * file exists: a Q4 model that is fast and wrong is not shippable, and "77% of
 * a vision model's top-1" has no equivalent for generation. So an eval set is a
 * list of prompts, each carrying how to score the answer, and the scoring is
 * declared per item rather than being one global rule — because "return valid
 * JSON" and "does this reply sound like our support voice" are not the same
 * question and cannot share a scorer.
 *
 * ## The four rules, and why exactly these
 *
 * `exact`     the completion, normalised, equals the expected string. For
 *             classification and extraction, where there is one right answer.
 * `contains`  every expected substring appears. For "mention the refund policy"
 *             — a weaker claim than exact, made deliberately weaker.
 * `regex`     the completion matches a pattern. For shapes: an ISO date, an
 *             order id, a bare number.
 * `json`      the completion parses as JSON, and — when the item says so —
 *             carries the required keys. Structured output is the single most
 *             common on-device use, and it fails in a way the other three
 *             cannot see: a model that emits prose around valid JSON has not
 *             returned JSON.
 *
 * Anything else is `judge`, which is not scored here at all: it needs a model,
 * so it is scored in the workload against a served endpoint and is counted
 * separately in the result. Mixing a judged score into a deterministic one
 * would produce a single number that cannot be reproduced.
 *
 * ## Normalisation is narrow on purpose
 *
 * Case and surrounding whitespace only. Not punctuation, not articles, not
 * stemming. Every additional normalisation makes a score look better while
 * making it mean less, and the point of this number is to be compared against
 * the same eval set run on other hardware and other quantisations — where a
 * generous scorer hides exactly the degradation being looked for.
 */

export type ScoreRule =
  | { kind: "exact"; expect: string }
  | { kind: "contains"; expect: string[] }
  | { kind: "regex"; pattern: string; flags?: string }
  | { kind: "json"; require_keys?: string[] }
  | { kind: "judge"; rubric: string };

export type EvalItem = {
  id: string;
  prompt: string;
  score: ScoreRule;
};

export type Judgement = {
  id: string;
  /** null for a `judge` item, which this module does not score. */
  ok: boolean | null;
  /** Why, in a few words, for the report artifact. Never for the metric. */
  why: string;
};

/** Case and outer whitespace. Nothing else — see the header. */
export function normalise(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The JSON a model actually emitted, or null.
 *
 * Models wrap JSON in prose and in code fences with great enthusiasm, and a
 * scorer that only tried `JSON.parse(completion)` would score a correct answer
 * as a failure because it arrived inside ```json. So a fenced block is
 * unwrapped, and failing that the first balanced {...} or [...] is tried.
 *
 * What is NOT done is repairing the JSON — no trailing-comma fixes, no quote
 * normalisation. A model that emits invalid JSON has failed the item, and a
 * scorer that repairs it is measuring the repairer.
 */
export function extractJson(completion: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(completion);
  const candidates = [
    fenced?.[1],
    completion,
    firstBalanced(completion, "{", "}"),
    firstBalanced(completion, "[", "]"),
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || c.trim() === "") continue;
    try {
      return JSON.parse(c.trim());
    } catch { /* try the next shape */ }
  }
  return null;
}

/** The first balanced bracketed span, ignoring brackets inside strings. */
function firstBalanced(s: string, open: string, close: string): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Judge one completion against its rule.
 *
 * A `judge` item returns `ok: null` rather than false: "we did not score this"
 * and "this was wrong" are different facts, and folding them together would let
 * a run with no judge configured report a low score rather than a partial one.
 */
export function scoreItem(item: EvalItem, completion: string): Judgement {
  const rule = item.score;
  switch (rule.kind) {
    case "exact": {
      const ok = normalise(completion) === normalise(rule.expect);
      return { id: item.id, ok, why: ok ? "exact match" : `expected ${JSON.stringify(rule.expect)}` };
    }
    case "contains": {
      const hay = normalise(completion);
      const missing = rule.expect.filter((e) => !hay.includes(normalise(e)));
      return {
        id: item.id,
        ok: missing.length === 0,
        why: missing.length === 0 ? "all substrings present" : `missing ${JSON.stringify(missing)}`,
      };
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, rule.flags);
      } catch (e) {
        // A bad pattern is the eval set's bug, not the model's. Scoring it as
        // a failure would blame the model for somebody's typo.
        return { id: item.id, ok: null, why: `unusable pattern: ${(e as Error).message}` };
      }
      const ok = re.test(completion);
      return { id: item.id, ok, why: ok ? "matched" : `did not match /${rule.pattern}/` };
    }
    case "json": {
      const parsed = extractJson(completion);
      if (parsed === null) return { id: item.id, ok: false, why: "no parseable JSON in the completion" };
      const keys = rule.require_keys ?? [];
      if (keys.length === 0) return { id: item.id, ok: true, why: "parsed as JSON" };
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { id: item.id, ok: false, why: "JSON parsed but is not an object, so it has no keys" };
      }
      const missing = keys.filter((k) => !(k in (parsed as Record<string, unknown>)));
      return {
        id: item.id,
        ok: missing.length === 0,
        why: missing.length === 0 ? "parsed with every required key" : `missing keys ${JSON.stringify(missing)}`,
      };
    }
    case "judge":
      return { id: item.id, ok: null, why: "needs a judge model" };
  }
}

/**
 * A refusal, as far as this can be detected without a model.
 *
 * Counted separately from correctness because it is a different failure and
 * has a different fix. A small quantised model that has started refusing
 * benign prompts is a quantisation problem; one that answers confidently and
 * wrongly is a capability problem, and a single accuracy number cannot tell
 * them apart.
 *
 * Deliberately a narrow list of openings rather than a classifier. It will
 * miss creative refusals, and it says so in the metric's description — a
 * `refusal_pct` is a floor, not a measurement.
 */
const REFUSALS = [
  "i cannot", "i can't", "i won't", "i am unable", "i'm unable",
  "as an ai", "i do not have the ability", "i don't have the ability",
  "sorry, but i", "i apologize, but i", "i apologise, but i",
];

export function looksLikeRefusal(completion: string): boolean {
  const head = normalise(completion).slice(0, 160);
  return REFUSALS.some((r) => head.startsWith(r) || head.includes(`. ${r}`));
}

export type ScoreSummary = {
  /** Items with a deterministic rule that passed, over items with one. */
  score_pct: number | null;
  scored_items: number;
  /** Items whose rule was `judge` — not included in score_pct. */
  judged_items: number;
  refusal_pct: number;
  items: number;
};

/**
 * Fold judgements into the numbers that go on the result row.
 *
 * `score_pct` is null rather than 0 when nothing was deterministically
 * scorable. A set that is entirely `judge` items has no deterministic score,
 * and reporting 0% would read as a model that got everything wrong.
 */
export function summarise(
  judgements: Judgement[],
  completions: string[],
): ScoreSummary {
  const deterministic = judgements.filter((j) => j.ok !== null);
  const judged = judgements.length - deterministic.length;
  const passed = deterministic.filter((j) => j.ok === true).length;
  const refusals = completions.filter(looksLikeRefusal).length;
  return {
    score_pct: deterministic.length === 0 ? null : (passed / deterministic.length) * 100,
    scored_items: deterministic.length,
    judged_items: judged,
    refusal_pct: completions.length === 0 ? 0 : (refusals / completions.length) * 100,
    items: judgements.length,
  };
}

/**
 * Parse an eval set, refusing anything that would silently score wrong.
 *
 * A prompt with no id cannot be matched to its completion; a rule this build
 * does not know would be silently skipped and quietly raise the average of
 * everything else. Both are refused at load, where somebody can fix them.
 */
export function parseEvalSet(raw: unknown): EvalItem[] {
  const items = Array.isArray(raw) ? raw : (raw as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) throw new Error("eval set must be an array, or an object with an `items` array");
  return items.map((entry, i) => {
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id !== "" ? o.id : null;
    if (id === null) throw new Error(`item ${i} has no id; ids are how completions are matched to prompts`);
    if (typeof o.prompt !== "string" || o.prompt === "") throw new Error(`item ${id} has no prompt`);
    const score = o.score as Record<string, unknown> | undefined;
    const kind = score?.kind;
    if (typeof kind !== "string") throw new Error(`item ${id} has no score.kind`);
    switch (kind) {
      case "exact":
        if (typeof score!.expect !== "string") throw new Error(`item ${id}: exact needs a string \`expect\``);
        break;
      case "contains":
        if (!Array.isArray(score!.expect) || score!.expect.some((e) => typeof e !== "string"))
          throw new Error(`item ${id}: contains needs an array of strings in \`expect\``);
        break;
      case "regex":
        if (typeof score!.pattern !== "string") throw new Error(`item ${id}: regex needs a \`pattern\``);
        break;
      case "json":
        if (score!.require_keys !== undefined &&
            (!Array.isArray(score!.require_keys) || score!.require_keys.some((k) => typeof k !== "string")))
          throw new Error(`item ${id}: json's require_keys must be an array of strings`);
        break;
      case "judge":
        if (typeof score!.rubric !== "string" || score!.rubric === "")
          throw new Error(`item ${id}: judge needs a \`rubric\` saying what a good answer is`);
        break;
      default:
        // Refused rather than skipped: an unknown rule silently dropped would
        // raise the average of every item around it.
        throw new Error(`item ${id}: unknown score.kind ${JSON.stringify(kind)}`);
    }
    return { id, prompt: o.prompt as string, score: score as unknown as ScoreRule };
  });
}

/**
 * The verdict text a judge model returned, reduced to a boolean.
 *
 * The prompt asks for a bare PASS or FAIL on the first line, and this reads
 * exactly that. Anything else is `null` — "the judge did not answer in the
 * shape we asked for" is a real outcome, and guessing from the vibe of a
 * paragraph is how a judged score stops being reproducible.
 */
export function parseVerdict(text: string): boolean | null {
  const first = text.trim().split("\n")[0].trim().toUpperCase();
  if (/^PASS\b/.test(first)) return true;
  if (/^FAIL\b/.test(first)) return false;
  return null;
}
