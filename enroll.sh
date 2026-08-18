#!/bin/bash
# Enroll every attached Android device into the fleet.
#
#   ./enroll.sh                       # uses the compiled-in collector URL
#   FLEET_URL=http://host:8788 ./enroll.sh
#   POOLS=ml-capable,android-ui ./enroll.sh
#
# Idempotent: re-running re-installs and re-points existing devices. No cable
# tricks needed after this — the runner talks to the collector over the LAN,
# so a device can walk away from the desk and keep working.
set -uo pipefail

COLLECTOR="${FLEET_URL:-http://192.168.50.27:8788}"
APK="app/build/outputs/apk/debug/app-debug.apk"

echo "== building runner"
./gradlew :app:assembleDebug -q || { echo "build failed"; exit 1; }

# `unauthorized` means the device is waiting on its "Allow USB debugging?"
# prompt — worth calling out by name rather than silently skipping.
adb devices | awk 'NR>1 && $2=="unauthorized" {print "  ⚠ "$1" is UNAUTHORIZED — accept the USB debugging prompt on the device"}'

SERIALS=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
[ -z "$SERIALS" ] && { echo "no authorized devices attached"; exit 1; }

echo "== collector: $COLLECTOR"
before=$(curl -s --max-time 5 "$COLLECTOR/devices" | grep -o '"device_id"' | wc -l | tr -d ' ')

for s in $SERIALS; do
  model=$(adb -s "$s" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
  sdk=$(adb -s "$s" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
  rel=$(adb -s "$s" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
  abi=$(adb -s "$s" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')
  printf '  %-18s %-22s android-%-5s %-12s ' "$s" "$model" "$rel" "$abi"

  # minSdk 24. Below that the install fails with an opaque error, so say why.
  if [ "${sdk:-0}" -lt 24 ] 2>/dev/null; then
    echo "SKIP (API $sdk < 24; raise minSdk to enroll it)"; continue
  fi

  out=$(adb -s "$s" install -r -d "$APK" 2>&1 | tail -1)
  case "$out" in
    *Success*) ;;
    *) echo "INSTALL FAILED: $out"; continue;;
  esac
  adb -s "$s" shell pm clear com.taylab.fleetrunner >/dev/null 2>&1
  adb -s "$s" shell am start -n com.taylab.fleetrunner/.MainActivity \
      --ez autostart true --es base_url "$COLLECTOR" >/dev/null 2>&1
  # arm64 gets llama.cpp + LiteRT native backends; 32-bit devices still run
  # the synthetic backend, which is what makes them useful as old-hardware
  # baselines rather than useless.
  case "$abi" in
    arm64*) echo "enrolled (all backends)";;
    *) echo "enrolled (synthetic only — no arm64 native libs)";;
  esac
done

echo "== waiting for check-ins"
sleep 12
curl -s --max-time 10 "$COLLECTOR/devices" | python3 -c "
import sys, json, datetime
rows = json.load(sys.stdin)
fresh = [r for r in rows if (datetime.datetime.now(datetime.UTC).replace(tzinfo=None) - datetime.datetime.strptime(r['last_seen'], '%Y-%m-%d %H:%M:%S')).total_seconds() < 120]
print(f'  {len(rows)} devices registered, {len(fresh)} checked in just now:')
for r in fresh:
    d = r['descriptor']
    print(f\"    {r['device_id']:32} {d.get('model','?'):20} {d.get('os','?'):14} {d.get('ram_mb',0)/1024:.1f} GB\")
"
