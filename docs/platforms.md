# Every screen is a device

What can join this fleet, what it takes, and — for each one — whether that has
actually been done or is only believed to work. The last column is the point of
the page. A list of platforms a project "supports" is worth very little; a list
that says which ones somebody has watched register is worth something.

## The shelf today

| Platform | Runner | How it joins | Verified |
|---|---|---|---|
| Android phone, tablet | `runner-android` | `adb install`, or sideload | **yes** — the original shelf |
| iPhone, iPad | `runner-ios` | Xcode, TestFlight internal | **yes** |
| iOS simulator | `runner-ios` | `simctl install` | **yes** |
| macOS, Linux, Windows | `runner-machine` | `npm start`, or a LaunchAgent / systemd unit | **macOS yes**; Linux and Windows run their test suite in CI, and neither has registered against a real collector |
| Android emulator | `runner-android` | `adb install` to the emulator | **yes** |

## What Wave 5 added

| Platform | Runner | How it joins | Verified |
|---|---|---|---|
| **Any browser** | `collector/runner-web` | open `http://<collector>/runner` | **yes** — driven end to end by a real Chromium against a real collector, both backends, digest checked |
| **Android TV, Google TV, Fire TV** | `runner-android` | `adb connect`, then `adb install` | **partly** — the built APK declares a leanback launcher and a banner, checked with `aapt2 dump badging`. No TV has run it |
| **Meta Quest** | `runner-android` | sideload via `adb` | **no** — Quest is Android 12 and reports `UI_MODE_TYPE_NORMAL`, so the runner identifies it by the VR feature flag. Never run on one |
| **Wear OS** | `runner-android` | `adb install` over Wi-Fi debugging | **no** — the watch feature flag is read and declared; never run on one |
| **Apple TV (tvOS)** | `runner-ios`, `FleetRunnerTV` target | `devicectl` or `simctl` | **builds** — `xcodebuild -scheme FleetRunnerTV` succeeds. No Apple TV has run it |
| **Vision Pro (visionOS)** | `runner-ios`, `FleetRunnerVision` target | `devicectl` or `simctl` | **no** — the target is written and has never been compiled; the visionOS platform is not installed on the machine it was written on |
| **Raspberry Pi, Jetson, Steam Deck** | `runner-machine` | `install-agent.sh`, or the Docker image | **no** — arm64 Linux runs the suite in CI, which is evidence the descriptor probes work, not that a board has registered |
| **Anything with Docker** | `runner-machine` | `docker run` | **no** — the Dockerfile has never been built; Docker was not available on the machine that wrote it |

## Android: one APK, every shape

The Android agent is a foreground service and a text field. Nothing in it needs
a phone, and it was never a code problem — it was a packaging one. Three
declarations in the manifest do the work:

- `uses-feature android.hardware.touchscreen required="false"` (and `faketouch`).
  A television has no touchscreen, and installers and TV launchers treat that
  feature as required-by-default and filter the app out entirely.
- `category android.intent.category.LEANBACK_LAUNCHER` on the main activity.
  Without it the APK installs onto a Fire TV perfectly well and then cannot be
  started from the remote — which reads as "it does not work on TV" and is
  really "there is no icon".
- `android:banner`. A TV launcher draws a 320×180 banner, not an icon.

The phones are unaffected: declaring a feature not-required never removes it
from a device that has one.

What differs per shape is only the `kind` the runner declares, read from
`UiModeManager` and the VR and watch feature flags. A headset is asked about
before a TV, because Quest reports `UI_MODE_TYPE_NORMAL` and only the VR flag
tells the truth. Phone versus tablet has no system answer at all, so it uses
the 600 dp rule the resource system itself uses for `sw600dp`.

## Apple: one source, several products

`platform` is resolved at compile time, not from `UIDevice`, because it names
the SDK the binary was built against and that is a fact about the binary. A
tvOS build and an iOS build are different products from one source, and a
benchmark table has to be able to tell them apart.

tvOS needed exactly two accommodations, both in the sources rather than in a
fork of them:

- **No battery API.** Not a battery reading `-1` — `isBatteryMonitoringEnabled`
  does not exist, because an Apple TV is mains-powered. The runner reports 100%
  and charging, which is what a permanently plugged-in device is.
- **No WebKit.** The `web-shots:webkit` route is compiled out under
  `#if canImport(WebKit)`, so an Apple TV never *declares* the capability —
  and since the capability list is derived from the route list, the declaration
  and the code stay one act. A television advertising a screenshot workload it
  cannot run would take those jobs off the queue from the phones that can.

`WebShotsManifest.swift` stays in the tvOS target. Its header says it is kept
free of UIKit and WebKit so its parsing can be checked without a device, and
`Protocol.swift` refers to the type it defines — excluding it took the whole
protocol down with it.

**watchOS is not done.** The agent, the protocol and the Core ML backend would
compile, but watchOS has no UIKit, so `UIDevice` and `UIApplication` need
guards throughout rather than the two tvOS needed — and the watchOS platform is
not installed here, so none of it could be compiled anyway. It is the next
Apple target, not a missing one.

## The browser: the one with no install

![The browser runner: a Chromium tab registered with a collector and running a benchmark](../collector/docs/img/runner-web.png)

`http://<collector>/runner` enrols the browser that opens it. A smart TV's
built-in browser, a games console, a Chromebook, a Kindle, an iPad too old for
the App Store, a friend's phone via a QR code — none of them will run a signed
native agent, and all of them have a browser.

**Read the backend name before reading a number.** The browser runner does not
declare `benchmark:synthetic`, and that is deliberate rather than an omission.
The fleet's synthetic backend measures SHA-256 throughput; a browser's only
native hash is `crypto.subtle.digest`, which is asynchronous, so a thousand
sequential folds is a thousand promise dispatches and the scheduler is a large
part of what gets measured. `crypto.subtle` is also a secure-context API, so on
`http://fleet-host.local:8788` — the address a TV browser would use — it is not
there at all.

So there are two backends, each named for what it is:

| Backend | What it measures | Available |
|---|---|---|
| `jssha` | a synchronous SHA-256 written out in the page; no dispatch overhead, so the rate is the JS engine's throughput and is comparable between browsers | always, including plain HTTP |
| `webcrypto` | the platform's native SHA-256, paying async dispatch per round | secure contexts only |

Neither is comparable with a native runner's `synthetic` rate and neither
pretends to be. What *is* comparable is correctness: both fold the identical
block through identical rounds and both report `synthetic_digest`, so the
conformance suite proves the browser is doing the fleet's arithmetic even
though its clock means something different.

A hidden tab is throttled by every browser, so the agent stops asking for work
when the page is hidden — and aborts an in-flight claim rather than waiting out
the collector's 25-second long poll, because a job handed to a tab that went
hidden in that window would be measured through the throttle. It registers with
a TTL, so a tab that is *closed* leaves the shelf instead of sitting there
forever as an offline device nobody can find.

## Adding one

1. Write the agent. It registers, long-polls, runs, reports. There is no SDK
   and no shared library, on purpose — six implementations in six languages
   keep the protocol honest in a way one library never could.
2. Declare `platform`, `kind` and `capabilities` at registration. Declare only
   what the agent can actually run: a capability it cannot honour takes a job
   off the queue from a device that could have run it.
3. Run the conformance suite: `npm run conformance -- --device <id>`. Eight
   clauses, each of them something that has actually gone wrong here. A skip is
   fine; a FAIL is a bug in the agent.
4. Add a row to the table at the top of this page, and put the honest answer in
   the last column.
