# Adding devices

`fleet up` gives you a brain and one device -- the machine it is running on.
This page is how everything else joins it.

**Read [Platforms](../platforms.md) before you trust any of this.** That page
carries the honest column: which of these have actually been watched to register
against a real collector, which only build, and which have never been compiled.
It is not repeated here, because a list that says "supported" in two places and
"never run" in one is a list that will drift.

The short version of the joining problem: a phone can be typed at, a television
cannot, and a Roku has five buttons. Everything below is an answer to that.

## The address is the hard part

Every runner needs one fact -- the collector's URL -- and typing
`http://fleet-host.local:8788` on a television remote is about forty button
presses with no way to paste. So there are four ways to deliver it, in
descending order of how pleasant they are:

| | How the URL arrives | Works on |
|---|---|---|
| **QR code** | The dashboard's Enrol screen draws one; the device's camera reads it | Phones, tablets, anything with a camera and a browser |
| **Launch parameter** | Pushed to the device from a machine that has a keyboard | Roku, over ECP |
| **mDNS discovery** | The agent finds the brain on the local network | `fleet join --discover`, and the desktop app |
| **Typing it** | Somebody types it | Everything, badly |

### Finding a brain instead of typing one

```bash
fleet join --discover
```

looks for a brain on the local network over mDNS, and joins the one it finds.
More than one and it lists them and asks you to pick with `fleet join <url>`.

**The brain has to be advertising, and it is not by default:**

```bash
fleet config set collector.discovery true
```

Off by default because a collector should not start announcing itself on
somebody's office network because they upgraded. mDNS is link-local by
construction, so a collector bound to a tailnet address is not advertised across
it and nothing about the deployment posture changes.

The dependency (`bonjour-service`) belongs to the collector only. The machine
agent keeps its "Node 22 and nothing else" promise, because the browsing lives
in `fleet`.

## Android phones, tablets, TV sticks, headsets and watches

One APK, every shape.

```bash
cd runner-android
./gradlew :app:installDebug
adb reverse tcp:8788 tcp:8788   # the device reaches your Mac over USB
```

Open the app, keep `http://127.0.0.1:8788`, and tap **Start agent**. To let the
device leave your desk, set the collector URL to the host's address on your
network instead and drop the `adb reverse`.

For a Fire TV, an Android TV box or a Google TV, `adb connect <ip>` first and
then the same `adb install`. Nothing about the app differs -- what made TVs work
was three manifest declarations, not a second build: a leanback launcher
category (without which the APK installs perfectly and then cannot be started
from the remote, which reads as "it does not work on TV" and is really "there is
no icon"), a TV banner, and touchscreen declared not-required (without which
installers filter the app out entirely).

Building the app needs the Android SDK. Building the *native* llama.cpp backend
also needs NDK 27.2 and the submodule, and takes about fifteen minutes -- you do
not need it for the synthetic backend.

