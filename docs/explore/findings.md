# Findings and verdicts

What a night leaves behind, and how your judgement of it steers the next one.

## The Findings page

**Findings** in the dashboard's top bar, or <kbd>g</kbd> <kbd>f</kbd>.

The **list** can be filtered by app, check and status (open, triaged, all).
Each row shows severity, check, title, screen, how many times and on how many
builds it has been seen, how it replayed ("reproduced 2/2", "flaky 1/2",
"crash log"), and when it was first and last seen.

The **detail** view shows the screenshot, the steps in words, the detail text
with every replay's outcome, links to the contact sheet, trajectory, log and
replay file, and four buttons:

| Button | Key | Means | Counts towards precision |
|---|---|---|---|
| **Real** | <kbd>r</kbd> | A bug in the app | Yes, as a hit |
| **Duplicate** | <kbd>d</kbd> | The same problem as another finding (pick which) | No |
| **Not a bug** | <kbd>n</kbd> | The app is fine; the check was wrong | Yes, as a miss |
| **Agent's mistake** | <kbd>a</kbd> | The explorer did something odd and reported its own doing | Yes, as a miss |

A note is optional and is kept with the verdict. Setting the verdict to none
reopens a finding. A duplicate follows its chain to the original, and a loop is
refused. The keys are ignored straight after <kbd>g</kbd>, so <kbd>g</kbd>
<kbd>r</kbd> still goes to Results.

A **precision table** at the top shows, for every check that has verdicts, how
often it was right and whether it has been switched off.

## Precision and switching checks off

For each app, check and visual class:

```
precision = real / (real + not a bug + agent's mistake)
```

Duplicates are left out of both sides: one noisy finding that recurs nightly
should not decide its class's fate on its own.

Once **ten** are judged, a class under **30%** is switched off at the start of
the next night for that app. A visual class (say `low_contrast`) is switched off
on its own; the judge is told not to report it and the rest keep running. Any
other check is switched off whole. **Crashes and ANRs are never switched off**:
their evidence is the platform's own log, not a judgement.

## The morning digest

Set on the collector:

```bash
FLEET_ALERT_WEBHOOK=https://ntfy.sh/your-topic    # the same webhook alerts use
FLEET_FINDINGS_DIGEST_AT=07:30                    # local time
FLEET_FINDINGS_DIGEST_HOURS=24                    # how far back; default 24
```

Once a day at that time, a plain-text digest of findings first seen (or seen
again) in the window, grouped by app with the top titles and a link, goes
through the same sender as alerts. Nothing is sent on a day with nothing new,
and a restart does not send twice. Findings judged not a bug, agent's mistake
or duplicate are left out. `FLEET_DASH_URL` sets the address used in its links.

## GitHub issues (off by default)

Fleet Runner stays disconnected from the app repositories until that is decided
otherwise, so this defaults to a **dry run**, exactly like commit statuses.

An issue is composed when a finding is first stored and either reproduced on
every replay or is a crash. It gets a title, a Markdown body (steps, check,
build, device, replay status, links; model-written text inside code fences, so
no @mention in it pings anyone) and the label `night-qa`. It is capped at five
new issues per app per 24 hours, dry runs included.

It is only ever **sent** when all three are set:

```bash
FLEET_GITHUB_ISSUES=1
FLEET_GITHUB_TOKEN=…
FLEET_FINDINGS_REPOS='{"greenfolio":"addisdev/greenfolio-android"}'
```

Until then, `GET /api/findings/issues` lists what would have been filed. The
collector only ever creates issues: it never edits, comments on or closes one.
A failed send is not retried, because a timeout can hide an issue that was in
fact created.

| Issue state | |
|---|---|
| `dry_run` | Composed, not armed |
| `pending` · `filed` · `failed` | Armed: sending, sent (with its URL), refused |
| `capped` | Over the day's five; retried the next time the finding is seen |
| `no_repo` | No repository mapped for the app; retried likewise |

## The API

### `POST /findings`

From executors. Open, like `POST /results`: the collector's access control for
executors is the network, not the dashboard token. The body is an
`ExploreFinding`:

```json
{
  "fingerprint": "5b1e…",
  "app": "bug-garden", "build": "fixture-1", "platform": "android",
  "device_id": "emulator-5554", "job_id": "explore-try-1", "mission_id": "explore-careless-typist",
  "check": "crash", "subclass": null, "severity": "high",
  "title": "Crash: java.lang.NullPointerException",
  "detail": "java.lang.NullPointerException (after step 4 on Add plant) Replays: …",
  "screen": "02c1db49ee", "screen_name": "Add plant",
  "steps": ["On \"My plants\":", "  Tap \"Add plant\"", "…"],
  "replay": { "kind": "maestro", "sha256": "…", "attempts": 2, "reproduced": 2 },
  "artifacts": { "shot": "…", "sheet": "…", "trajectory": "…", "log": "…", "replay": "…" }
}
```

| Reply | When |
|---|---|
| `201 {id, new: true, seen_count, issue}` | A new finding |
| `200 {id, new: false, seen_count, issue}` | Seen before: the count, last-seen time and builds go up; the replay is replaced only by a better one; severity only rises; the first title, steps and evidence stay; the verdict is never touched |
| `400` | A missing field, an unknown check, a bad severity or hash, `reproduced > attempts` |
| `413` | A body over 128 KB |
| `422` | A replay that reproduced 0 times, or `replay: null` on anything but a crash |

`check` is one of `crash anr frozen blank left_app a11y visual goal regression
agent_stuck dead_control leash`. `subclass` is the visual judge's class.

### Reading

| Method & path | |
|---|---|
| `GET /api/findings?app=&check=&status=open\|triaged\|all&since=&limit=` | Newest last-seen first; up to 500 |
| `GET /api/findings/:id` | One finding, with its duplicates |
| `GET /api/findings/precision?app=&min=10` | `{floor, min, classes[], disabled[]}`; the workload reads `disabled` at the start of a night |
| `GET /api/findings/digest?hours=12` | The digest, as text and as data |
| `GET /api/findings/issues` | Every issue composed, dry run or filed |

### Writing

| Method & path | |
|---|---|
| `POST /api/findings/:id/verdict` | `{verdict: "real"\|"duplicate"\|"not_a_bug"\|"agent_mistake"\|null, note?, duplicate_of?}`. Needs `X-Fleet-Token` when `FLEET_DASH_TOKEN` is set |

## Retention

A finding's artifacts are kept as long as the finding is. A night's run
artifacts (`explore-run-*`: full trajectories and contact sheets) are offered
for garbage collection after seven days unless a finding links them or someone
pinned them.
