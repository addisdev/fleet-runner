# Wire in your own app

You have an app repository, a Mac, and a few devices. These four pages take you
from a cloned collector to your own nightly running on your own hardware, with
a verdict that can block a pull request.

!!! warning "What is proven, and what is not"

    `ci-enqueue` and `ci-upload` are **verified standalone**: they upload, they
    enqueue, they poll to a verdict and they exit 0 or 1, and the artifact and
    `"latest"` resolution behind them are covered end to end by the collector's
    test suite.

    **The GitHub Actions path has never run on a real GitHub runner.** The
    workflow templates below document a contract that is implemented on the
    collector side and installed nowhere. Nothing in any app repository
    references the fleet today. Treat the YAML as a starting point you will need
    to debug once, not as something known to work unmodified.

    Commit statuses are likewise **built and dark** — see [below](#commit-statuses).

| | |
|---|---|
| **[Your first job](first-job.md)** | `curl`, then the CI script standalone, then the dashboard. No CI involved. |
| **[Publish on merge](publish-on-merge.md)** | Every merge publishes a build the nightly can ask for by name. |
| **[Add your app](add-your-app.md)** | Flows, suites, visual baselines, and targeting the right devices. |
| **[Add a workload](add-a-workload.md)** | Teach the fleet something new without a collector release. |
| **[Cookbook](cookbook.md)** | One complete job spec per workload, validated in CI. |

## The two paths are independent

Most apps want both, but they answer different questions and neither depends on
the other.

**Publishing a build** happens on merge, tests nothing, and waits for no device.
This is the half nobody thinks about, and it is what makes a nightly meaningful:
a schedule that pins a literal `sha256` tests that build forever — one of these
spent six days guarding an APK older than the code it was meant to guard. A
schedule that asks for `"sha256": "latest"` tests whatever was published most
recently and never has to be edited again.

**Testing a pull request** enqueues a job against real hardware and blocks on
the verdict.

Coupling them means a busy shelf silently stops builds from being published,
which is why they are two workflows rather than one.

## Commit statuses

`report_to.github_status: "owner/repo@sha"` records a row in `status_reports`
for every job that asks for one, and **posts a real commit status only when
armed** on the collector with both:

```
FLEET_GITHUB_STATUS=1
FLEET_GITHUB_TOKEN=<token with repo:status>
```

Unarmed — the default — rows accumulate with `posted=0` and are visible on the
dashboard, so **you can see exactly what would have been posted before anything
reaches GitHub.** `GET /api/status-reports` is the audit trail either way.

Arming it makes a red nightly block a pull request. That is the point, and it is
also a decision with consequences for everyone who pushes, so it stays off until
somebody chooses it deliberately.

Note that `ci-enqueue` already exits non-zero on a red suite, so the check fails
whether or not statuses are armed. Arming adds the status on the *nightly's*
commit, which is the part a scheduled run cannot get any other way.

## What the runner needs to reach

The collector is LAN or tailnet only and has no authentication, so a
GitHub-hosted runner cannot reach it and should not be able to. The workflows
below assume a **self-hosted runner on the same tailnet**, with the collector's
address in a `FLEET_COLLECTOR_URL` secret.
