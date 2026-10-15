# Troubleshooting

Most of this was found the hard way, on the first real runs.

## The model sees nothing

**"returns blank screenshots while its UI tree has text"** at step one. The
device cannot capture its screen. Android ATD images (`aosp_atd`, like the
fleet's `fleet-atd-1`) do exactly this: `screencap` returns a blank frame even
with software rendering. Use a `google_apis` image; see the
[quickstart](quickstart.md#2-an-emulator-that-can-take-screenshots).

## Every step is slow, and slower as the mission goes on

Look at `explore_cached_tokens_mean` against `explore_prompt_tokens_mean`, or
run [step time](measuring.md#step-time-b2). If almost nothing is cached, the
server is processing the whole conversation on every step.

- Check that the server has prefix caching for this model at all. The vendor's
  docs say llama.cpp on Apple silicon lacks it for Holo4's architecture; try
  LM Studio's MLX build.
- Keep `-np 1` (or the server's equivalent): several parallel slots can each
  hold a different prefix and evict each other.
- Do not set `keep_shots` very low. Trimming is batched so the prefix stays
  stable between trims; with one kept screenshot it changes every step anyway.

## The model answers in prose, or every step is "the reply had no tool call"

The server is not doing tool calls. For llama.cpp, start it with `--jinja`.
Calls written into the text as `<tool_call>…</tool_call>` or as a JSON object
are accepted, so if those are absent too, the model is not following the tool
format at all. Small models do better with `tree_hints: true`.

## An unlabelled control that is labelled

Four causes, all found on the first bug-garden night and all fixed:

- **Compose puts labels on children.** A list row's text and an icon button's
  `contentDescription` live on child nodes of the clickable one. The
  accessibility checker now counts anything inside a control as its label.
  This also fixed the `a11y-audit` workload, which had the same blind spot.
- **A tree read mid-animation** lacks text that is about to appear.
  Accessibility is now judged only once a screen has settled (the same screen
  on two consecutive looks), and the replay waits two seconds before reading.
- **A row cut off by the screen's edge** has no text in the tree yet. Controls
  not wholly on screen are skipped.
- **A deterministic check reproduces deterministically.** Replay does not catch
  a check that is simply wrong. Your verdicts do: a class under 30% is
  switched off.

## The wrong app is reported in front

`dumpsys window` prints a snapshot from the last ANR before the current state,
and reading the first match reported an app that was long gone. The parser now
skips that snapshot. If an Android build misreports again, compare
`adb shell dumpsys window | grep -E 'mFocusedApp|mCurrentFocus'` with the screen.

## On a TV, the explorer keeps losing what it opened

Some TV apps hide their overlay a few seconds after the last key (Dozehound's
channel bar hides after six). A look that takes longer than that loses it. The
Android actuator takes the screenshot and the tree at the same time for this
reason. On a heavily loaded host, a look can still take several seconds, and
model time adds to it; a card's goal should not depend on an overlay staying
up between steps.

## A mission is skipped: "its setup flow needs …"

The card's Maestro setup flow reads a variable, usually a password, that the
job did not supply. Add `params.credentials`, and put the password in the
executor host's Keychain under service `fleet-ui-test`. A flow that carries its
own test account needs nothing.

## Load Warden says the emulator is "in use by another session"

For a freshly created AVD, `warden emu acquire` has refused with this when no
session held it. Ask for room with `warden wait --for emulator-boot`, then boot
it directly with `emulator -avd …`; Load Warden still tracks it.

## Typing fails on Android with "only printable ASCII"

`adb shell input text` sends key events from the device's key map and cannot
type "Café". The actuator refuses rather than typing "Caf", which the explorer
would then report as the app's bug. Write cards whose typed values are ASCII,
or test non-ASCII input through a language condition and the app's own
keyboard.

## FleetDriver never answers `/health`

- The first start of a runner on a simulator can take a minute; the actuator
  waits five.
- The iOS 27 simulator runtime aborts XCUITest runners on this Mac; use a 26.x
  simulator.
- If two processes build the driver at once into the same derived-data folder,
  one of them fails. Builds are deduplicated within one executor process, not
  across processes.
- On a physical device the runner must be signed (`FLEET_APPLE_TEAM_ID`). That
  path has never carried a request.

## The Roku actuator says tvloop is missing

It loads tvloop from a built checkout. Build one:

```bash
git clone https://github.com/addisdev/tvloop ~/tvloop
cd ~/tvloop && npx pnpm@10 install && npx pnpm@10 build
```

Set `FLEET_TVLOOP_DIR` if it is elsewhere. A real Roku also needs the developer
password in the Keychain (`fleet-roku-dev` / `rokudev`).

## A finding I marked "not a bug" came back

It cannot come back as a new finding: repeats merge on the fingerprint and the
verdict is never touched. If a near-identical one appears as new, its
fingerprint differs: a different screen, check, or message after numbers and
ids are stripped. Mark it **Duplicate** of the first; once ten verdicts in its
class are mostly misses, the class switches itself off.
