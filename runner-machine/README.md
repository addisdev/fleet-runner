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

| Workload | Backend | What it does |
|---|---|---|
| `benchmark` | `synthetic` | SHA-256 CPU throughput, identical to the Android and iOS runners' — hardware numbers, never LLM numbers |
| `benchmark` | `llama.cpp` | Model fetched by content hash and verified, then `llama-bench`: prefill/decode tok/s, load time, peak memory with the method named |

Capabilities are declared only when honest: `benchmark:llama.cpp` needs a resolvable `llama-bench`,
`benchmark:mlx` needs `import mlx_lm` to exit 0, and a machine with neither still declares `benchmark`.

## Status

Registration, beaconing, cancellation, sleep/wake and the synthetic backend are verified end to end
against a throwaway collector. The llama.cpp backend is unit-tested against llama-bench's documented
JSON shape but never run against a real binary; the Windows probes are untested on Windows;
`benchmark:mlx` has no backend yet; and off Linux `mem_method` says `max_rss`, a value the
collector's result schema does not list, because calling an RSS reading `pss` would be laundering.

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
