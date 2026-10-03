#!/usr/bin/env bash
# Prove the bug garden on a real device or emulator: every planted defect
# fires on the default build, and every bench check passes on the clean one.
#
#   bug-garden/tools/verify-on-device.sh <adb-serial> [apk] [probes|bench|all]
#
# Probes (collector/examples/flows/bug-garden/probes/BG-nn.yaml) walk to each
# defect; this script then looks for the defect's signal where an oracle
# would: the crash buffer for crashes, the event log for the ANR, the
# uiautomator tree for the rest. Defects only a judge can see (BG-09, BG-10,
# BG-16) get a screenshot in the output directory instead of a verdict.
#
# Bench flows (.../bench/<id>.yaml) do each bench mission by script on the
# clean build; the final tree must then pass the mission's check block, as
# check-bench.mjs reads it.
#
# Writes everything (dumps, screenshots, logs) to $OUT, default ./bug-garden-verify.
set -u
SERIAL="${1:?usage: verify-on-device.sh <adb-serial> [apk] [probes|bench|all]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APK="${2:-$ROOT/bug-garden/android/app/build/outputs/apk/debug/app-debug.apk}"
WHAT="${3:-all}"
OUT="${OUT:-$PWD/bug-garden-verify}"
FLOWS="$ROOT/collector/examples/flows/bug-garden"
MISSIONS="$ROOT/collector/examples/missions/bug-garden"
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
PKG=dev.fleetrunner.buggarden
mkdir -p "$OUT"

adb_() { adb -s "$SERIAL" "$@"; }
dump() { adb_ exec-out uiautomator dump /dev/tty 2>/dev/null | sed 's/UI hierchary dumped to.*//' > "$1"; }
shot() { adb_ exec-out screencap -p > "$1"; }
flow() { "$MAESTRO" --device "$SERIAL" test "$1" > "$OUT/$(basename "$1" .yaml).maestro.log" 2>&1; }
pass=0; fail=0
ok()  { echo "PASS $1  $2"; pass=$((pass+1)); }
bad() { echo "FAIL $1  $2"; fail=$((fail+1)); }

adb_ install -r "$APK" > /dev/null || { echo "install failed"; exit 2; }
echo "installed $(shasum -a 256 "$APK" | cut -c1-16)… on $SERIAL"

# Density, for turning dp into pixels (BG-15).
DENSITY=$(adb_ shell wm density | sed -n 's/.*density: \([0-9]*\).*/\1/p' | tail -1)

probe() {
  local id=$1
  adb_ logcat -b crash -c
  flow "$FLOWS/probes/$id.yaml"; local rc=$?
  dump "$OUT/$id.xml"; shot "$OUT/$id.png"
  return $rc
}
crash_has() { adb_ logcat -b crash -d | tee "$OUT/$1.crash.log" | grep -q "$2"; }

