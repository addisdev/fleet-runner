# fleet-runner-ios

Swift runner app for the Fleet Runner device fleet — Phase 3.

SwiftUI app mirroring [`fleet-runner-android`](https://github.com/addisdev/fleet-runner-android)'s
JSON protocol (shared protocol, not shared code): agent loop long-polling the
[collector](https://github.com/addisdev/fleet-collector), 60 s telemetry beacon
(battery / thermal / `phys_footprint`), and the synthetic SHA-256 benchmark
backend — token-for-token identical to the Android implementation, so tok/s is
comparable across the whole fleet.

## Build & run (simulator)

```
xcodegen generate
xcodebuild -project FleetRunner.xcodeproj -scheme FleetRunner \
  -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/FleetRunner.app
xcrun simctl launch booted com.taylab.fleetrunner -autostart 1
```

Simulators reach the collector at `http://127.0.0.1:8788` directly. On real
devices, point the Collector URL at the Mac's tailnet address; distribution is
TestFlight internal.

## Phase 3 status

- [x] Protocol, collector client, agent loop, beacon, synthetic benchmark
- [x] Cross-platform benchmark table verified (iOS sim + Android emulator + SM-X930)
- [x] llama.cpp backend (xcframework), Core ML backend (vision-eval), batch + pipeline engines
- [x] host-executor iOS path (simctl + devicectl install, XCUITest bundle)
- [ ] Real-device battery/charging telemetry validation (simulator reports -1)
