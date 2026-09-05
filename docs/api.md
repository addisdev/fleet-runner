# HTTP API

Grouped by who calls it. The agent API is [the protocol](protocol.md) and is the
only part an agent needs.

Timestamps are ISO-8601 **UTC with a `Z`**. SQLite stores
`YYYY-MM-DD HH:MM:SS` with no zone marker, which JavaScript parses as local
time, so the API normalises rather than leaving each client to get it wrong.
Every list is bounded.

## Agent API

Never guarded, whatever `FLEET_DASH_TOKEN` is set to — the fleet has to keep
running whether or not anyone has a token in a browser.

| Method & path | Purpose |
|---|---|
| `POST /devices/register` | Device checks in with descriptor, pools and capabilities (upsert) |
| `GET /devices/:id/next-job` | Long-poll (~25 s) for device work; 204 when none |
| `GET /executor/next-job?name=` | Long-poll for host work; `name` labels the claimant |
| `POST /results` | Result rows and beacons. `final: true` closes the job |
| `POST /artifacts` | Upload bytes; returns `sha256` |
| `GET /artifacts/:sha256` | Download, supports Range |

## Queue

| Method & path | Purpose |
|---|---|
| `POST /jobs` | Enqueue. 409 on duplicate `job_id`; the reply's `status` says whether it queued or is `waiting` on `depends_on` |
| `GET /jobs/:id` | Status, including `attempts`, `lease_deadline` and `last_error` |
| `POST /jobs/sweep` | Force a lease sweep now; returns what was requeued and failed |
| `POST /locks/acquire` · `POST /locks/release` | Host-executor device locks for `targets.exclusive`; device claims lock implicitly |
| `POST /events/:topic` | Publish a pipeline event; returns its id |
| `GET /events/:topic/poll?after=` | Long-poll the next event past the cursor; 204 on expiry |
| `POST /schedules` · `GET /schedules` | Upsert and list cron schedules |
| `PATCH /schedules/:id` · `DELETE /schedules/:id` | Enable, disable or remove |
| `POST /schedules/tick` | Force an evaluation; fires due schedules at most once a minute |
| `POST /power/:pool/:state` | Fire a pool's smart-plug webhook |

## Read API

Every endpoint is `GET` and side-effect free.

| Endpoint | Purpose |
|---|---|
| `GET /api/overview` | Everything the Overview screen needs, in one call (cached 2 s; `?fresh=1` bypasses) |
| `GET /api/health` | Uptime, node version, instance id, connected dashboards, whether the guard is on |
| `GET /api/system` | Database, artifact and log sizes, row counts, CI armed state, power pools, paths |
| `GET /api/devices` | Registry with derived `online`/`stale`/`offline`, current job, lock, flattened beacon |
| `GET /api/devices/:id` | Descriptor, job history, latest benchmarks, counts |
| `GET /api/devices/:id/beacons?hours=24` | Beacon history for the battery and thermal charts |
| `GET /api/jobs` | Filters, paging, sorting; returns status facets |
| `GET /api/jobs/:id` | Spec, results, beacons, artifacts, locks, fan-out family, status report |
| `GET /api/results` | Filters: `job`, `device`, `workload`, `final`, `ok`, `from`, `to` |
| `GET /api/results/bench` | Latest passing run per device per configuration, with history for trends |
| `GET /api/results/ui` | Per-run verdicts plus a build × device matrix with flaky detection |
| `GET /api/results/vision` | Accuracy and latency per model per device; flags inferred values |
| `GET /api/results/drain` · `/soak` · `/thermal` · `/cold-start` | The per-workload views |
| `GET /api/results/recent` | Newest rows with a one-line summary |
| `GET /api/evals` · `GET /api/evals/:input_sha` | Eval sets pivoted by model and device |
| `GET /api/schedules` | Schedules with computed `next_run` and missed-fire detection |
| `GET /api/artifacts` | Store listing with on-disk state and reference counts |
| `GET /api/visual/baselines` · `/suites` · `/matrix?suite=` | Accepted baselines and the review grid |
| `GET /api/locks` | Held locks and how long they have been held |
| `GET /api/executors` | Host-executor liveness, derived from their long-poll traffic |
| `GET /api/enroll` | Addresses a device can reach this collector on, the newest runner build, who is enrolled |
| `GET /api/alerts?state=` | Current alerts |
| `GET /api/status-reports` | The commit-status audit trail, posted or not |
| `GET /api/stream` | SSE |

### `/api/stream` carries a nudge, not a payload

An event says "this changed" and the client refetches. A dropped or duplicated
event therefore costs a redundant GET, never a wrong screen. The `hello` frame
carries an `instance` id; a change in it means the collector restarted and
clients should refetch everything.

Topics: `job`, `device`, `beacon`, `result`, `lock`, `schedule`, `artifact`,
`pipeline-event`.

## Mutations

| Endpoint | Purpose |
|---|---|
| `POST /api/jobs` | Enqueue; forwards to `POST /jobs` so validation and fan-out have one implementation |
| `POST /api/jobs/:id/cancel` · `/retry` | Cancel, or clone the spec under `<id>-r2` |
| `PATCH /api/jobs/:id` | Set `priority` |
| `POST /api/jobs/preview-targets` | "N devices match", using the matcher fan-out uses |
| `PATCH /api/devices/:id` | Name, notes, pool override (`pools: null` clears it) |
| `DELETE /api/devices/:id` | Forget a device; refuses while it is running a job |
| `POST /api/devices/:id/release-lock` | Drop a stuck lock |
| `POST /api/visual/baselines/accept` | Set the baseline for (suite, page, profile) |
| `GET /api/artifacts/gc-candidates?days=` | Artifacts nothing references |
| `DELETE /api/artifacts/:sha256` | Delete one; refuses while referenced or pinned |
| `POST /api/artifacts/:sha/pin` | Pin with a **reason** — a pin with no reason is one nobody will dare remove |
| `POST /api/system/sweep` · `/scheduler-tick` · `/retention` | Force a pass; retention dry-runs unless `dry_run: false` |
| `POST /api/alerts/:id/ack` · `/snooze` · `POST /api/alerts/tick` | Quiet one alert, or force an evaluation |

### Cancelling does not reach into the device

The row goes to `cancelled`, which means the runner's next beacon returns
`lease_renewed: false` — the same signal a swept lease produces, which runners
already handle. Work in flight finishes; nothing new starts.

A cancelled job is deliberately **not** `failed`. The overview's failure counts
and every alert built on them would otherwise count deliberate stops as
breakage.

### Pool edits go to a different column

Stored in `devices.pools_override`, not `pools`. The runner rewrites `pools` on
every registration, so an edit sharing that column would be gone within the
minute. Effective pools are the override when set, otherwise the runner's
report; both stay visible in `GET /api/devices`.

## The guard

`FLEET_DASH_TOKEN` guards every mutation above: set it and the dashboard must
send `X-Fleet-Token`.

**It is deliberately unset on the reference deployment.** The collector is LAN
and tailnet only, `POST /jobs` is open anyway so `curl` and CI keep working, and
the token buys protection against a stray browser tab at the cost of a paste in
every browser — not a trade worth making on a home network. It is a speed bump,
not an access control. [The network is the access
control](deploy/index.md#binding-and-exposure).

The dashboard notices on its own: `/api/health` reports `guard`, and a banner
asks for the token rather than letting an ordinary action fail on it.
