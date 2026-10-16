# HTTP API

Three audiences. **Scripts, CI, the CLI and AI agents** use the control API
under `/api/v1`. **Runners** use [the protocol](protocol.md), and that is the
only part a runner needs. **The dashboard** uses the unversioned `/api/*`
routes described further down, which predate `/api/v1`.

## Control API (`/api/v1`)

The machine-readable description is served at `GET /api/v1/openapi.json`
(OpenAPI 3.1) and committed as `collector/openapi.json`. One route table
(`collector/src/api/v1/routes.ts`) registers the routes, writes that document
and generates the typed client in `collector/src/client/`, so the three cannot
disagree: the test suite fails if they do.

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/v1/health` | none | Version, auth mode, `api: "v1"` |
| `GET /api/v1/whoami` | none | Who the collector thinks you are, and your scopes |
| `GET /api/v1/devices` · `/devices/{id}` | read | The shelf, with status (`online`, `stale`, `offline`) and current job |
| `GET /api/v1/workloads` · `/workloads/{name}` | read | What the fleet can run: executor, params schema, a valid example spec, how many live agents can take it |
| `GET /api/v1/templates` | read | Saved job templates |
| `GET /api/v1/jobs` | read | Jobs; filter by `status` (`waiting`, `queued`, `claimed`, `done`, `failed`, `cancelled`, `skipped`), `workload`, `executor` (`device` or `host`), `device`, `pool`, `source`, `requested_by`, `mine=true`, `q` (substring of the job id), `from`/`to` |
| `POST /api/v1/jobs` | run | Enqueue. 201 with the job id, its status, and links to its summary and wait URLs. 422 `no_capable_agent` when no live agent declares the workload (or backend); 400 `no_matching_devices` for a fan-out that matches nothing, and 400 `no_build` when `latest` names no published build |
| `POST /api/v1/jobs/validate` | run | Dry run: schema errors by path, the devices it would land on, warnings. Always 200 |
| `GET /api/v1/jobs/{id}` | read | One job, with its spec |
| `GET /api/v1/jobs/{id}/summary` | read | The verdict across every device, per-device outcomes and artifact refs. Works for a fan-out parent |
| `GET /api/v1/jobs/{id}/wait?timeout_s=` | read | Long-poll (≤ 120 s) until the job finishes; returns the summary |
| `POST /api/v1/jobs/{id}/cancel` · `/retry` | run | Cancel (cascades over a fan-out) or run again under a new id |
| `GET /api/v1/results` · `/results/flaky` | read | Result rows (`include=payload` for the raw row), and tests whose verdict flips on one build |
| `GET /api/v1/artifacts/{sha256}` · `/content` | read | What an artifact is, and its bytes. Active types (HTML, SVG) are served as attachments with a sandbox CSP |
| `GET /api/v1/schedules` · `/alerts` | read | Recurring jobs and open alerts |
| `GET /api/v1/audit` | admin | Who did what, when tokens are on |
| `GET /metrics` | read | The fleet in Prometheus text format: devices by status, jobs by status, oldest queued job, per-device success ratio over 24 h, open alerts, artifact counts. Computed from the database on each scrape. Not under `/api/v1` and not in the OpenAPI document |

**Lists** are `{items, page, per_page, total, pages}` with `page` and
`per_page` (≤ 500) query parameters.

**Errors** are `{error: {code, message, hint?, details?}}`. `code` is one of
`bad_request`, `invalid_spec`, `not_found`, `duplicate_job`,
`no_capable_agent`, `no_matching_devices`, `secret_in_spec`, `no_build`,
`invalid_match`, `invalid_dependency`, `unresolved_reference`, `conflict`,
`unauthorized`, `insufficient_scope`, `forbidden`, `rate_limited`, `internal`.
`hint` says what to do next, for a person or an agent.

**Job specs are validated strictly** against `job.schema.json`: an unknown
top-level field is refused rather than ignored, so a typo is an error and not
a setting that silently did nothing. A workload's params are checked against
its manifest. This is `/api/v1/jobs` (and so `fleetr run`) only: the legacy
`POST /jobs` and `POST /api/jobs` do not refuse unknown fields.

**Verdicts** in a summary: `passed`, `failed`, `mixed`, `skipped` (nothing
ran, never folded into passed), `cancelled`, and while unfinished `queued`,
`waiting` or `running`.

**Job statuses** are `waiting`, `queued`, `claimed`, `done`, `failed`,
`cancelled` and `skipped`. `skipped` means the job was claimed and nothing ran
(its runner said `skipped:`, or a dependency skipped); `last_error` says why.
A skipped job's summary verdict is `skipped`, as it always was; before 0.9 its
status said `done`. A fan-out family's `status` is `skipped` when no child ran.
See [Skipped is not done](concepts.md#skipped-is-not-done).

**Who asked.** Every job records `requested_by` and `source` (`cli`, `mcp`,
`ci`, `dash`, `schedule`, `api`). With auth off both are what the caller said, labelled
unverified; with tokens on, `requested_by` is the token's name, or the person a
`delegate` token names in `X-Fleet-Actor`. See [Authentication](deploy/auth.md).

**The older routes are deprecated, not removed.** `GET /api/devices`,
`GET /api/devices/{id}`, `GET /api/jobs`, `GET /api/jobs/{id}`,
`GET /api/results`, `GET /devices`, `GET /schedules`, `GET /jobs/{id}` and
`POST /jobs` · `/api/jobs` answer with `Deprecation` (RFC 9745) and a
`Link: <...>; rel="successor-version"` header. Only those exact routes carry
the headers: `/api/devices/{id}/beacons`, `/api/results/bench` and the rest of
the dashboard's read API do not. There is no sunset date. The runner protocol is
not deprecated.

Timestamps are ISO-8601 **UTC with a `Z`**. SQLite stores
`YYYY-MM-DD HH:MM:SS` with no zone marker, which JavaScript parses as local
time, so the API normalises rather than leaving each client to get it wrong.
Every list is bounded.

## Agent API

Not guarded by `FLEET_DASH_TOKEN`, with the one exception marked below — the fleet has to keep running whether or
not anyone has a token in a browser. Open by default even with
`FLEET_AUTH=tokens`; with `FLEET_AUTH_PROTOCOL=token` as well, every call here
needs a token with the `agent` scope (a `read` token may still download
artifacts). See [the protocol](protocol.md#authentication-optional) and
[Authentication](deploy/auth.md).

| Method & path | Purpose |
|---|---|
| `POST /devices/register` | Device checks in with descriptor, pools and capabilities (upsert) |
| `GET /devices/:id/next-job` | Long-poll (~25 s) for device work; 204 when none |
| `GET /executor/next-job?name=` | Long-poll for host work; `name` labels the claimant |
| `POST /results` | Result rows and beacons. `final: true` closes the job |
| `POST /artifacts` | Upload bytes; returns `sha256` |
| `GET /artifacts/:sha256` | Download, supports Range |
| `POST /findings` | An `explore` finding from an executor; merged on its fingerprint. See [Findings and verdicts](explore/findings.md#the-api) |
| `POST /api/jobs/:id/mirror` | One raw JPEG frame from an executor driving a device, for the live view. Kept in memory only (the last three frames), never stored; 2 MB cap per frame. The one row here that `FLEET_DASH_TOKEN` does guard; the `explore` workload sends it |

## Queue

With `FLEET_AUTH=tokens`: `POST /jobs` needs `run`; `/jobs/:id/release`,
`/locks/*` and `/events/*` are runner protocol, so they follow
`FLEET_AUTH_PROTOCOL` like the table above; any other GET needs `read` and
anything else `admin`. With auth off, all of it is open.

| Method & path | Purpose |
|---|---|
| `POST /jobs` | Enqueue. 409 on duplicate `job_id`; the reply's `status` says whether it queued, is `waiting` on `depends_on`, or was closed on arrival as `failed` or `skipped` because a dependency already was |
| `GET /jobs/:id` | Status, including `attempts`, `lease_deadline` and `last_error` |
| `POST /jobs/sweep` | Force a lease sweep now; returns what was requeued and failed, and the simulator rows it forgot (offline past `FLEET_SIMULATOR_TTL_DAYS`, default 7) |
| `POST /jobs/:id/release` | The claimant hands a job back before starting it. Returns it to `queued` and **refunds the attempt**; 409 once any result exists. See [the protocol](protocol.md#handing-a-job-straight-back) |
| `POST /locks/acquire` · `POST /locks/release` | Host-executor device locks for `targets.exclusive`; device claims lock implicitly |
| `POST /events/:topic` | Publish a pipeline event; returns its id |
| `GET /events/:topic/poll?after=` | Long-poll the next event past the cursor; 204 on expiry |
| `POST /schedules` · `GET /schedules` | Upsert and list cron schedules |
| `PATCH /schedules/:id` · `DELETE /schedules/:id` | Enable, disable or remove |
| `POST /schedules/tick` | Force an evaluation; fires due schedules at most once a minute |
| `POST /power/:pool/:state` | Fire a pool's smart-plug webhook |
| `GET /devices` | The raw registry: descriptor, pools, capabilities, last beacon. Deprecated; `GET /api/v1/devices` replaces it |
| `GET /status-reports` | The last 100 commit-status rows, raw. `GET /api/status-reports` is the dashboard's version |

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
| `GET /api/jobs` | Filters (`status` takes `skipped` too), paging, sorting; returns status facets, `skipped` among them |
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
| `GET /api/artifacts/:sha256` | A 308 to `/api/v1/artifacts/:sha256/content`, the bytes; 404 when nothing by that hash was ever uploaded. Before 0.9 this answered "no such endpoint", which read as a missing artifact |
| `GET /api/visual/baselines` · `/suites` · `/matrix?suite=` | Accepted baselines and the review grid |
| `GET /api/locks` | Held locks and how long they have been held |
| `GET /api/executors` | Host-executor liveness, derived from their long-poll traffic |
| `GET /api/enroll` | Addresses a device can reach this collector on, the newest runner build, who is enrolled |
| `GET /api/alerts?state=` | Current alerts |
| `GET /api/peers` | Other brains this one knows about, with liveness and device counts |
| `GET /api/peers/:id/*` | One peer's read API, fetched server to server. GET only, and only the endpoints on an allow-list |
| `GET /api/status-reports` | The commit-status audit trail, posted or not |
| `GET /api/templates` | Saved job templates, with their specs |
| `GET /api/events` · `/api/events/:topic?limit=` | Pipeline-event topics with counts, and one topic's newest events (≤ 500) |
| `GET /api/jobs/:id/mirror` · `/mirror/status` | The live view of a host job as an MJPEG stream (404 when nothing is streaming), and whether a stream exists without opening it |
| `GET /api/stream` | SSE |

### `/api/stream` carries a nudge, not a payload

An event says "this changed" and the client refetches. A dropped or duplicated
event therefore costs a redundant GET, never a wrong screen. The `hello` frame
carries an `instance` id; a change in it means the collector restarted and
clients should refetch everything.

Topics: `job`, `device`, `beacon`, `result`, `lock`, `schedule`, `artifact`,
`pipeline-event`.

## Findings

From the [`explore`](explore/index.md) workload. Full shapes and replies are in
[Findings and verdicts](explore/findings.md#the-api).

| Method & path | Purpose |
|---|---|
| `GET /api/findings` | The list: `?app= &check= &status=open\|triaged\|all &since= &limit=` |
| `GET /api/findings/:id` | One finding, with its duplicates |
| `GET /api/findings/precision` | How often each check and visual class was judged real; which are switched off |
| `GET /api/findings/digest?hours=` | The morning digest, as text and as data |
| `GET /api/findings/issues` | Every GitHub issue composed, dry run or filed |
| `POST /api/findings/:id/verdict` | Real, duplicate, not a bug, agent's mistake, or reopen. Guarded |

## Mutations

With `FLEET_AUTH=tokens`, `POST /api/jobs`, `/api/jobs/preview-targets` and
`/api/jobs/:id/cancel` · `/retry` need `run`, and unlike their `/api/v1`
equivalents they do not check that the job is yours (see
[Authentication](deploy/auth.md#tokens-on-the-collector)). The GET here needs
`read`, `/api/session` needs no token up front, and everything else needs
`admin`.

| Endpoint | Purpose |
|---|---|
| `POST /api/jobs` | Enqueue; forwards to `POST /jobs` so validation and fan-out have one implementation |
| `POST /api/jobs/:id/cancel` · `/retry` | Cancel, or clone the spec under `<id>-r2` (body may set `pool`, `device_id`, `priority`) |
| `PATCH /api/jobs/:id` | Set `priority` |
| `POST /api/jobs/preview-targets` | "N devices match", using the matcher fan-out uses |
| `PATCH /api/devices/:id` | Name, notes, pool override (`pools: null` clears it) |
| `DELETE /api/devices/:id` | Forget a device; refuses while it is running a job |
| `POST /api/devices/:id/release-lock` | Drop a stuck lock |
| `POST /api/templates` · `DELETE /api/templates/:id` | Save a job template (`id`, `name`, `spec` without a `job_id`), or delete one |
| `POST /api/schedules` · `PATCH` · `DELETE /api/schedules/:id` | Forwarded to `/schedules` |
| `POST /api/schedules/:id/run` | Fire one schedule now, as `<id>-manual-<timestamp>`, without touching its own next firing |
| `POST /api/power/:pool/:state` | Forwarded to `POST /power/:pool/:state` |
| `POST /api/session` · `DELETE /api/session` | Exchange a token for the dashboard's read-only cookie, or clear it. See [Authentication](deploy/auth.md#tokens-on-the-collector) |
| `POST /api/visual/baselines/accept` | Set the baseline for (suite, page, profile) |
| `GET /api/artifacts/gc-candidates?days=` | Artifacts nothing references |
| `DELETE /api/artifacts/:sha256` | Delete one; refuses while referenced or pinned |
| `POST /api/artifacts/:sha/pin` | Pin with a **reason** — a pin with no reason is one nobody will dare remove |
| `POST /api/system/sweep` · `/scheduler-tick` · `/retention` | Force a pass; retention dry-runs unless `dry_run: false` |
| `POST /api/alerts/:id/ack` · `/snooze` · `POST /api/alerts/tick` | Quiet one alert, or force an evaluation |

### Peers are read, and read through this collector

`GET /api/peers/:id/*` proxies rather than letting the browser call the other
brain directly, and that is a security decision rather than a convenience.
There is no authentication by default (see [Authentication](deploy/auth.md)):
opening the read API cross-origin would let any website in the operator's
browser read their whole fleet from any tab. With `FLEET_AUTH=tokens` the proxy
needs `read` like any other GET. It sends no token to the peer, so a peer that
has tokens on answers 401 through it. The
proxy keeps one origin, one token, and one place that decides what may be
asked for — an **allow-list** of endpoints, because the failure of a deny-list
is that the next endpoint somebody adds is exposed by default.

Peers are addressed by their stable id, not by URL, so a link cannot be turned
into a request to an arbitrary host by editing the address bar. The id selects
from the configured list; it does not address.

Nothing is proxied that mutates. Enqueueing on another brain means switching to
it, which navigates to that brain's own dashboard — one origin, one owner of
that queue, and no question about which fleet a button just acted on.

### Cancelling does not reach into the device

The row goes to `cancelled`, which means the runner's next beacon returns
`lease_renewed: false` — the same signal a swept lease produces, which runners
already handle. Work in flight finishes; nothing new starts.

A cancelled job is deliberately **not** `failed`. The overview's failure counts
and every alert built on them would otherwise count deliberate stops as
breakage. A skipped one is not `done` either, for the mirror-image reason: the
overview counts it on its own (`queue.skipped_24h`).

### Pool edits go to a different column

Stored in `devices.pools_override`, not `pools`. The runner rewrites `pools` on
every registration, so an edit sharing that column would be gone within the
minute. Effective pools are the override when set, otherwise the runner's
report; both stay visible in `GET /api/devices`.

## The guard

`FLEET_DASH_TOKEN` guards every mutation above: set it and the dashboard must
send `X-Fleet-Token`. With `FLEET_AUTH=tokens` it steps aside: the scoped token
has already been checked, and every mutation needs `run` or `admin` (see
[Authentication](deploy/auth.md)).

**It is deliberately unset on the reference deployment.** The collector is LAN
and tailnet only with auth off, `POST /jobs` is open then anyway so `curl` and
CI keep working, and
the token buys protection against a stray browser tab at the cost of a paste in
every browser — not a trade worth making on a home network. It is a speed bump,
not an access control. [The network is the access
control](deploy/index.md#binding-and-exposure).

The dashboard notices on its own: `/api/health` reports `guard`, and a banner
asks for the token rather than letting an ordinary action fail on it.
