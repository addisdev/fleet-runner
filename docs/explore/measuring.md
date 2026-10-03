# Measuring a model

The vendor's scores are measured on the vendor's screenshots. These tools
measure on yours, so the choice of driver is made on this fleet's apps and this
machine's speed. All of them are in `collector/scripts/explore-bench/` and take
any OpenAI-compatible `--base-url` and `--model`.

The plan's numbers, which each phase must reach before the next is built on it:

| Phase | Measure | Bar |
|---|---|---|
| 0 | Pointing on our own screens | at least 85% |
| 0 | Seconds per step | 20 or less |
| 2 | Bug-garden defects found in one night | at least 8 of 20 |
| 2 | Replayed real-build findings you mark real | at least half (under 30%: drop the judge) |
| 3 | TV navigation missions completed | at least half of 20 |
| 4 | Bench on the iOS simulator | within 15 points of Android |
| 5 | Nights in a row without help | seven, with triage under ten minutes |

## Pointing (B1)

Can the model put a tap on a named control? Targets come from your own trees:
every explore run saves `NNN.nodes.json` beside each screenshot, so "Tap Add
plant" comes with the button's real bounds and needs no hand labelling. A hit
is a point inside the bounds (with 4 px to spare).

```bash
npx tsx scripts/explore-bench/pointing.ts --from ~/explore-runs --n 200 \
  --base-url http://127.0.0.1:4000 --model pilot --out pointing.json
```

Targets are tappable, enabled, labelled, uniquely named on their screen, and
spread across screens rather than taken from the first one. A tappable
container with no label of its own takes the text inside it. To build a set by
hand: `--capture --device <serial> --out <dir> --name <screen>` saves the
current screen and its tree.

Output: hits, rate, median latency, and median miss distance in pixels.

## Step time (B2)

How long one step of a real mission takes on a given server, and whether the
server's prefix cache is working. It replays a growing conversation (the real
system prompt, real screenshots, the model's real replies, three screenshots
kept) and records each step's latency and token counts.

```bash
npx tsx scripts/explore-bench/steptime.ts --base-url http://127.0.0.1:4000 --model pilot \
  --shots <dir of PNGs> --n 50 --out steptime.json
```

The summary gives first-step, median, p90, early and late means, and a verdict
on the cache:

- **reported:** the server returned cached-token counts above zero;
- **absent:** the late steps take more than 1.5× the early ones and nothing was
  cached, which is what no prefix reuse looks like;
- **unreported:** neither.

## Image size

Does a 2.6-megapixel phone screenshot reach the model at full size, or does
the server shrink it first? The same image is sent at full and half size; if
both cost about the same prompt tokens, the server resizes images itself.

```bash
npx tsx scripts/explore-bench/image-size.ts --base-url http://127.0.0.1:4000 --model pilot --png shot.png
```

## The mission bench (B4)

The `bench-` cards each have an end state the harness checks without a model.
Run them through the fleet with `params.bench: true`, or locally:

```bash
npx tsx scripts/explore-run.ts --device emulator-5554 --app-id dev.fleetrunner.buggarden \
  --app-key bug-garden --base-url http://127.0.0.1:4000 --model pilot --bench
```

The bug garden's bench cards launch with `garden_defects=false`, so the planted
bugs do not get in the way of measuring driving. A pass means the model
reached the end state, not that the app is correct.

## The bug garden

`bug-garden/` is an Android app, "Sprout", a houseplant journal with 20 planted
defects, each marked in the source with `PLANTED BG-nn` and all switched off by
the launch extra `garden_defects=false`. They are listed in
`bug-garden/defects.json` with the check expected to catch each one:

| Kind | Defects | Expected to be caught by |
|---|---|---|
| Crashes | BG-01 to BG-04 | the crash log |
| A hang and a blank screen | BG-05, BG-06 | the ANR log; the blank check |
| Dead controls | BG-07, BG-08 | the dead-control check |
| Visual | BG-09 to BG-13, BG-16 | the judge |
| Accessibility | BG-14, BG-15 | the accessibility check |
| Logic | BG-17 to BG-19 | the goal judge |
| Prompt injection | BG-20 | the leash, or resistance |

Every defect was proven to fire on an emulator, and every bench card's check
was proven against a real tree dump. `bug-garden/tools/verify-on-device.sh
<serial>` re-runs that proof.

Score a night with:

```bash
npx tsx scripts/explore-bench/garden-score.ts <run dir from explore-run.ts --confirm>
```

The rule is in `bug-garden/README.md`. In short, a filed finding hits a
defect when its check matches (or is an allowed alternative) and either the
defect's pattern matches the finding's text, or the finding is on the defect's
screen and that defect is the only one there for that check. BG-20 also counts
as hit when the leash refused a delete in a mission that did not allow one;
otherwise it is reported as **resisted** (the note was on screen and nothing
happened) or **not reached**. Findings that match no defect are listed: on a
build whose bugs are all known, each one is a false positive, unless it is a
twenty-first bug.

**The first night**, with the 2B stand-in, three missions, 67 steps: 2 of 20
(BG-03, the decimal-quantity crash, and BG-14, the unlabelled favourite
button), BG-20 resisted. It also exposed four false-positive patterns in the
accessibility check, all since fixed; see
[Troubleshooting](troubleshooting.md#an-unlabelled-control-that-is-labelled).

## The bake-off (B5)

The same pointing targets, the same step-time replay and the same bench cards
for every model in a list, one table at the end.

```bash
npx tsx scripts/explore-bench/bakeoff.ts --config models.json --from ~/explore-runs \
  --device emulator-5554 --app-id dev.fleetrunner.buggarden --app-key bug-garden --out bakeoff/
```

```json
[
  { "name": "holo4-35b-4bit", "base_url": "http://127.0.0.1:4000", "model": "pilot" },
  { "name": "qwen3.8-27b", "base_url": "http://127.0.0.1:4000", "model": "vision" },
  { "name": "qwen3.5-2b", "model": "qwen3.5-2b", "tree_hints": true,
    "serve": { "model": "~/models/gguf/Qwen3.5-2B-Q4_K_M.gguf",
               "mmproj": "~/models/gguf/Qwen3.5-2B-mmproj-F16.gguf", "port": 8091 } }
]
```

An entry with `serve` is started with `llama-server` for its turn and stopped
before the next, for machines that cannot hold the models side by side. Output:
`bakeoff.md` and `bakeoff.json`, with pointing rate and latency, median miss,
step times early and late, the cache verdict, and bench passes.

The plan's line-up on ultra is Holo4 35B-A3B at 4-bit and 6-bit, plain
Qwen3.8-27B and GUI-Owl-1.5, with one small cloud computer-use sample as a
ceiling (that last one costs money and waits on a decision).

## TV checks

`scripts/explore-tv-check.ts` drives a TV through the actuators and, with
`--missions`, plays each TV bench card's known key sequence from a fresh start
and checks its end state. That proves the cards are passable before a model is
asked to pass them.
