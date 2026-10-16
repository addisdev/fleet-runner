# Add your app

Flows, suites and baselines. Everything here lives in the collector's checkout,
not in your app repository — the fleet holds the tests, your repository holds
the code.

## Where things go

| | Directory | Override |
|---|---|---|
| Maestro flows | `collector/examples/flows/<app>/` | `FLEET_FLOWS_DIR` |
| Playwright specs | `collector/examples/web-specs/<site>/` | `FLEET_WEB_SPECS_DIR` |
| Visual capture manifests | `collector/examples/web-specs/<site>/shots.json` | |
| Audit config | `collector/examples/web-specs/<site>/audit.json` | |

The defaults are `examples/flows` and `examples/web-specs`, resolved from the
directory the collector and executor run in, which is `collector/` for
`npm start`. Set the overrides to keep your own flows and specs outside the
checkout.
[`examples/`](https://github.com/addisdev/fleet-runner/tree/main/collector/examples)
has working versions of each, including a neutral `fleetrunner/smoke.yaml` you
can copy as a starting point.

## A Maestro flow

```yaml
appId: com.example.yourapp
---
- launchApp
- assertVisible: "Sign in"
- tapOn:
    id: "email_field"
- inputText: "test@example.com"
- tapOn: "Continue"
- assertVisible:
    id: "home_header"
```

Then:

```json
{ "workload": "ui-test", "executor": "host",
  "app": { "name": "your-app-android", "build": "latest", "sha256": "latest" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" },
  "targets": { "exclusive": true } }
```

`exclusive` takes a device lock, because two suites tapping the same phone is
not a test.

!!! tip "Accessibility identifiers are the real cost, not the tests"

    Two of the three apps this was first built for had **none**, and the third's
    history says what that costs: an identifier that never existed at runtime
    because SwiftUI pushes a parent's identifier down over its children, and a
    card identifier that matched twice so every tap failed with "Find single
    matching element".

    Budget for adding identifiers before you budget for writing flows. [The iOS
    nightly suites journal](../history/ios-nightly-suites.md) is a real survey
    of what this took.

## An XCUITest bundle

```json
{ "workload": "ui-test", "executor": "host",
  "app": { "name": "your-app-ios", "build": "latest", "sha256": "latest" },
  "suite": { "kind": "xcuitest", "bundle": "YourAppUITests-Runner.app" },
  "targets": { "executor": "mac-xcode" } }
```

iOS UI tests need a Mac with **full Xcode** — `simctl` and `devicectl` do not
ship with the Command Line Tools — so pin them to that executor. See [the iOS
executor](../deploy/ios-executor.md).

## Visual regression

`web-specs/<site>/shots.json` lists the pages and the profiles to capture under:

```json
{
  "pages": [
    { "name": "home", "path": "/", "settle_ms": 400 },
    { "name": "pricing", "path": "/pricing", "mask": [".carousel"], "fullPage": true }
  ],
  "profiles": ["chromium", "android-device"],
  "threshold_pct": 0.1
}
```

Then `web-shots` captures, diffs against the accepted baseline, and fails a page
over its threshold with a diff image attached.

**A page with no baseline passes**, marked "new: no baseline", until you accept
a shot from the dashboard's Visual page. That is deliberate: a new page should
not fail a suite before anybody has decided what it is supposed to look like.

Masks matter more than they look. A carousel, a timestamp or an animated hero
will diff on every run, and the correct response is a `mask` selector rather
than a raised threshold, which would hide real changes everywhere else on the
page.

### Real phone screens

`android-device` and `ios-sim-safari` are meta-names that expand to whatever
hardware is attached to the claiming executor — one profile and one baseline per
device, because two phones have two screens.

**A meta-name that finds no hardware fails its slot** rather than quietly
shrinking the matrix, so pin those captures to the executor whose shelf holds
the devices.

## Targeting the right devices

Use `targets.match`, not pools. See [Targeting](../concepts.md#targeting) for
why, but the short version is that a pool is a label somebody has to keep
accurate and a match is a statement about what the job needs:

```json
{ "targets": { "match": "os ~ 'android' && ram_mb >= 3000" } }
```

Check what a match would select before you schedule it. `--validate` runs
every check an enqueue makes and lists the devices the job would land on,
without queueing it:

```bash
fleetr run --spec job.json --validate
fleetr run benchmark --match "os ~ 'android' && ram_mb >= 3000" --validate
```

That is `POST /api/v1/jobs/validate` underneath, which takes a whole spec. The
older `POST /api/jobs/preview-targets` still answers for a bare `targets`
object:

```bash
curl -s -X POST http://fleet-host.local:8788/api/jobs/preview-targets \
  -H 'content-type: application/json' \
  -d '{ "targets": { "match": "os ~ '\''android'\'' && ram_mb >= 3000" } }'
```

## Blocking a pull request

Copy
[`collector/ci/example-workflow.yml`](https://github.com/addisdev/fleet-runner/blob/main/collector/ci/example-workflow.yml)
into your app repository. It builds, then calls `ci-enqueue`, which exits
non-zero on a red suite — so the check fails whether or not [commit
statuses](index.md#commit-statuses) are armed.

`ci-enqueue` also exits 0 on a job that was skipped because nothing ran, and
sends no token, so it fails against a collector with `FLEET_AUTH=tokens`
([details](first-job.md#or-in-one-step-with-ci-enqueue)). For a check that
should block a merge, replace that step with `ci-upload` followed by
`fleetr run --spec job.json`, which exits 1 on a red suite and 4 on a skip,
and fails the step on either.

Give the job a unique `job_id` built from the pull request number, the run
attempt and the sha. A duplicate is a 409, which is the correct answer but not
the one you want on a re-run.
