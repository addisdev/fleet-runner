# Alerts

Evaluated every 60 seconds. **Alerts are state, not events**: one row per (rule,
subject) for as long as the condition holds, resolved when it stops. A device
offline for six hours is one row with a rising `seen_count`, not 360
notifications — and nothing is notified twice, ever.

## The rules

| Rule | Fires when |
|---|---|
| `device-offline` | No check-in for `FLEET_ALERT_DEVICE_OFFLINE_S` (default 15 min) |
| `thermal-critical` | A device still reporting is thermally critical |
| `low-battery` | Below `FLEET_ALERT_LOW_BATTERY_PCT` (default 15) and not charging |
| `job-failed` | A job failed in the last 24 h |
| `job-stuck` | Claimed, lease still being renewed, but no result rows after 2× the lease TTL |
| `benchmark-regressed` | Decode throughput fell more than `FLEET_ALERT_REGRESSION_PCT` (10%) against its own 7-day median |
| `cold-start-regressed` | Launch time rose past the same threshold against its own median |
| `batch-regressed` | Top-1 accuracy fell past the same threshold |
| `schedule-missed` | An enabled schedule that has run before missed its firing by 5 min |
| `db-size` / `log-size` | Past `FLEET_ALERT_DB_BYTES` / `FLEET_ALERT_LOG_BYTES` |

`job-stuck` is the case the lease sweep cannot see: beacons keep renewing the
claim, so the job never lapses, and without this rule a runner that is alive but
producing nothing looks identical to one that is working.

Battery and thermal are only judged on devices **still checking in** — a reading
from a silent device describes whenever it went silent, not now. And a device
reporting `-1` has no battery telemetry rather than a flat battery.

## The regression rules compare against history, not a threshold

The comparison key matters more than the threshold. Two runs are only comparable
on the same device with the same model, quant and backend, and **comparing
across any of those is how a "regression" turns out to be a different model**.

The baseline is the median of the trailing seven days, needs at least four prior
runs, and the alert's subject is keyed on the same tuple the comparison was — so
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

## Quieting one

**Acknowledge** keeps an alert listed but stops it nagging. **Snooze** quiets it
for N minutes and it returns on its own. Only the condition clearing resolves an
alert.
