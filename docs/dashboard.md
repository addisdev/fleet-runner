# The dashboard

Served by the collector itself at `/dash`, from the same process and the same
SQLite file. One thing to keep alive, one URL, no CORS.

| | |
|---|---|
| ![Overview](img/overview.png) | ![Devices](img/devices.png) |
| **Overview** — the fleet and the queue at a glance, and what is running now | **Devices** — every device on the shelf with battery, thermal state and what it is doing |
| ![Jobs](img/jobs.png) | ![Results](img/results.png) |
| **Jobs** — the queue, with a composer and cancel/retry | **Results** — benchmark trends, eval accuracy, UI-test matrices, drain curves |
| ![Visual](img/visual.png) | ![Alerts](img/alerts.png) |
| **Visual** — every page across every profile, diffed against its accepted baseline | **Alerts** — one row per condition for as long as it holds, with acknowledge and snooze |
| ![Findings](img/findings.png) | |
| **Findings** — what an [`explore`](explore/index.md) night reproduced, with a verdict for each | |

These screenshots are from 2026-09-05. They predate the device drawings
described below, and there is none of the Findings screen.

## Building it

The dashboard is a Preact app with its own `package.json`, built by Vite, and
its output is gitignored. **The build is optional**: with no `dash/dist` the
collector serves a page telling you to run it, and everything else keeps
working.

```bash
npm run dash:install && npm run dash:build
npm run dash:dev     # Vite on :5178, proxying /api to a live collector
```

`dash:dev` proxies to `FLEET_URL`, so you can develop the UI against the real
fleet without a mock.

## What is there

The Overview, Devices, Jobs, Schedules, Evals, Visual, Findings, Artifacts,
Events, Alerts and System screens, with live updates over SSE. Findings is the
morning list from the [`explore`](explore/findings.md) workload, with a verdict
button for each one. Device detail has a 24 h
battery and thermal chart; job detail has per-device results, beacons and
artifacts.

**The Devices screen draws each device as the object it is**: one of 22
drawings, from phones and tablets through Roku boxes and sticks, an Apple TV,
laptops, watches and a headset to a board and a browser. The drawing is chosen
from the model string first, because agents that predate the `platform` field
are reported as `ios` or `android`: an Apple TV or Apple Watch arrives as
`ios`, and a Roku registered by an executor older than 0.9 as `android`.

**A skipped job has a grey chip**, neither green nor red: it was claimed and
nothing ran. The Jobs status filter has a `skipped` option with its count, and
the Overview's queue panel shows **skipped 24h** beside done and failed rather
than inside done. See [Skipped is not done](concepts.md#skipped-is-not-done).

**Filters live in the URL**, so a filtered view is a link you can send. Jobs can
be composed, enqueued, cancelled, retried and reprioritised; devices can be
renamed, annotated and re-pooled; schedules enabled, fired now and deleted;
artifacts uploaded and garbage-collected.

Alerts appear as a banner on every screen. The layout works on a phone, and `?`
lists the keyboard shortcuts — `g j` jobs, `g d` devices, `g f` findings, `g n` new job,
`/` search, and on a finding `r`, `d`, `n` or `a` for its verdict (real,
duplicate, not a bug, the agent's mistake).

## When the collector wants a token

If the collector runs with `FLEET_AUTH=tokens`, or has `FLEET_DASH_TOKEN` set,
and this browser holds no token, every screen shows a banner with a field to
paste one. With `FLEET_AUTH=tokens` nothing can be seen or changed without it;
`fleet token create NAME --scope read` on the collector's host makes one, and
`run` or `admin` lets you change things too. With only `FLEET_DASH_TOKEN`,
reads work and the banner asks for that value before anything can be changed.
The token is kept in the browser's local storage and sent as `X-Fleet-Token`.
With tokens on it is also exchanged for an HttpOnly session cookie that the
collector honours for reads only, so images and the live stream work. See
[Authentication](deploy/auth.md).

## Naming devices

A device id is a machine's answer to "who are you" — `sm-x930-0d41`,
`sdk-gphone64-arm64-b386`. Fine in a job spec, useless for knowing which slab of
glass on the shelf just went thermally critical at 3am.

**Click a device's name in the list to rename it.** There is no separate
nickname field: the name is what the device is called, and an unnamed device
shows its id because until you name it, that is its name.

The name then appears everywhere the dashboard prints that device. The id stays
available on hover and on the device's own page, since it is what job specs pin
and what `adb devices` prints.

Names are operator-set and survive re-registration, like pool overrides — see
[why pool edits go to a different column](api.md#pool-edits-go-to-a-different-column).

## Adding a device

`/dash/devices/new` is the enrolment screen: a QR code of the collector's
address, a download of the newest runner build straight from the artifact store,
per-platform install steps, and a panel that watches the registry and names the
device the moment it registers.

**The QR encodes an address derived from the host's own network interfaces**,
not from the browser's origin. View the dashboard through an SSH tunnel and your
origin is `127.0.0.1`, which is a fine URL for you and a useless one for a
phone. The screen says so and offers the LAN and tailnet addresses instead.

Artifact downloads take `?filename=`, which sets a `content-disposition` so the
runner arrives on the phone as `fleet-runner-0.2.0.apk` rather than a
64-character hash Android will not offer to install.

## The legacy dashboard

The server-rendered tables that used to be `/dash` still live at `/dash/legacy`.
They have **no unique feature left** — the cross-device benchmark comparison
moved into the app — but they are deliberately kept.

They have no build step, so they are the only dashboard that works from a bare
checkout or when a bundle fails to build. That, and nothing else, is now their
job.
