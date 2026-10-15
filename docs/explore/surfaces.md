# Devices

An **actuator** is one way of reaching one device. It knows how to look and how
to act, and nothing about models. The loop chooses one by the target's driver:

| Driver | Actuator | Devices | Surface |
|---|---|---|---|
| `adb` | `actuators/android.ts` | Android phones and tablets; Android TV and Fire TV | touch; D-pad when the device declares leanback |
| `simctl`, `devicectl` | `actuators/apple.ts` + FleetDriver | iOS and tvOS, simulators and hardware | touch on iOS; D-pad on tvOS |
| `roku` | `actuators/roku.ts` + tvloop | A Roku, or tvloop's fake | D-pad |

Every actuator implements the same contract (`explore/types.ts`): `reset`,
`launch`, `observe`, `act`, `crashes`, `close`, and a `caps` record saying
whether it is touch or D-pad, which keys it has, and whether it can read a UI
tree or the foreground app. The loop offers the model only the tools the
`caps` allow.

**Coordinates.** Everything outside the model client is in *screenshot
pixels*. The model speaks 0–1000; the model client converts on the way in and
out; each actuator converts screenshot pixels to whatever its input wants.

## Android

What it uses, all over adb:

| Need | How |
|---|---|
| Screenshot | `adb exec-out screencap -p`, read as raw bytes |
| Tree | `uiautomator dump /dev/tty`, falling back to a file on the device. Taken at the same time as the screenshot |
| In front | `dumpsys window`: the focused app, skipping the stale "last ANR" snapshot dumpsys prints first |
| Keyboard | `dumpsys input_method` |
| Tap, long press, swipe, scroll | `input tap`, `input swipe` |
| Type | `input text`, escaped for the device shell. Printable ASCII only; anything else is refused by name rather than half-typed |
| Clear a field | Ctrl+A then Delete on API 31+, else End and a run of Deletes |
| Keys | `input keyevent`: D-pad, Back, Home, Menu, media, Enter, Search |
| Reset | `force-stop`, `install -r -g` when there is a build, `pm clear`, launch |
| Launch | The launcher activity, or the leanback launcher's on a TV; launch arguments become string extras |
| Crashes | `logcat -b crash` for the package, as a running total; `logcat -b events` for `am_anr` |

**A TV** is recognised by the `android.software.leanback` feature. It gets
`surface: "dpad"`, no touch tools, and a **focus line**: the focused node,
named by its own label or, on Compose, the text inside it, with the labels of
the containers around it.

**Emulators must be able to take screenshots.** `aosp_atd` images return a
blank frame; use `google_apis`. A device whose first screenshot is blank while
its tree is full of text is refused at step one with that reason.

## Apple devices: FleetDriver

There is no command-line way to tap a simulator, and nothing at all for a
physical iPhone. **FleetDriver** (`runner-ios/FleetDriver/`) is a UI test that
does not test anything: with `FLEET_DRIVER=1` it starts an HTTP server inside
the XCUITest runner and turns requests into XCUITest calls. It builds for iOS
(scheme `FleetDriver`) and tvOS (scheme `FleetDriverTV`) from one source.

The actuator builds it once per host into `~/.fleet/explore/derived/<platform>`
(rebuilt when the sources change), starts
`xcodebuild test-without-building … -only-testing:…/testDrive` in the
background, and waits for `/health`. The first start of a runner can take a
minute.

### Protocol

JSON in and out, except the screenshot. Coordinates are **points** from the
top-left of the screen. On a simulator the server listens on loopback only and
every request must carry the random token the actuator generated, in
`X-Fleet-Driver-Token`.

| Method & path | Body / query | Does |
|---|---|---|
| `GET /health` | | `{ok, platform, os, scale, size:{w,h}}`; the size comes from the home screen's frame |
| `POST /launch` | `{bundleId, args?, env?}` | Launch an app |
| `POST /activate` · `POST /terminate` | `{bundleId}` | |
| `GET /screenshot` | | `image/png` of the whole screen |
| `GET /tree` | `?bundleId=&debug=1` | `{nodes:[{type,label,identifier,value,frame,enabled,hittable,focused,selected,depth}], keyboard}` from an XCUIElement snapshot; `debugDescription` too when asked |
| `GET /foreground` | `?bundleIds=a,b` | Which of the named apps is in front. XCUITest cannot name an arbitrary app, so the actuator reports `(another app)` when neither the app nor the home screen is |
| `POST /tap` | `{x, y}` | |
| `POST /long_press` | `{x, y, ms}` | |
| `POST /swipe` | `{x1, y1, x2, y2, ms}` | |
| `POST /type` | `{text, clear?}` | Into the focused element; `clear` deletes what is there first |
| `POST /hide_keyboard` | | |
| `POST /press` | `{button}` | tvOS: `up down left right select menu home play_pause`. iOS: `home` only |
| `POST /quit` | | Ends the test. It also ends itself after `FLEET_DRIVER_IDLE_S` (900) without a request |

