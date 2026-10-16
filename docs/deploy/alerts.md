# Alerts

Evaluated every 60 seconds (`FLEET_ALERT_TICK_MS`, whole milliseconds and at
least 1000; anything else is ignored with a startup warning). **Alerts are state, not events**: one row per (rule,
subject) for as long as the condition holds, resolved when it stops. A device
offline for six hours is one row with a rising `seen_count`, not 360
notifications — and nothing is notified twice, ever.

![The Alerts screen with one open alert: a self-check job that failed after one"
 attempt of three, with acknowledge and snooze on the row](../img/alerts.png)

## The rules

| Rule | Fires when |
|---|---|
| `device-offline` | No check-in for `FLEET_ALERT_DEVICE_OFFLINE_S` (default 15 min) |
| `thermal-critical` | A device still reporting is thermally critical |
| `low-battery` | Below `FLEET_ALERT_LOW_BATTERY_PCT` (default 15) and not charging |
| `job-failed` | A job failed in the last 24 h |
| `job-stuck` | Claimed, lease still being renewed, but no result rows after `FLEET_ALERT_STUCK_LEASE_MULTIPLE` (default 2) × the lease TTL |
| `benchmark-regressed` | Decode throughput fell more than `FLEET_ALERT_REGRESSION_PCT` (10%) against its own `FLEET_ALERT_REGRESSION_DAYS` (7) day median |
| `cold-start-regressed` | Launch time rose past the same threshold against its own median |
| `batch-regressed` | Top-1 accuracy fell past the same threshold |
| `schedule-missed` | An enabled schedule that has run before missed its firing by `FLEET_ALERT_SCHEDULE_LATE_S` (default 5 min) |
| `schedule-skipping` | An enabled schedule's last `FLEET_ALERT_SKIP_STREAK` (default 3) runs all [skipped](../concepts.md#skipped-is-not-done) |
| `db-size` / `log-size` | Past `FLEET_ALERT_DB_BYTES` (default 2 GiB) / `FLEET_ALERT_LOG_BYTES` (200 MiB) |

Every threshold is read once, at collector start; a value that is not a
positive number falls back to the default. `job-failed`'s 24-hour window is
fixed.

`job-stuck` is the case the lease sweep cannot see: beacons keep renewing the
claim, so the job never lapses, and without this rule a runner that is alive but
producing nothing looks identical to one that is working.

Battery and thermal are only judged on devices **still checking in** — a reading
from a silent device describes whenever it went silent, not now. And a device
reporting `-1` has no battery telemetry rather than a flat battery.

## A schedule that keeps skipping

A skipped job is no longer counted as a pass, but a grey chip every morning is
still easy to stop seeing. `nightly-tvloop-hardware` skipped every night for two
weeks on a missing Roku password and nothing said so. `schedule-skipping` is
one alert per schedule, worded from the reason the runs keep giving:

```text
nightly-tvloop-hardware has skipped 3 runs in a row: no Roku developer password on this host
```

What counts as a run, and as a skip:

- **A run is what the scheduler enqueued**: the job `<schedule>-<YYYYMMDDHHMM>`,
  or for a fan-out every child of it. The id is what identifies it, so jobs
  from before provenance was recorded still count.
- **A run skipped when nothing in it ran**: every job in it is `skipped` (or
  skipped and cancelled). One device that ran makes the run count as run.
- **A run still in flight is left out**: it neither breaks the streak nor
  extends it.
- If the runs gave different reasons, the alert names the latest and says how
  many different reasons there were.

It resolves on the first run that is not a skip, pass or fail. Disabled
schedules are not watched. The streak length is `FLEET_ALERT_SKIP_STREAK`,
read at start like the others.

## The regression rules compare against history, not a threshold

The comparison key matters more than the threshold. Two runs are only comparable
on the same device with the same model, quant and backend, and **comparing
across any of those is how a "regression" turns out to be a different model**.

The baseline is the median of the trailing seven days
(`FLEET_ALERT_REGRESSION_DAYS`), needs at least four prior runs
(`FLEET_ALERT_REGRESSION_MIN_SAMPLES`), and the alert's subject is keyed on the same tuple the comparison was — so
a device that has genuinely got slower is one alert with a rising `seen_count`,
not a new one every night.

Percent rather than absolute, because the shelf spans a 2016 phone and current
silicon, and one threshold in tok/s would be noise on one and silence on the
other.

## Getting told

`FLEET_ALERT_WEBHOOK` pushes newly opened alerts to ntfy or any webhook
receiver. Unset — the default — makes the dashboard the only channel.

**A red nightly that reaches nobody is worse than no nightly.** For a desktop
notification instead of a hosted service,
[`scripts/alert-receiver.ts`](https://github.com/addisdev/fleet-runner/blob/main/collector/scripts/alert-receiver.ts)
is a local webhook target that raises a macOS notification, installed with its
own LaunchAgent.

It runs on the machine somebody is actually looking at, not on the headless
host. Point `FLEET_ALERT_WEBHOOK` at the collector's own loopback port and let
[the tunnel's](networking.md) reverse forward deliver it — loopback at both ends,
so the alert never crosses the LAN and never leaves the house.

## Reading them

The Alerts screen, `GET /api/v1/alerts` (`?state=open,acked,snoozed,resolved`;
all but resolved by default, `read` scope when tokens are on), and the
`fleet_alerts_open` gauge on [`GET /metrics`](../api.md#control-api-apiv1).

## Quieting one

**Acknowledge** keeps an alert listed but stops it nagging. **Snooze** quiets it
for N minutes and it returns on its own. Only the condition clearing resolves an
alert.
