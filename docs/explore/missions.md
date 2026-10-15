# Mission cards

A mission card tells the explorer who to be and what to try. Cards are JSON
files in `collector/examples/missions/<app>/`, one card (or a list of cards) per
file. `<app>` is the job's `app_key`.

```json
{
  "id": "explore-careless-typist",
  "app": "bug-garden",
  "title": "Fill every form badly",
  "persona": "A careless typist in a hurry who never reads labels.",
  "goal": "Add a plant and edit one, filling every field with awkward values: empty, very long, decimals in number fields, leading spaces. Save each time.",
  "success": "Every invalid value gets a clear message and nothing crashes.",
  "budget": { "steps": 60, "minutes": 20 },
  "surfaces": ["touch"],
  "screens": ["edit", "detail"],
  "setup_flow": "bug-garden/sign-in.yaml"
}
```

## Fields

| Field | Required | What it does |
|---|---|---|
| `id` | yes | Unique per app. Cards whose id starts with `bench-` are [bench cards](#bench-cards) |
| `app` | | Defaults to the directory name |
| `title` | yes | Shown on findings and in the trajectory sheet |
| `persona` | yes | Who the model pretends to be, in a sentence |
| `goal` | yes | What to try, in a sentence or two |
| `success` | | How the judge decides the goal held, read against the final screen. Without it there is no goal check |
| `budget.steps` | | Model steps, 3 to 300. Default 40 |
| `budget.minutes` | | Wall time. Default 30 |
| `surfaces` | | `touch`, `dpad` or both. A card is skipped on a device of the other kind |
| `screens` | | Screen words this card tends to reach, matched against [today's changes](how-it-works.md#aimed-at-todays-work) |
| `allow` | | Dangerous classes this card may touch: `delete`, `purchase`, `invite`, `sign_out`. See [the leash](safety.md#what-is-refused) |
| `block` | | Extra patterns this card must not touch, as case-insensitive regular expressions over the control's label |
| `setup_flow` | | A Maestro flow, relative to the flows directory, run after reset to sign in |
| `launch_args` | | Launch arguments. See [below](#launch-arguments) |
| `check` | | A bench card's end state. See [bench cards](#bench-cards) |

## Writing a good card

- **Give a reason to go somewhere.** "Add a first plant" reaches the edit form,
  validation and the list; "use the app" reaches whatever the first screen
  links to.
- **Make the persona do something specific.** "A careless typist" types
  decimals into number fields; "a German speaker" changes the language first.
  Both find bugs a polite user would not.
- **Name the screens.** `screens` is what lets a day's commit to
  `PlantDetailScreen.kt` move this card to the front.
- **Say what success looks like** in terms the final screen can show: "a plant
  named Basil is in the list", not "the plant is saved correctly".
- **Keep budgets honest.** 40 steps is about fifteen minutes at twenty seconds
  a step. A card that needs 100 steps is two cards.

## Production data

A debug build that talks to a production backend must not be explored with
write access. The GreenFolio Android debug build does, so its cards stay signed
out and block anything that creates or sends:

```json
"block": ["\\bcreate account\\b", "\\bsign up\\b", "\\bregister\\b", "\\bsend\\b"]
```

The signed-in GreenFolio card is read-only by `block`, and runs only when the
job supplies credentials for a test account. Where an app has an offline or
fixture mode, prefer it: the GreenFolio iOS cards launch with
`-UITesting -UITestingSignedOut -UITestingOffline`, so the backend is never
reached at all.

## Launch arguments

- **iOS and tvOS:** process arguments, passed straight through
  (`["-uiTestStubCatalog"]`).
- **Android:** there are no process arguments, so each must be `key=value` and
  becomes a string intent extra (`--es key value`). Anything else is refused by
  name, so a card written for iOS fails loudly on Android instead of launching
  a different state of the app.
- **Conditions** add their own: a language condition on iOS adds
  `-AppleLanguages (<tag>) -AppleLocale <locale>`.

## Setup flows

A setup flow is an ordinary Maestro flow. `${APP_ID}` is always provided; any
other `${NAME}` must come from the job's `credentials`:

```json
"credentials": { "account": "showcase@example.com", "email_var": "GREENFOLIO_TEST_EMAIL", "password_var": "GREENFOLIO_TEST_PASSWORD" }
```

The password is read from the executor host's Keychain (service
`fleet-ui-test`, account as given) and never appears in a job spec. A flow that
carries its own test account, like the bug garden's, needs nothing.

## Bench cards

A bench card has an id starting `bench-` and a `check` the harness can
evaluate without a model:

```json
{
  "id": "bench-delete-plant",
  "title": "Delete Aloe Vera",
  "persona": "Someone tidying up their list.",
  "goal": "Delete the plant called Aloe Vera.",
  "budget": { "steps": 12 },
  "allow": ["delete"],
  "launch_args": ["garden_defects=false"],
  "check": { "screen": "home", "text": ["8 plants"], "absent_text": ["Aloe Vera"] }
}
```

| `check` field | Passes when |
|---|---|
| `text` | Every string appears in some element's text, label (content-desc) or value on the final screen. Case-insensitive substring |
| `absent_text` | None of these appears anywhere on the final screen |
| `focused_label` | The focused element's label contains it (TV cards) |
| `screen` | The final screen's name contains it |

Bench cards run only in bench mode (`params.bench: true`) and exploration cards
only outside it. Bench missions run with no judge and file nothing; the number
that comes out is how many end states the model reached. See
[Measuring a model](measuring.md#the-mission-bench-b4).

## The cards that exist

| Directory | Cards |
|---|---|
| `bug-garden/` | 7 exploration, 20 bench, all on the fixture app |
| `greenfolio/` | 3 Android: the sign-in gate, forgot password, a read-only signed-in tour |
| `greenfolio-ios/` | 2 iOS, offline: the sign-in gate, creating an account with no network |
| `dozehound-tv/` | Android TV / Fire TV: 3 exploration, 10 bench |
| `dozehound-tvos/` | tvOS: 1 exploration, 1 bench (its end-state text is unverified) |
| `fakeroku/` | 10 bench, for tvloop's fake Roku |
