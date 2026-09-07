# Fleet Runner

A shelf of old phones, turned into a device lab you can send work to.

One queued job installs a build on every attached device, runs a UI suite
across them, benchmarks llama.cpp on real silicon, classifies a few hundred
images through Core ML and LiteRT, screenshots a website on two real phone
screens and diffs it against a baseline, or drains a battery on purpose and
plots the curve. Everything lands in one results database with one dashboard
in front of it.

![How it fits together: agents on the shelf, a machine runner and a browser runner speak one JSON protocol to the collector, which holds the queue, registry, leases, artifacts, results and scheduler and serves the dashboard; a host executor on a Mac claims host jobs and drives the shelf from outside](img/architecture.png)

## Start here

<div class="grid cards" markdown>

-   __[Get started](getting-started.md)__

    ---

    A collector and a laptop agent, a real job, and a result you can look at.
    Fifteen minutes, Node and nothing else.

-   __[Concepts](concepts.md)__

    ---

    How the queue thinks: device and host jobs, leases, capabilities,
    constraints, chains, fan-out and preemption.

-   __[Workloads](workloads/index.md)__

    ---

    All 28 of them, what each measures, and what each refuses to guess.

-   __[The protocol](protocol.md)__

    ---

    Register, long-poll, claim, beacon, report. Enough to write a runner in a
    language none of ours are in.

-   __[Wire in your app](integration/index.md)__

    ---

    Publish builds on merge, run a nightly on your own devices, block a pull
    request on the verdict.

-   __[Deploy](deploy/index.md)__

    ---

    Where the services live, running them under launchd or systemd, and the
    networking that bites.

</div>

## How it fits together

**Device jobs** are claimed by the agent on the device itself. **Host jobs** are
claimed by an executor on a Mac and drive a device from outside, because
installing an APK or tapping through a UI test is not something an app can do
to itself.

The runners share a protocol, not code — including a synthetic SHA-256
benchmark that is identical on every platform token for token. That is what
lets a 2019 Android phone, a current iPhone and a laptop produce numbers you
can put in the same table, which is the difference between a fleet and a pile
of phones.

## A warning worth reading before you deploy anything

**There is no authentication, by design.** The collector is meant for a home
LAN or a tailnet, and anyone who can reach it can enqueue a job. This is stated
as a posture rather than apologised for, and [the security
policy](https://github.com/addisdev/fleet-runner/blob/main/SECURITY.md)
describes what that does and does not cover. Do not put it on the internet.

## Where things live

The code is one repository with four components that ship independently and
share no code, only the protocol:
[`collector/`](https://github.com/addisdev/fleet-runner/tree/main/collector),
[`runner-android/`](https://github.com/addisdev/fleet-runner/tree/main/runner-android),
[`runner-ios/`](https://github.com/addisdev/fleet-runner/tree/main/runner-ios) and
[`runner-machine/`](https://github.com/addisdev/fleet-runner/tree/main/runner-machine).

[The history section](history/index.md) keeps the original architecture plan and
the design journals as they were written. They are not maintained, and they are
kept because the reasoning in them is why the thing is shaped as it is.
