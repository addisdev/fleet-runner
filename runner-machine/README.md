# fleet-runner-machine

The desktop half of **Fleet Runner**, a personal device lab: a Node agent that turns a laptop or
desktop into a node the [collector](../collector) can send work to.
It reimplements the phone runners' JSON protocol rather than importing the collector's helpers,
and its synthetic SHA-256 backend is theirs token for token — which is what makes a laptop's
tok/s comparable to a phone's. And a machine can be scheduled around: `require_ac`,
`require_idle_s` and `max_load` read its beacon, so work waits for an idle box on mains.

## Run it

Needs Node 22 or newer, nothing else. It registers as `machine-<hostname>`
(`FLEET_DEVICE_ID` overrides).

```bash
npm install
FLEET_URL=http://fleet-host.local:8788 npm start   # npm test for the suite
deploy/install-agent.sh com.addisdev.fleet-runner-machine.plist   # or the .service
```

## What it runs

| Workload | Backend / kind | What it does |
|---|---|---|
| `benchmark` | `synthetic` | SHA-256 CPU throughput, identical to the Android and iOS runners' — hardware numbers, never LLM numbers |
| `benchmark` | `llama.cpp` | Model fetched by content hash and verified, then `llama-bench`: prefill/decode tok/s, load time, peak memory with the method named |
| `build` | `gradle`, `xcode`, `npm` | Checks out `params.ref`, builds it, and publishes the product as the app's latest build. Reports `build_s` and `artifact_bytes` |
| `self-check` | — | Disk, tool versions, NTP offset and whether the installed agent is the one running. Reports `disk_free_gb`, `clock_offset_ms`, `checks_failed` plus a per-check breakdown |

Capabilities are declared only when honest: `benchmark:llama.cpp` needs a resolvable `llama-bench`,
`benchmark:mlx` needs `import mlx_lm` to exit 0, `build:gradle`/`build:xcode`/`build:npm` each need
their binary (`gradle`, `xcodebuild`, `node`) to resolve, and a machine with none of it still
declares `benchmark` and `self-check`, both of which need nothing installed.
Bare `build` rides along with any kind — the collector matches a claim on the workload name and a
build's kind lives in `params` where `capabilityMatches` cannot see it, so a machine declaring only
`build:gradle` would never claim a build at all.

### `build`

```json
{ "workload": "build", "executor": "device",
  "params": { "repo": "git@github.com:you/app.git", "ref": "main", "kind": "gradle",
              "task": "assembleRelease", "app": "app-android" } }
```

`kind: "xcode"` needs `scheme` instead of `task` and takes optional `configuration`/`destination`;
`kind: "npm"` runs `npm run <task>` (default `build`) and publishes what `npm pack` makes of it.
`artifact` names the product outright when it is somewhere the defaults do not look.

Repos are cloned once into `FLEET_CACHE_DIR/repos/<name>-<hash of the remote>` and fetched
thereafter; the cache name is hashed because two remotes can both end in `app.git`. The build's
stdout is tailed into a beacon every 30 s, which is what renews the lease under a long Xcode build.
A failure uploads the log as an **anonymous** artifact and names the failing task or scheme in
`error` — anonymous on purpose, since a log published under the app's name would become the thing a
nightly asking for `"sha256": "latest"` picks up.

Publishing is `POST /artifacts` carrying `x-artifact-app` / `x-artifact-build` /
`x-artifact-platform`. There is no `/artifacts/:sha/publish` endpoint and none is needed: those
headers are what stamp `published_at`/`publish_seq`, which is exactly the ordering the collector's
`resolveLatestBuild` reads.

`report_to.github_status` gets a `pending` at claim and a terminal state at the end, under the
context `fleet-runner/build`. The token comes from `FLEET_GITHUB_TOKEN`/`GITHUB_TOKEN` in **this
machine's** environment and never from the job spec, which the collector refuses to carry secrets
in by design. The separate context matters: the collector posts its own terminal status under
`fleet-runner`, and sharing a context would mean two writers racing over one check.

## Status

Registration, beaconing, cancellation, sleep/wake and the synthetic backend are verified end to end
against a throwaway collector, as are `build` (success, failure, log upload, publish, and
`"latest"` resolving to what was just published) and `self-check`. `build` has been exercised
against `kind: "npm"` only — the gradle and xcode command lines are unit-tested but have never run a
real compiler, and the `.app` zip path and the `xcodegen` step with them.

The llama.cpp backend is unit-tested against llama-bench's documented
JSON shape but never run against a real binary; the Windows probes are untested on Windows;
`benchmark:mlx` has no backend yet; and off Linux `mem_method` says `max_rss`, a value the
collector's result schema does not list, because calling an RSS reading `pss` would be laundering.
`self-check`'s `checks` array and `build`'s `build` block are likewise not in the collector's result
schema — the collector stores a result's whole payload, so they survive, but nothing renders them
yet.

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
