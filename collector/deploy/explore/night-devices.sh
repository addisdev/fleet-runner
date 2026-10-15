#!/bin/bash
# Boot the night's emulator and simulator for explore, and shut down only those.
#
#   deploy/explore/night-devices.sh up     # 21:50, before the 22:00 schedule
#   deploy/explore/night-devices.sh down   # 01:05, after the window closes
#
# One emulator and one simulator, as the plan says, and only the ones this
# script booted are shut down: the ids it started are written to a state file,
# and `down` reads that file rather than shutting down everything it can see.
# When Load Warden is installed the boots go through it, so a night that
# coincides with a heavy render waits for room instead of crowding it.
set -uo pipefail
AVD="${EXPLORE_AVD:-fleet-explore-1}"
SIM_NAME="${EXPLORE_SIM:-fleet-explore-ios}"
STATE="$HOME/.fleet/explore/night-devices.state"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
mkdir -p "$(dirname "$STATE")"

up() {
  : > "$STATE"
  if command -v warden >/dev/null; then warden wait --for emulator-boot --timeout 1800 || { echo "no room for the emulator tonight"; exit 0; }; fi
  if ! "$SDK/platform-tools/adb" devices | grep -q emulator-; then
    nohup "$SDK/emulator/emulator" -avd "$AVD" -no-window -no-audio -no-snapshot-save >/dev/null 2>&1 &
    echo "emulator $AVD" >> "$STATE"
    "$SDK/platform-tools/adb" wait-for-device
    until [ "$("$SDK/platform-tools/adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
  fi
  if command -v warden >/dev/null; then warden wait --for sim-boot --timeout 900 || exit 0; fi
  UDID=$(xcrun simctl list devices -j | python3 -c "import sys,json; d=json.load(sys.stdin)['devices']; print(next((x['udid'] for r,l in d.items() for x in l if x['name']=='$SIM_NAME' and x['isAvailable']), ''))")
  if [ -n "$UDID" ] && ! xcrun simctl list devices booted | grep -q "$UDID"; then
    xcrun simctl boot "$UDID" && echo "simulator $UDID" >> "$STATE"
  fi
}

down() {
  [ -f "$STATE" ] || exit 0
  while read -r kind id; do
    case "$kind" in
      emulator) "$SDK/platform-tools/adb" -s "$(for s in $("$SDK/platform-tools/adb" devices | awk 'NR>1{print $1}'); do [ "$("$SDK/platform-tools/adb" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" = "$id" ] && echo "$s"; done)" emu kill 2>/dev/null ;;
      simulator) xcrun simctl shutdown "$id" 2>/dev/null ;;
    esac
  done < "$STATE"
  rm -f "$STATE"
}

case "${1:-}" in up) up ;; down) down ;; *) echo "usage: $0 up|down"; exit 2 ;; esac
