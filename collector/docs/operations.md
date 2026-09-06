# Operating the collector has moved

The reference manual now lives on the documentation site, split into pages
rather than one 900-line file:

**<https://addisdev.github.io/fleet-runner/>**

| Was | Now |
|---|---|
| The workloads in detail | [Workloads](https://addisdev.github.io/fleet-runner/workloads/) |
| Capabilities, targeting, constraints, leases, chains, fan-out, preemption | [Concepts](https://addisdev.github.io/fleet-runner/concepts/) |
| Endpoints, the read API, mutations, the guard | [HTTP API](https://addisdev.github.io/fleet-runner/api/) |
| Where it runs, launchd, the host executor, schedules, energy | [Deploy](https://addisdev.github.io/fleet-runner/deploy/) |
| The SSH tunnel, network shaping | [Networking](https://addisdev.github.io/fleet-runner/deploy/networking/) |
| The iOS executor on the workstation | [The iOS executor](https://addisdev.github.io/fleet-runner/deploy/ios-executor/) |
| Alerts and the regression rules | [Alerts](https://addisdev.github.io/fleet-runner/deploy/alerts/) |
| Dashboard, naming devices, adding a device | [The dashboard](https://addisdev.github.io/fleet-runner/dashboard/) |
| CI integration | [Wire in your app](https://addisdev.github.io/fleet-runner/integration/) |

The agent-facing contract, which had no page of its own before, is now
[The protocol](https://addisdev.github.io/fleet-runner/protocol/).

The source is in [`docs/`](../../docs) at the repository root, which is what the
site is built from.

## What was dropped rather than moved

The "Phase 0 scope notes" at the end of the old file, which said there was no
scheduler and that `targets.match` was not enforced. Both had been untrue for
months — the scheduler runs the nightlies and `targets.match` is what the
schedules target with.
