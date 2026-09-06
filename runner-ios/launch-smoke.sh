#!/bin/bash
# Install the built app on a simulator and prove it actually starts.
#
# `xcodebuild build` succeeding and the app running are two different claims,
# and CI only ever checked the first one. That gap shipped a real bug: `import
# WebKit` made the linker hard-require /usr/lib/swift/libswiftWebKit.dylib for
# any deployment target below 18.4, newer runtimes stopped shipping that file,
# and the app died in dyld before main(). It built perfectly on every push.
#
# Run against the OLDEST runtime the machine has, because back-deployment is
# the thing that breaks and the newest runtime is the one that hides it.
#
# Which is also this script's limit, and worth knowing: a GitHub macOS runner
# ships only the newest iOS runtime, so on CI "oldest available" is the newest
# there is, and the bug above would NOT reproduce here. `check-backdeploy.sh`
# is what catches that class anywhere; this catches a process that dies at
# launch for any reason, on whatever runtime is to hand.
#
#   ./launch-smoke.sh [path/to/FleetRunner.app]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="${1:-build/Build/Products/Debug-iphonesimulator/FleetRunner.app}"
BUNDLE_ID="com.taylab.fleetrunner"
DEADLINE_S=25

[ -d "$APP" ] || { echo "no app bundle at $APP -- build first" >&2; exit 1; }

# The oldest installed iOS runtime. `sort -V` so 18.4 sorts before 26.0, which
# a lexical sort gets backwards and would silently test the newest instead.
RUNTIME="$(xcrun simctl list runtimes --json \
  | python3 -c '
import json,sys
rts=[r for r in json.load(sys.stdin)["runtimes"]
     if r.get("isAvailable") and r.get("platform")=="iOS"]
if not rts: sys.exit("no iOS runtimes available")
rts.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
print(rts[0]["identifier"], rts[0]["version"])')"
RUNTIME_ID="${RUNTIME%% *}"
RUNTIME_VER="${RUNTIME##* }"
echo "== oldest available runtime: iOS $RUNTIME_VER"

DEVICE_NAME="fleet-launch-smoke"
xcrun simctl delete "$DEVICE_NAME" >/dev/null 2>&1
UDID="$(xcrun simctl create "$DEVICE_NAME" "iPhone 16" "$RUNTIME_ID" 2>/dev/null \
     || xcrun simctl create "$DEVICE_NAME" "iPhone 15" "$RUNTIME_ID" 2>/dev/null)"
[ -n "$UDID" ] || { echo "could not create a simulator on iOS $RUNTIME_VER" >&2; exit 1; }
echo "== device $UDID"

cleanup() {
  xcrun simctl shutdown "$UDID" >/dev/null 2>&1
  xcrun simctl delete "$UDID" >/dev/null 2>&1
}
trap cleanup EXIT

xcrun simctl boot "$UDID" >/dev/null 2>&1
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcrun simctl install "$UDID" "$APP" || { echo "install failed" >&2; exit 1; }

# autostart 0: this proves the process starts, not that it can reach a
# collector. A network failure here would be a different test failing.
PID="$(xcrun simctl launch "$UDID" "$BUNDLE_ID" -autostart 0 2>&1 | awk -F': ' '{print $2}')"
echo "== launched, pid ${PID:-unknown}"

# Alive a moment later is the assertion. A dyld failure kills the process
# before main(), so the launch itself can still report a pid.
for _ in $(seq 1 "$DEADLINE_S"); do
  sleep 1
  if xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "$BUNDLE_ID"; then
    echo "== still running after launch -- ok"
    exit 0
  fi
done

echo "FAILED: $BUNDLE_ID is not running $DEADLINE_S s after launch" >&2
echo "--- most recent crash report ---" >&2
CRASH="$(ls -t "$HOME/Library/Logs/DiagnosticReports/"FleetRunner-*.ips 2>/dev/null | head -1)"
[ -n "$CRASH" ] && head -60 "$CRASH" >&2
echo "--- relaunching in the foreground for dyld's own words ---" >&2
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" -autostart 0 2>&1 | head -20 >&2 &
sleep 8
exit 1