What each shape actually declares, and which have been run, is
[Platforms](../platforms.md#android-one-apk-every-shape).

## iPhone, iPad, Apple TV

```bash
cd runner-ios
brew install xcodegen
./generate.sh
xcodebuild -project FleetRunner.xcodeproj -scheme FleetRunner \
  -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/FleetRunner.app
xcrun simctl launch booted com.taylab.fleetrunner -autostart 1
```

A fresh clone builds with nothing else installed. What you get is the synthetic
and Core ML backends; the llama.cpp workloads report that their backend is
unavailable, which is the honest answer rather than a wrong number.

A simulator reaches `127.0.0.1` directly because it shares the Mac's network
stack. A real device needs the host's address on your network -- its `.local`
name, or its tailnet address if you run one.

Apple TV is the `FleetRunnerTV` scheme in the same project, from the same
sources: two conditions rather than a fork. It **builds**, and no Apple TV has
run it. visionOS is written and has never been compiled. See
[Platforms](../platforms.md#apple-one-source-several-products) for both, and for
why a television reports 100% battery and charging.

## Roku players and Roku TVs

Developer mode first, on the remote: **Home ×3, Up ×2, Right, Left, Right, Left,
Right**. Then, from a machine with a keyboard:

```bash
security add-generic-password -s fleet-roku-dev -a rokudev -w   # once, prompts

cd runner-roku
./build.sh --install 192.168.1.44 --launch http://fleet-host.local:8788 --device-id roku-den
```

That packages the channel, installs it over ECP, and launches it **with the
collector URL as a launch parameter** -- which is the whole point, because a
Roku's only input is a five-way pad. The channel writes `fleet_url` and
`device_id` to the registry, so every later launch needs no parameters at all.
There is a keyboard behind the OK button as a fallback, and it is a fallback.

Two things to know before you read a number off a Roku:

- **It declares `benchmark:roevp`, not `benchmark`.** A job asking for
  `backend: "synthetic"` is refused with a sentence rather than served a
  `roevp` number under that name. The rate measures BrightScript's interpreter
  dispatch as much as the SoC, so it compares with other Rokus and nothing else.
  The *correctness* is the fleet's: it reports `synthetic_digest`, so
  conformance clause 4 proves the arithmetic is identical.
- **Size the job explicitly.** The default `prompt_tokens` of 512 is 512,000
  interpreted folds. On a phone that is seconds; on a Roku nobody has measured
  one, and it could be many minutes per iteration.

**None of this has ever run.** The channel has never been compiled either --
BrightScript's only compiler is inside a television and no emulator exists.
[Roku: the one that could not be compiled](../platforms.md#roku-the-one-that-could-not-be-compiled)
and [`runner-roku/README.md`](https://github.com/addisdev/fleet-runner/tree/main/runner-roku)
are the two places that say exactly which claims are untested.

## Any browser at all

```
http://<collector>:8788/runner
```

Opening that page enrols the browser that opened it. No build step, no install,
no signature -- which is the only way a smart TV's built-in browser, a games
console, a Chromebook, a Kindle or an iPad too old for the App Store is ever
going to join anything. The dashboard's Enrol screen draws a QR code pointing at
it, which is how it reaches a phone in somebody's hand.

It declares `benchmark:jssha` and `benchmark:webcrypto`, and deliberately not
`benchmark:synthetic`, for the same reason the Roku declares `roevp`. It
registers with a `ttl_s`, so a tab that is *closed* leaves the shelf rather than
sitting there forever as an offline device nobody can find.

This one **has** been driven end to end by a real Chromium against a real
collector, both backends, digest checked. See
[Platforms](../platforms.md#the-browser-the-one-with-no-install).

## A machine that is already running something

Any laptop, desktop, Pi or NAS can be a device on a brain that lives elsewhere:

```bash
fleet join http://fleet-host.local:8788
```

That runs the agent role only and writes the collector down, so the next
`fleet up` remembers it. It is a fleet device in its own right, not a stand-in
for one -- a laptop's tok/s and a phone's land in the same table.

### And it can belong to more than one fleet

A laptop can be a device on the fleet at home and on the one at work. Two people
with two collectors can share a shelf.

What that deliberately is **not**: collectors do not share a database, forward
jobs, replicate results, or elect anything. A job enqueued on brain A is A's job
and lands in A's database, whatever device ran it.

All of multi-homing is on the device side, and it is one rule: **a device runs
one job at a time, whoever asked.** Two benchmarks at once produce two numbers
that are both wrong. Three mechanisms enforce it -- a claim gate on the agent,
`busy` on the beacon so other queues stop offering at all, and
`POST /jobs/:id/release` to hand back a job won by a poll that had already been
answered.

The machine agent implements all three. The Roku channel implements none of
them, deliberately: it registers with exactly one brain, and one poll loop that
does not ask again until the job it is running has returned is the same rule made
structural. Conformance clause 9 checks the observable half of this and is
skipped for almost every agent, which is correct -- a runner registered with one
collector has nothing to get wrong there.

## Then check it arrived

```bash
fleet status
curl -s http://127.0.0.1:8788/api/devices
```

or open the dashboard's Devices screen, which draws a television, a watch, a
headset, a board and a browser tab rather than drawing everything as a phone --
because the agent declares its `platform` and `kind` rather than having them
guessed from an `os` string.

A device that is busy for *another* collector reads `busy · <that brain's
address>` there rather than `idle`, with the job id on hover. `idle` was the one
thing it was not, and it is the reading that sends somebody off to debug a queue
that is working perfectly.

## Writing one that is not on this list

Six hand-written implementations of one protocol and no shared library, on
purpose. [Writing a runner](../writing-a-runner.md) is the guide, [the
protocol](../protocol.md) is the five calls, and
`npm run conformance -- --device <id>` is the nine clauses that keep them
honest -- every one of them something that has actually gone wrong here.
