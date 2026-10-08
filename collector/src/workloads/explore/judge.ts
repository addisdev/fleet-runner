/**
 * The second pair of eyes: a different model that looks at screens the driver
 * reached and says whether anything is visibly wrong (O4), and at the end of a
 * mission whether the goal actually held (O5).
 *
 * Different on purpose. A model asked to grade its own run tends to agree
 * with itself, so the judge is configured separately and is, by default, the
 * resident general model on ultra (`vision` on the gateway) rather than the
 * computer-use model doing the driving.
 *
 * The judge never files anything. What it says becomes a candidate, the
 * candidate is replayed on a clean install, and the judge is asked again on
 * the replay's final screen. Only a defect it sees twice, on two runs, reaches
 * the morning list -- and each defect class keeps its own hit rate from the
 * owner's verdicts, so a class that is mostly wrong is switched off rather
 * than argued with.
 */
import type { A11yNode } from "../../a11y-tree.js";
import { shrinkForModel } from "./image.js";
import type { ModelConfig } from "./model.js";

/** The visual defect classes the judge may name. Each keeps its own precision. */
export const VISUAL_CLASSES = [
  "overlap", "clipped", "raw_error", "untranslated", "placeholder", "low_contrast", "broken_layout", "empty_state",
] as const;
export type VisualClass = (typeof VISUAL_CLASSES)[number];

export type VisualIssue = { cls: VisualClass; description: string; where: string };

const VISUAL_PROMPT = (lang: string | null, disabled: string[]) => [
  "You are reviewing one screenshot of a mobile or TV app for visible defects. Report only defects a user would notice and a developer would fix. Do not report design opinions, and do not guess about anything not visible.",
  "",
  "Classes:",
  "- overlap: text or controls drawn on top of each other",
  "- clipped: text cut off mid-word or mid-line, or a control cut off by the screen or its container (an ellipsis at the end of a long name in a list is normal, not clipped)",
  "- raw_error: an exception, stack trace, error code or developer message shown to the user (e.g. 'java.lang.', 'null', 'NaN', 'undefined', 'Error 500')",
  `- untranslated: ${lang ? `text not in ${lang}, or a raw string key like settings_title_v2` : "a raw string key like settings_title_v2 shown instead of words"}`,
  "- placeholder: placeholder copy shipped as content ('Lorem ipsum', 'TODO', 'Title here')",
  "- low_contrast: text that is very hard to read against its background",
  "- broken_layout: elements misaligned, off-screen, or overflowing in a way that is clearly unintended",
  "- empty_state: a screen or list that is empty with no message, where content or an explanation is expected",
  disabled.length ? `Do NOT report these classes, they are switched off: ${disabled.join(", ")}.` : "",
  "",
  'Answer with JSON only: {"issues":[{"class":"...","description":"what is wrong, quoting the visible text","where":"which part of the screen"}]}. An empty list is the usual, correct answer for a screen with nothing wrong.',
].filter(Boolean).join("\n");

const GOAL_PROMPT = (goal: string, success: string) => [
  "You are checking whether a tester's goal was actually achieved in a mobile or TV app.",
  `Goal: ${goal}`,
  `It counts as achieved when: ${success}`,
  "You get the final screenshot and the text visible on screen. Judge only from what is visible. If the screen cannot show it either way, answer null.",
  'Answer with JSON only: {"met": true|false|null, "reason": "one sentence quoting what you see"}',
].join("\n");

async function ask(cfg: ModelConfig, prompt: string, png: Buffer, extraText = ""): Promise<{ json: unknown; ms: number; error?: string }> {
  const shot = shrinkForModel(png, cfg.maxPixels ?? 1_000_000);
  const url = `${cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: cfg.maxTokens ?? 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: [
            ...(extraText ? [{ type: "text", text: extraText }] : []),
            { type: "image_url", image_url: { url: `data:image/png;base64,${shot.png.toString("base64")}` } },
          ] },
        ],
        ...(cfg.extraBody ?? {}),
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 180_000),
    });
    const text = await res.text();
    if (!res.ok) return { json: null, ms: Date.now() - t0, error: `judge ${res.status}: ${text.slice(0, 200)}` };
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    return { json: parseJsonLoose(content), ms: Date.now() - t0 };
  } catch (e) {
    return { json: null, ms: Date.now() - t0, error: (e as Error).message };
  }
}

/** The first JSON object in a reply, tolerating code fences and chatter around it. */
export function parseJsonLoose(s: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)?.[1];
  const body = fence ?? s;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** Shape the judge's JSON into issues, dropping anything unnamed, disabled or empty. */
export function visualIssuesFrom(json: unknown, disabled: string[] = []): VisualIssue[] {
  const list = (json as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(list)) return [];
  const out: VisualIssue[] = [];
  for (const i of list) {
    const o = i as Record<string, unknown>;
    const cls = String(o.class ?? o.cls ?? "").trim() as VisualClass;
    if (!(VISUAL_CLASSES as readonly string[]).includes(cls) || disabled.includes(cls)) continue;
    const description = String(o.description ?? "").trim();
    if (!description) continue;
    out.push({ cls, description: description.slice(0, 300), where: String(o.where ?? "").slice(0, 120) });
  }
  return out.slice(0, 5);
}

export async function judgeVisual(cfg: ModelConfig, png: Buffer, opts: { language?: string | null; disabled?: string[] } = {}) {
  const r = await ask(cfg, VISUAL_PROMPT(opts.language ?? null, opts.disabled ?? []), png);
  return { issues: visualIssuesFrom(r.json, opts.disabled), ms: r.ms, error: r.error };
}

export async function judgeGoal(cfg: ModelConfig, png: Buffer, goal: string, success: string, nodes: A11yNode[] | null) {
  const visible = (nodes ?? []).map((n) => (n.text || n.label).trim()).filter(Boolean);
  const text = visible.length ? `Text on screen: ${[...new Set(visible)].slice(0, 80).join(" | ")}` : "";
  const r = await ask(cfg, GOAL_PROMPT(goal, success), png, text);
  const o = (r.json ?? {}) as { met?: unknown; reason?: unknown };
  const met = o.met === true ? true : o.met === false ? false : null;
  return { met, reason: String(o.reason ?? "").slice(0, 300), ms: r.ms, error: r.error };
}
