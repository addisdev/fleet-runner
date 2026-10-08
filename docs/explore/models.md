# Models and the gateway

The explorer talks to two models through any OpenAI-compatible
`/v1/chat/completions` endpoint:

- the **driver** sees each screenshot and answers with tool calls;
- the **judge** looks at screens the driver reached and answers in JSON.

They are different models on purpose: a model asked to grade its own run tends
to agree with itself.

## What a driver needs

- **Images in.** Screenshots go as base64 PNG `image_url` parts.
- **Tool calls out.** Native `tool_calls` are best. Calls written into the text
  as `<tool_call>{...}</tool_call>`, or as a bare JSON object with `name` and
  `arguments`, are accepted too, so a model is not marked down for where its
  chat template puts them.
- **About 16k tokens of context** by the middle of a mission, more with
  `keep_shots` raised.

## The tool dialect

The tools are **Holo4's own**. H Company published every trajectory behind the
Holo4 scores (the `Hcompany/trajectories` dataset, Apache-2.0), and its Android
runs show the exact calls and argument shapes. A model does best in the dialect
it was trained on, so that is what every model is offered, which keeps a
bake-off about the models rather than about which one got its native format.

Coordinates are on a **0–1000 grid on both axes**, whatever the screen's size.

| Tool | Arguments | Becomes |
|---|---|---|
| `mobile_click` | `element, x, y` | A tap |
| `mobile_long_press` | `element, x, y, duration?` | A long press |
| `mobile_write` | `element, text, x, y, overwrite?, enter?` | Tap the field, type; `overwrite` clears first; `enter` defaults to true |
| `mobile_scroll` | `direction, factor?` | A scroll; `factor` is the share of a screen (default 0.5) |
| `mobile_swipe` | `x_touch, y_touch, x_lift, y_lift` | A swipe |
| `mobile_drag` | the same, plus `element, duration?` | A slow swipe |
| `mobile_go_back` | | The back key (Android only) |
| `mobile_go_home` | | Home; the harness brings the app back |
| `mobile_hide_keyboard` | | Back if a keyboard is up, nothing otherwise |
| `wait` | `seconds` | Up to 10 s |
| `note` · `update_plan` | | Kept in the conversation, nothing done |
| `report_issue` | `kind, description, element?` | A candidate from the agent itself; see [below](#report_issue) |
| `answer` | `content` | Ends the mission |

On a **TV** the touch tools are replaced by:

| Tool | Arguments | |
|---|---|---|
| `tv_press` | `key, times?` | A remote key, up to 10 times in a row. Keys depend on the device |
| `tv_type` | `text` | Into the focused field |

Holo4's mobile tools have no remote-control key, and TV research found
click-trained models collapse on focus navigation. TVWorld (2026) measured
UI-TARS-1.5 at 1.6% and Qwen3-VL-32B at 39%. So on a TV the model is also
given **the focus as a line of text** ("Home > Calm row > 'Rain on the porch'
(focused)") and told to trust it over the picture.

### `report_issue`

The agent may report something that looks broken. That is a lead, never a
finding. A visual report is replayed and must be named again by the **judge**;
a dead-control report must reproduce as one; a "wrong result" report has no
success line to re-check, so it never reproduces on its own. Without a judge,
an agent's visual report cannot be filed.

## The conversation

The system prompt follows the shape of the prompt in Holo4's published Android
runs (the same tool semantics, the same grid, the same "one call fills the
field" rule) but is rewritten for testing rather than finishing a task. The
first user message is the card: title, persona, goal, plus a line for the
condition and one for today's changed screens.

Each step adds the tool results for the previous calls, then a user message
with the screenshot and a few lines from the harness. The harness lines say:

- the step count;
- whether the screen is new to any night, new to this run, or seen before;
- after ten steps without a new screen, the screens the map knows and this run
  has not reached;
- notices in `<harness>` tags, which the prompt says are the only text with
  authority: the app was restarted, the device left the app, two steps remain.

### Screenshots and the prefix cache

Each screenshot is a thousand or more tokens. Three are kept (`keep_shots`);
older ones are replaced by the text `[earlier screenshot omitted]`, which
keeps the turn structure the model was trained on.

They are trimmed **in batches**, once four more have piled up (`trimEvery`).
Replacing a screenshot changes the conversation's prefix, and a server's
prefix cache can only reuse what comes before the first change. Trimming one
per step therefore invalidated the cache on every step. On the first real run,
cached tokens fell from 3,600 to 1,500 once trimming began. In batches, a
14-step mission kept 7,996 of 9,072 prompt tokens cached.

Turns past `keep_turns` (40) are dropped whole, oldest first, never separating
a call from its answer.

### Image size

Screenshots over `max_pixels` (1,000,000) are shrunk with a box filter before
sending. A phone screenshot is 2.6 megapixels; Holo4's published Android runs
used 576×1280 (0.74 MP). Coordinates are unaffected, because the grid is
0–1000 at any size. Some servers resize images on their own, which makes this
setting moot; `scripts/explore-bench/image-size.ts` tells you which kind
yours is.

## The judge

Two prompts, both asking for JSON only.

**Visual**, once per screen new to the run, and again on each replay of a
visual candidate. It may name only these classes:

| Class | |
|---|---|
| `overlap` | Text or controls drawn on top of each other |
| `clipped` | Text cut off mid-word, or a control cut off by its container. An ellipsis on a long name in a list is normal |
| `raw_error` | An exception, stack trace, error code or developer message shown to the user |
| `untranslated` | Text not in the expected language, or a raw string key |
| `placeholder` | "Lorem ipsum", "TODO", "Title here" |
| `low_contrast` | Text very hard to read |
| `broken_layout` | Misaligned, off-screen or overflowing elements |
| `empty_state` | An empty screen or list with no explanation |

Anything else it says is dropped, at most five issues per screen are kept, and
classes [switched off by your verdicts](findings.md#precision-and-switching-checks-off)
are not even mentioned to it.

**Goal**, once at the end of an exploration card with a `success` line: the
final screenshot and the visible text, and `{"met": true|false|null}`.

## The gateway on ultra

Products call names, not models. Two names matter here:

| Name | Is | Fallback |
|---|---|---|
| `pilot` | Holo4 35B-A3B (Apache-2.0), 4-bit | **None.** A busy Studio delays QA; it must not send a night of app screenshots to a third party |
| `vision` | The resident Qwen3.8-27B | As the gateway decides |

The entries are in `collector/deploy/explore/litellm-pilot.yaml`. Holo4 can
be served by LM Studio from a community MLX build, or by `llama-server` from
the vendor's GGUF. The vendor's docs say llama.cpp on Apple silicon lacks
prefix caching for this architecture, so [measure both](measuring.md#step-time-b2)
and keep the faster behind `pilot`. The 27B Holo4 is CC BY-NC, and testing
paid apps is commercial use, so it is not used.

## Stand-ins

On a laptop that cannot hold Holo4, these were used:

| Model | Size (Q4 + projector) | Licence | Notes |
|---|---|---|---|
| Qwen3.5-2B | 1.3 GB + 0.7 GB | Apache-2.0 | Drove every real-device run so far. Needs `tree_hints` |
| Holo2-4B | 2.7 GB + 0.5 GB | Apache-2.0 | H Company's earlier GUI model; a reasoning model, so slow |
| GUI-Owl-1.5-2B | 1.1 GB + 0.4 GB | MIT | A GUI-specialised small model |

Serve them with `llama-server --jinja`. Their scores say nothing about Holo4.
