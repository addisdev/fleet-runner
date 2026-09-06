# Contributing

This is a personal project that was made public because the write-up was worth
sharing. Contributions are welcome and there is no obligation for anyone to
send any.

The most useful thing you can send is **a device report**: what your hardware
measured, what it refused, and what broke. The whole point of the project is
comparable numbers across hardware nobody has a lab full of, and every phone
that is not on this shelf is data this repository does not have.

## Running the suites

Four components, four suites. Only run the one you touched.

=== "collector"

    ```bash
    cd collector
    npm install
    npm run dash:install     # once, for the dashboard build step
    npm test
    ```

    `npm test` typechecks, builds the dashboard, checks metric names against
    the schema, validates the example job specs, then **starts its own
    collector on a kernel-assigned port with a temporary database** and runs
    the smoke suite against it. It never touches a real fleet's history, which
    is why it can be wired to `npm test` at all.

    It takes about four minutes.

=== "runner-android"

    ```bash
    cd runner-android
    ./gradlew :app:testDebugUnitTest -Pfleet.skipNative
    ```

    **`-Pfleet.skipNative` is what lets you run this with no NDK.** The arm64
    llama.cpp build takes about fifteen minutes and needs a pinned NDK, and the
    JVM tests never call into it. CI uses the same flag.

    For the native build you need the submodule and NDK 27.2:

    ```bash
    git submodule update --init --recursive
    ./gradlew :app:assembleDebug
    ```

=== "runner-ios"

    ```bash
    cd runner-ios
    brew install xcodegen
    ./generate.sh
    xcodebuild build -project FleetRunner.xcodeproj -scheme FleetRunner \
      -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath build CODE_SIGNING_ALLOWED=NO
    ```

=== "runner-machine"

    ```bash
    cd runner-machine
    npm install && npm test
    ```

    122 tests, about a second. This is the easiest component to contribute to
    and the reference implementation of the protocol.

## Things this project learned the hard way

Each of these cost somebody an evening.

**Run one `xcodebuild` per simulator.** Two concurrent test sessions against
the same simulator send each other `SIGTERM` and wedge it. A "crash" with no
`.ips` file is almost always a collision, not a bug in the app.

**Call `xcodegen` by its full path in anything non-interactive.** Homebrew's
`bin` is not on a non-interactive `PATH`, so a bare `xcodegen` over SSH or under
launchd fails in a way that looks like the project generated fine and your new
files simply did not compile. `generate.sh` already handles this.

**Regenerate the Xcode project after syncing files to another machine.** An
`rsync` that carries `*.xcodeproj` across overwrites a project generated for
that machine. Exclude it and run `./generate.sh` on the far end.

**The committed `FleetRunner.xcodeproj` is deliberately the one without the
llama.cpp framework.** Xcode treats a declared-but-missing XCFramework as a hard
error rather than something to skip, so a spec naming it unconditionally cannot
be built from a fresh clone. If you regenerate with the framework present, the
project will show as modified — do not commit that.

**A metric name that is not in `result.schema.json` is stored and unqueryable.**
Add it to the schema in the same change that emits it. This has already cost
one write-up its reproducibility: an eval's accuracy rode in `decode_tok_s`
because vision had no field of its own, and no query can reproduce those numbers
today. `npm test` fails if the schema and its mirror disagree.

**Declare a capability only when the machine can honour it.** A capability
claimed but not implemented is a job the queue hands over and the agent bounces,
which from the dashboard looks exactly like a broken workload.

## Adding a workload

You do not need a collector release. The collector accepts any workload a
registered agent declares in its capabilities. See [Add a
workload](https://addisdev.github.io/fleet-runner/integration/add-a-workload/)
and [Writing a runner](https://addisdev.github.io/fleet-runner/writing-a-runner/).

## The one thing to get right

**Say what is not true yet.**

Every workload page ends with what that workload refuses to do. Every README has
a "what works, and what does not". The integration guide says on its first
screen that the GitHub Actions path has never run on a real runner.

When you cannot measure the thing asked for, fail with a message naming what is
missing. A wrong number recorded as a result is worse than a failure, because a
failure gets investigated and a number gets believed. The iOS Simulator's GPU
returning an all-zero logits tensor — silently, with no error — is the reason
this is the first rule rather than a nice sentiment.

## Pull requests

- Branch from `develop`. `main` is the released trunk.
- Run the suite for what you touched, and say in the description what you ran.
- Update the docs in the same change. The site builds with `--strict`, so a
  broken link fails CI.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.

`ci-ok` is the only required check. It always reports, and it passes when every
component suite is green **or skipped** — a change to one runner does not build
the others.

## Dependencies

**Dependabot is deliberately limited to security alerts and security fixes.**
There is no `dependabot.yml`, which is what keeps version-bump pull requests
from burying the ones that matter. If you want to upgrade something, do it in a
change that says why.

## Code of conduct

[Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
