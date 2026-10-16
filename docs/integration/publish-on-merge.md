# Publish on merge

Every merge to your default branch publishes a build to the fleet's artifact
store, tagged with the app it is. Nothing is tested; nothing waits for a device.

This is the half of nightly testing nobody thinks about, and skipping it is how
a schedule ends up guarding a build older than the code it is meant to guard.

## Why not just pin a hash

A schedule that names a literal `sha256` tests **that build forever**. One of
these spent six days guarding an APK older than the code it was meant to guard,
and it was green the whole time, because the build it tested really was fine.

A schedule that asks for `"sha256": "latest"` tests whatever was published most
recently, and never has to be edited again.

## The contract is one header

An artifact uploaded with `x-artifact-app` belongs to that app, and `latest`
resolves to the newest one:

```bash
curl -X POST http://fleet-host.local:8788/artifacts \
  -H 'content-type: application/octet-stream' \
  -H 'x-artifact-name: app-debug.apk' \
  -H 'x-artifact-app: your-app-android' \
  -H 'x-artifact-build: 1.4.2-903' \
  -H 'x-artifact-platform: android' \
  --data-binary @app/build/outputs/apk/debug/app-debug.apk
```

Those headers are what stamp the publish ordering that `latest` reads. There is
no `/artifacts/:sha/publish` endpoint and none is needed.

`POST /artifacts` is a runner-protocol route, so it stays open even with
`FLEET_AUTH=tokens` unless the collector also sets `FLEET_AUTH_PROTOCOL=token`
(see [Authentication](../deploy/auth.md)). Then it needs a token with the
`agent` scope (or `admin`; `run` is not enough): send
`-H "authorization: Bearer <token>"` with curl. `ci-upload` has no bearer
option; it sends `FLEET_DASH_TOKEN` from its environment as `x-fleet-token`,
which the collector also accepts as a token, so put the `agent` token in that
variable. That route has been read from the code, not run against a
protocol-gated collector.

!!! note "An app with no published build is skipped, not failed"

    If nothing has ever been published for an app name, its nightly is
    **skipped rather than failed**. A job pinned to a build that does not exist
    would fail in a way indistinguishable from the app being broken.

## The workflow

Copy
[`collector/ci/publish-build.yml`](https://github.com/addisdev/fleet-runner/blob/main/collector/ci/publish-build.yml)
into your app repository as `.github/workflows/publish-build.yml` and change the
three values marked `CHANGE ME`.

```yaml
name: publish-build-to-fleet
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: [self-hosted]     # must be able to reach the collector
    steps:
      - uses: actions/checkout@v4
        with:
          # `git describe` needs history; the default shallow clone has none,
          # so the build string would be a bare sha with no version in it.
          fetch-depth: 0

      # CHANGE ME (1/3): however this app builds.
      - name: Build
        run: ./gradlew :app:assembleDebug

      - name: Publish to the fleet
        run: |
          npx --yes tsx scripts/ci-upload.ts \
            --collector "${{ secrets.FLEET_COLLECTOR_URL }}" \
            --app       your-app-android \
            --build     "$(git describe --tags --always)" \
            --platform  android \
            --artifact  app/build/outputs/apk/debug/app-debug.apk
        # CHANGE ME (2/3): --app must match the `app.name` in the fleet
        #   schedule that tests it, or the nightly will never see the build.
        # CHANGE ME (3/3): --artifact is the path this build actually produces.
```

**`--app` must match the `app.name` in the schedule that tests it.** That is the
single most common way to wire this up and see nothing happen: the build
publishes fine, the nightly runs fine, and they are talking about different
names.

## The schedule that consumes it

```json
{
  "schema": 1,
  "workload": "ui-test",
  "executor": "host",
  "app": { "name": "your-app-android", "build": "latest", "sha256": "latest" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" },
  "targets": { "match": "os ~ 'android'", "exclusive": true },
  "lease": { "ttl_s": 1800 }
}
```

This is the schedule's template. It needs no `job_id`: each firing is enqueued
as `<schedule id>-<minute>`, and one in the template would be replaced.
`"build": "latest"` is there because the schema requires `app.build`; the
collector records the build string the published artifact carries.

Put it in
[`scripts/seed-schedules.ts`](https://github.com/addisdev/fleet-runner/blob/main/collector/scripts/seed-schedules.ts)
rather than only in the database, and `npm run seed:schedules`. That is
idempotent and preserves the on/off state of anything already there.

**New schedules arrive disabled.** Enable it from the dashboard when you have
watched it run once by hand.

## Chaining a build to its own test

If a machine agent does your building, [job chains](../concepts.md#job-chains)
do the waiting. Nothing accepts a list of jobs in one request, so enqueue them
one at a time, in dependency order, and let `depends_on` hold the later ones in
`waiting`:

```json title="build-903.json"
{ "job_id": "build-903", "workload": "build", "executor": "device",
  "params": { "repo": "git@github.com:you/app.git", "ref": "main",
              "kind": "gradle", "task": "assembleDebug", "app": "your-app-android" } }
```

```json title="install-903.json"
{ "job_id": "install-903", "workload": "install", "executor": "host",
  "depends_on": ["build-903"],
  "app": { "name": "your-app-android", "build": "903",
           "sha256": "${jobs.build-903.artifact}" } }
```

```json title="ui-903.json"
{ "job_id": "ui-903", "workload": "ui-test", "executor": "host",
  "depends_on": ["build-903", "install-903"],
  "app": { "name": "your-app-android", "build": "903",
           "sha256": "${jobs.build-903.artifact}" },
  "suite": { "kind": "maestro", "flows": "your-app/smoke.yaml" } }
```

```bash
fleetr run --spec build-903.json --no-wait
fleetr run --spec install-903.json --no-wait
fleetr run --spec ui-903.json --no-wait
fleetr wait ui-903          # exits with the UI test's verdict
```

The ids are fixed here because the later specs name the earlier ones. A
dependency has to exist when its dependent is enqueued, which is why the order
matters, and a `${jobs.<id>.artifact}` reference may only name a job listed in
`depends_on`, which is why `ui-903` lists the build as well as the install. A broken build fails the install and the UI test with it, naming the
cause, rather than leaving them in `waiting` until somebody notices next week.