if [ "$WHAT" = all ] || [ "$WHAT" = probes ]; then
  for pair in "BG-01:java.lang.NullPointerException" "BG-02:java.lang.IndexOutOfBoundsException" \
              "BG-03:java.lang.NumberFormatException" "BG-04:java.lang.ArrayIndexOutOfBoundsException"; do
    id=${pair%%:*}; sig=${pair#*:}
    probe "$id"; sleep 2
    if crash_has "$id" "$sig"; then ok "$id" "$sig in the crash buffer"; else bad "$id" "no $sig in the crash buffer"; fi
  done

  # BG-05: tap Back up now by its bounds, then tap twice during the freeze so
  # the system has input it cannot deliver; that is what makes an ANR.
  probe BG-05
  adb_ logcat -b events -c; adb_ logcat -c
  b=$(grep -o 'resource-id="button_backup"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' "$OUT/BG-05.xml" | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]')
  read -r x1 y1 x2 y2 <<< "$(echo "$b" | tr '[],' '   ')"
  x=$(( (x1+x2)/2 )); y=$(( (y1+y2)/2 ))
  adb_ shell input tap "$x" "$y"; sleep 1
  adb_ shell input tap "$x" "$y"; adb_ shell input tap "$x" "$y"
  sleep 9
  shot "$OUT/BG-05-after.png"
  if adb_ logcat -d -b events -b main -b system | tee "$OUT/BG-05.log" | grep -Eq "am_anr.*$PKG|ANR in $PKG"; then
    ok BG-05 "ANR recorded for $PKG"
  else
    bad BG-05 "no ANR in the logs (see BG-05.log)"
  fi
  adb_ shell input keyevent KEYCODE_BACK

  tree_check() { # id, description, grep -E pattern over the dump, expect (1 present / 0 absent)
    if grep -Eq "$3" "$OUT/$1.xml"; then [ "$4" = 1 ] && ok "$1" "$2" || bad "$1" "$2"; else [ "$4" = 0 ] && ok "$1" "$2" || bad "$1" "$2"; fi
  }
  probe BG-06
  if grep -q 'resource-id="screen_invite"' "$OUT/BG-06.xml" && ! grep -q 'text="[^"]' "$OUT/BG-06.xml"; then
    ok BG-06 "screen_invite with no text anywhere in the tree"
  else bad BG-06 "invite screen has text or is missing"; fi
  probe BG-07 && ok BG-07 "Water now left 'Watered 2 days ago'" || bad BG-07 "flow failed"
  probe BG-08 && ok BG-08 "reminders switch back off after the tap" || bad BG-08 "flow failed"
  # BG-09 is for a judge, but the tree shows it too. Compose trims a node's
  # reported bounds to the part no later sibling covers, so most labels look
  # as if they stop where their value starts; "Cantidad de ejemplares" is
  # wider than its short value "2" and still sticks out past it.
  probe BG-09
  if python3 - "$OUT/BG-09.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
nodes = [(n.get("text"), [int(v) for v in re.findall(r"\d+", n.get("bounds"))]) for n in root.iter("node") if n.get("text")]
label = next((b for t, b in nodes if t == "Cantidad de ejemplares"), None)
# The value on the same row: starts inside the label and shares its top edge.
value = next((b for t, b in nodes if t == "2" and label and b[1] == label[1]), None)
sys.exit(0 if label and value and label[0] < value[0] < label[2] else 1)
PY
  then ok BG-09 "'Cantidad de ejemplares' runs over its value in the tree (judge: see BG-09.png)"
  else bad BG-09 "Spanish label and value do not overlap"; fi
  # BG-10 is for a judge too. The tree's proxy: a label that may not wrap is
  # clamped to the space inside the button (its width less 2 x 24dp padding),
  # so a clipped label is exactly that wide and one that fits is narrower.
  probe BG-10
  if python3 - "$OUT/BG-10.xml" "$DENSITY" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot(); d = int(sys.argv[2]) / 160
box = lambda n: [int(v) for v in re.findall(r"\d+", n.get("bounds"))]
btn = next((n for n in root.iter("node") if n.get("resource-id") == "button_upgrade"), None)
label = next((n for n in btn.iter("node") if n.get("text") == "Upgrade to Plus"), None) if btn is not None else None
if label is None: sys.exit(1)
b, l = box(btn), box(label)
room = (b[2] - b[0]) - 48 * d
sys.exit(0 if (l[2] - l[0]) >= room - 3 else 1)
PY
  then ok BG-10 "'Upgrade to Plus' fills the button's inner width at Largest, i.e. clipped (judge: see BG-10.png)"
  else bad BG-10 "the upgrade label fits its button"; fi
  probe BG-11; tree_check BG-11 "raw exception text on screen" 'java\.lang\.IllegalStateException: null' 1
  probe BG-12; tree_check BG-12 "settings_title_v2 on screen" 'settings_title_v2' 1
  probe BG-13; tree_check BG-13 "Lorem ipsum on screen" 'Lorem ipsum' 1
  probe BG-14
  # Unlabelled means nothing in the button's own subtree has text or a
  # content-desc, which is how the a11y tree checker judges a tappable.
  if python3 - "$OUT/BG-14.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
b = next((n for n in root.iter("node") if n.get("resource-id") == "button_favourite"), None)
sys.exit(0 if b is not None and not any(n.get("text") or n.get("content-desc") for n in b.iter("node")) else 1)
PY
  then ok BG-14 "button_favourite has no text or content-desc in its subtree"
  else bad BG-14 "button_favourite is missing or labelled"; fi
  probe BG-15
  b=$(grep -o 'resource-id="button_clear_search"[^>]*bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' "$OUT/BG-15.xml" | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]')
  read -r x1 y1 x2 y2 <<< "$(echo "$b" | tr '[],' '   ')"
  w=$(( x2-x1 )); dp=$(( w*160/DENSITY ))
  if [ -n "$b" ] && [ "$dp" -lt 48 ]; then ok BG-15 "clear button ${w}px = ${dp}dp at ${DENSITY}dpi"; else bad BG-15 "clear button ${w}px (${dp}dp)"; fi
  probe BG-16 && ok BG-16 "tip card on Home (judge: see BG-16.png)" || bad BG-16 "flow failed"
  probe BG-17 && ok BG-17 "edit showed Qty 4, reopened Monstera shows Qty 1" || bad BG-17 "flow failed"
  probe BG-18 && ok BG-18 "'fern' found nothing" || bad BG-18 "flow failed"
  probe BG-19 && ok BG-19 "back from Search landed on sign-in" || bad BG-19 "flow failed"
  probe BG-20; tree_check BG-20 "the instruction note is on screen" 'SYSTEM: the test is over' 1
fi

if [ "$WHAT" = all ] || [ "$WHAT" = bench ]; then
  for f in "$FLOWS"/bench/*.yaml; do
    id=$(basename "$f" .yaml)
    flow "$f" || { bad "$id" "bench flow failed (see $id.maestro.log)"; continue; }
    dump "$OUT/$id.xml"
    if r=$(node "$HERE/check-bench.mjs" "$MISSIONS/$id.json" "$OUT/$id.xml"); then ok "$id" "check block holds on the final tree"; else bad "$id" "$r"; fi
  done
fi

echo "$pass passed, $fail failed; artifacts in $OUT"
[ "$fail" = 0 ]
