# Wiring an app repo to the fleet

Two independent paths. Most apps want both, but they answer different questions
and neither depends on the other.

## 1. Publish builds — `publish-build.yml`

On merge to `main`, build and publish to the fleet's artifact store tagged with
the app name. Nothing is tested; nothing waits for a device.

This is what makes a nightly meaningful. A schedule that pins a literal
`sha256` tests that build forever — one of ours spent six days guarding an APK
older than the code it was meant to guard. A schedule that asks for
`"sha256": "latest"` tests whatever was published most recently, and never has
to be edited.

The contract is one header: an artifact uploaded with `x-artifact-app` belongs
to that app, and `latest` resolves to the newest one. If no build has ever been
published for an app, its nightly is **skipped rather than failed** — a job
pinned to a build that does not exist would fail in a way indistinguishable
from the app being broken.

**A pull request's build never moves `latest`.** An upload with
`x-artifact-channel: pr` is stored on the `pr` channel, and `latest` only
considers builds without it, so the nightly keeps testing what was merged.
`ci-upload` and `ci-enqueue` send the header themselves when
`GITHUB_EVENT_NAME` is `pull_request` (or `pull_request_target`); `--channel
pr|main` says it explicitly. The pull request's own job names its build by
hash, so it still tests exactly that build. Bytes republished from main come
off the channel; builds from before the channel existed count as merged.

## 2. Test a pull request — `example-workflow.yml`

Enqueue a job against real hardware and block the PR on the verdict.
`ci-enqueue` uploads the build, enqueues through `/api/v1`, waits for the
verdict, and exits like `fleetr run`: 0 passed, 1 failed, 2 invalid spec,
3 still running at `--timeout`, 4 skipped (nothing ran), 5 refused or
unreachable. So the check fails on a red or skipped suite whether or not
commit statuses are armed.

## Tokens

With `FLEET_AUTH=tokens` on the collector, put a token in a secret and pass it
as `FLEET_RUNNER_TOKEN`: both scripts send it as `Authorization: Bearer`.
`ci-enqueue` needs `run`. The upload is the runner protocol, which is open
unless the collector also sets `FLEET_AUTH_PROTOCOL=token`; then both scripts'
uploads need `agent` as well. `FLEET_DASH_TOKEN` is still sent as
`x-fleet-token`, for a collector guarded only by that.

## Commit statuses are built and dark

`report_to.github_status` records a status row for every job that asks for one,
and posts nothing unless **both** are set on the collector:

```
FLEET_GITHUB_STATUS=1
FLEET_GITHUB_TOKEN=<token with repo:status>
```

Unarmed, rows accumulate with `posted=0` and are visible on the dashboard — you
can see exactly what would have been posted before anything reaches GitHub.

Arming it makes a red nightly block a PR. That is the point, and it is also a
decision with consequences for everyone who pushes, so it stays off until
somebody chooses it deliberately.
