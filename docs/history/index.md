# History

Design documents kept as they were written. **None of these are maintained**,
and where they disagree with the rest of this site, the rest of this site is
right.

They are kept because the reasoning in them is why the thing is shaped as it
is, and because a plan written before the work — including the parts that turned
out wrong — is more honest than one tidied up afterwards.

| | Written | What it is |
|---|---|---|
| [The original plan](plan.html) | before any code existed | The architecture and build plan. Every phase in it was built. |
| [Dashboard plan](dashboard-plan.md) | 2026-08 | The plan the dashboard was built from, D0 through D6. Complete. |
| [UI test plan](ui-test-plan.md) | 2026-08 | How nightly UI testing across iOS, Android and web was going to work, including what stood in the way. |
| [iOS nightly suites](ios-nightly-suites.md) | 2026-08-20 | Filling those rails for three real iOS apps, and what accessibility identifiers actually cost. |

## Why the last two name other apps

The UI test plan and the iOS nightly suites are about wiring three of the
author's own shipping apps into the fleet. They are kept with those names
intact, because the specifics are the evidence: a plan that says "an app" is a
plan nobody has tested, and the identifier problems described in the nightly
suites document are exactly the ones anybody doing this will hit.