XCUITest's own refusals (the tap did not land, the text was not typed) come back
as **422** with XCUITest's words, rather than ending the session.

### Starting it by hand

```bash
cd runner-ios && ./generate.sh
xcodebuild build-for-testing -project FleetRunner.xcodeproj -scheme FleetDriver \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ~/.fleet/explore/derived/ios-sim
TEST_RUNNER_FLEET_DRIVER=1 TEST_RUNNER_FLEET_DRIVER_PORT=8123 \
xcodebuild test-without-building -project FleetRunner.xcodeproj -scheme FleetDriver \
  -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath ~/.fleet/explore/derived/ios-sim \
  -only-testing:FleetDriverUITests/FleetDriverUITests/testDrive
curl -s localhost:8123/health
```

`collector/scripts/explore-apple-check.ts <udid>` does all of that and
exercises every action, printing timings.

### What is and is not known

| | |
|---|---|
| iOS 26.5 simulator | Verified: observe about 310 ms, an action about 0.9 s (typing about 2.7 s) |
| tvOS 26.5 simulator | Verified: observe about 560 ms (a 4K screenshot is 6 MB), a remote press about 230 ms |
| iOS 27 simulator | Not usable: XCUITest runners abort on that runtime on this Mac |
| Physical iPhone or Apple TV | **Never run.** Needs the runner signed (`FLEET_APPLE_TEAM_ID`) and is reached over the CoreDevice tunnel address from `devicectl device info details`. Crash logs are not readable over devicectl, and a reset without a build cannot clear app data |
| Crashes on a simulator | The simulator's unified log, filtered for the app |

The same build also gives the executor's `a11y-audit` workload its missing iOS
tree source: with `FLEET_A11Y_DUMP=1` the smoke test prints the app's
`debugDescription` between `FLEET-A11Y-DUMP-BEGIN` and `FLEET-A11Y-DUMP-END`.

## Roku through tvloop

tvloop already knows how to talk to a Roku: ECP for keys, the developer web
server for sideloads and screenshots, the debug console for logs, and an
optional in-app agent for the SceneGraph tree and focus. The actuator loads
tvloop's own Roku adapter from a built checkout (`FLEET_TVLOOP_DIR`, default
`~/tvloop`) at run time, so tvloop is not a dependency of the collector.

It uses the adapter rather than tvloop's `openDevice()` because `openDevice`
reads the developer password from the environment, where every process the
executor starts would inherit it. The adapter takes it as an argument. The
password comes from the Keychain item `fleet-roku-dev`, account `rokudev`:

```bash
security add-generic-password -s fleet-roku-dev -a rokudev -w
```

What a Roku cannot do, and says so:

- **No touch.** Taps and swipes throw, so the model hears it pressed nothing.
- **No clear-data.** A channel's registry survives a sideload; reset
  re-sideloads and starts from Roku Home.
- **No tree without the agent.** A channel that does not bundle tvloop's
  BrightScript agent gives pictures only, and `caps.tree` is false.
- **Screenshots are JPEG**, re-encoded to PNG to keep the contract.

Roku findings ship a **tvloop flow** (JSON) instead of a Maestro file; it plays
keys, typing and waits, and ends with `assert noErrors`.

**Verified** against tvloop's fake Roku (`npx @tvloop/fakeroku --agent`): about
120–230 ms to observe and 94 ms per key; all ten fake-Roku bench cards pass.
**Not verified** on the real Roku until its password is in the Keychain.

`collector/scripts/explore-tv-check.ts --fake-roku` (or `--android <serial>`)
drives a TV for real and reports timings.

## Fire TV in the tvloop workload too

The fleet's existing `tvloop` workload now accepts
`params.androidtv: {package, flows?}`. Adb devices that declare leanback then
run tvloop's `doctor` and `replay` as well as the Roku. They need no Roku
password, and the Roku-only steps (`install`, `spike`, `hardware`) are skipped
for them.

## Adding an actuator

1. Implement `Actuator` from `explore/types.ts` in `actuators/<name>.ts`. Keep
   the parsers pure and exported at the top, so they can be tested without the
   device.
2. Convert screenshot pixels to your input's units in `act`, and your tree's
   bounds to screenshot pixels in `observe`.
3. Report `caps` honestly. A tool the device cannot honour should not be
   offered.
4. Throw with the reason for anything the device cannot do. A model that is
   told "no touch on this device" recovers; one told "ok" learns nothing.
5. Add a branch to `actuators/index.ts` with a **literal** import, so a bundled
   executor that never meets the device never loads its code.
6. Export a `run…Checks(check)` from a sibling `.test.ts` and call it from
   `scripts/check-explore.ts`.
