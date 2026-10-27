#!/usr/bin/env bash
# Launch the desktop app on Linux under a virtual display and prove it ran.
#
# Run by `desktop / launch smoke` in .github/workflows/desktop.yml, after
# `./stage-sidecar.sh` and `cargo build --features custom-protocol` in
# src-tauri/. It needs Xvfb, dbus-launch, ImageMagick's `import`, curl, jq,
# and -- for the second half -- `tauri-driver` and `WebKitWebDriver` on PATH.
#
# Two halves, because they prove different things:
#
# 1. The process. Start the binary as a person would, with no config file, and
#    watch for what it is supposed to do at launch: spawn `fleet up` as its
#    sidecar, which starts a collector on :8788 whose agent registers. Then
#    check the app is still up after a while, because a Tauri app that panics
#    in its event loop does so after setup has already returned.
# 2. The window. Start it again under tauri-driver, the WebDriver server Tauri
#    publishes, and drive the settings window from outside: that the page
#    loaded, that `window.__TAURI__` exists, that a #[tauri::command] answers
#    over IPC, and a screenshot of what it drew.
#
# Everything lands in $OUT (default $RUNNER_TEMP/desktop-smoke) for the
# workflow to upload, pass or fail.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tauri="$here/../src-tauri"
bin="$tauri/target/debug"
app="$bin/fleet-desktop"
out="${OUT:-${RUNNER_TEMP:-/tmp}/desktop-smoke}"
mkdir -p "$out"

port=8788
base="http://127.0.0.1:$port"

# A fleet home of its own, so the run cannot read or write anybody's
# ~/.fleet. config.rs and the CLI both honour FLEET_HOME, and the sidecar
# inherits this environment.
export FLEET_HOME="$out/fleet-home"
rm -rf "$FLEET_HOME"

# The sidecar shim checks /usr/local/bin/node before PATH, on purpose (a
# Finder-launched app has no Homebrew on PATH). GitHub's Ubuntu image keeps an
# older Node there, below the 22.13 node:sqlite needs, so the one setup-node
# installed is named explicitly -- the same escape hatch a person would use.
export FLEET_NODE="${FLEET_NODE:-$(command -v node)}"
echo "node: $FLEET_NODE ($("$FLEET_NODE" --version))"

fleet() { "$FLEET_NODE" "$tauri/resources/fleet/bin/fleet.mjs" "$@"; }

fail() { echo "::error::$*"; exit 1; }

echo "== what cargo build put beside the binary"
ls -la "$bin" | grep -E 'fleet' || true
[ -x "$app" ] || fail "$app was not built"
[ -x "$bin/fleet" ] || fail "the sidecar shim was not copied to $bin/fleet"
[ -f "$bin/fleet-tree/bin/fleet.mjs" ] || fail "the fleet tree was not copied to $bin/fleet-tree"

echo "== virtual display and session bus"
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x800x24 >"$out/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
xdpyinfo >/dev/null 2>&1 || fail "Xvfb did not come up"
eval "$(dbus-launch --sh-syntax)"

health() { curl -fsS --max-time 2 "$base/api/v1/health" >/dev/null 2>&1; }

device_count() {
  local n
  n=$(fleet devices --url "$base" --json 2>/dev/null | jq '.items | length' 2>/dev/null || true)
  echo "${n:-0}"
}

wait_for_fleet() {
  local pid=$1
  for _ in $(seq 1 90); do
    kill -0 "$pid" 2>/dev/null || fail "the app exited before its sidecar answered (see app.log)"
    health && break
    sleep 1
  done
  health || fail "nothing answered $base/api/v1/health within 90s of launch"
  local n=0
  for _ in $(seq 1 45); do
    n=$(device_count)
    [ "$n" -gt 0 ] && break
    sleep 1
  done
  [ "$n" -gt 0 ] || fail "the sidecar's collector answered but its agent never registered"
  echo "sidecar up: collector answers, $n device(s) registered"
}

# `fleet up` writes its own pid to logs/supervisor.json. Used to clean up
# between the halves -- by pid, never by name -- and to see whether quitting the
# app took the sidecar with it.
sidecar_pid() { jq -r '.pid // empty' "$FLEET_HOME/logs/supervisor.json" 2>/dev/null || true; }

stop_sidecar() {
  local spid
  spid=$(sidecar_pid)
  if [ -n "$spid" ] && kill -0 "$spid" 2>/dev/null; then
    kill -TERM "$spid" || true
    for _ in $(seq 1 30); do kill -0 "$spid" 2>/dev/null || break; sleep 0.5; done
  fi
  for _ in $(seq 1 20); do health || break; sleep 0.5; done
  if health; then fail "something still answers $base after stopping the sidecar"; fi
}

# --- 1. the process ---------------------------------------------------------
echo "== half 1: launch the binary"
health && fail "something is already on $base before launch; the app would refuse to start its sidecar"
"$app" >"$out/app.log" 2>&1 &
apppid=$!
echo "app pid $apppid"
wait_for_fleet "$apppid"
fleet devices --url "$base" | tee "$out/devices.txt"

settle=${SETTLE_S:-20}
echo "waiting ${settle}s to see that the app stays up"
sleep "$settle"
kill -0 "$apppid" 2>/dev/null || fail "the app died within ${settle}s of launch (see app.log)"
health || fail "the sidecar stopped answering within ${settle}s of launch"
echo "app still running after ${settle}s, sidecar still answering"
import -window root "$out/screen-after-launch.png" || echo "warning: import could not capture the screen"

# SIGTERM is what a `kill`, a `killall Fleet` or the end of a session sends,
# and the app treats it as the Quit item: stop `fleet up` (it gets SIGTERM and
# up to 15s to drain), then exit. The first run of this smoke found the
# opposite -- the app died on the spot and its sidecar kept the port -- so this
# is asserted, not just printed.
spid=$(sidecar_pid)
[ -n "$spid" ] || fail "fleet up did not write its pid to $FLEET_HOME/logs/supervisor.json"
kill -TERM "$apppid"
for _ in $(seq 1 60); do kill -0 "$apppid" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$apppid" 2>/dev/null; then
  stop_sidecar
  fail "the app was still running 30s after SIGTERM"
fi
if kill -0 "$spid" 2>/dev/null; then
  stop_sidecar
  fail "the app exited on SIGTERM and left its sidecar (fleet up, pid $spid) running"
fi
for _ in $(seq 1 20); do health || break; sleep 0.5; done
health && fail "the app and its sidecar are gone but something still answers $base"
echo "SIGTERM: the app stopped its sidecar and exited"
grep -E "fleet up (started|exited)|did not stop" "$out/app.log" || true
stop_sidecar

# --- 2. the window, under tauri-driver ---------------------------------------
if [ "${SKIP_DRIVER:-}" = "1" ]; then
  echo "SKIP_DRIVER=1; not driving the window"
  kill "$xvfb" 2>/dev/null || true
  exit 0
fi

echo "== half 2: drive the settings window through tauri-driver"
command -v tauri-driver >/dev/null || fail "tauri-driver is not on PATH"
command -v WebKitWebDriver >/dev/null || fail "WebKitWebDriver is not on PATH (apt: webkitgtk-webdriver, or webkit2gtk-driver before Ubuntu 26.04)"
tauri-driver --port 4444 >"$out/tauri-driver.log" 2>&1 &
driver=$!
for _ in $(seq 1 50); do curl -fsS http://127.0.0.1:4444/status >/dev/null 2>&1 && break; sleep 0.2; done

wd() { # method path [json]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS --max-time 60 -X "$method" -H 'content-type: application/json' -d "$body" "http://127.0.0.1:4444$path"
  else
    curl -sS --max-time 60 -X "$method" "http://127.0.0.1:4444$path"
  fi
}

caps=$(jq -n --arg app "$(cd "$bin" && pwd)/fleet-desktop" \
  '{capabilities:{alwaysMatch:{"tauri:options":{application:$app}}}}')
session=$(wd POST /session "$caps")
echo "$session" > "$out/webdriver-session.json"
sid=$(echo "$session" | jq -r '.value.sessionId // empty')
[ -n "$sid" ] || fail "tauri-driver did not open a session: $(echo "$session" | head -c 600)"
echo "webdriver session $sid"

cleanup_driver() {
  wd DELETE "/session/$sid" >/dev/null 2>&1 || true
  kill "$driver" 2>/dev/null || true
}
trap cleanup_driver EXIT

# The app under the driver autostarts its sidecar too.
for _ in $(seq 1 90); do health && break; sleep 1; done
health || fail "under tauri-driver, the sidecar never answered"

title=$(wd GET "/session/$sid/title" | jq -r '.value')
echo "window title: $title"
[ "$title" = "Fleet" ] || fail "expected the settings window titled Fleet, got '$title'"

has_tauri=$(wd POST "/session/$sid/execute/sync" \
  '{"script":"return typeof window.__TAURI__ === \"object\" && typeof window.__TAURI__.core.invoke === \"function\"","args":[]}' \
  | jq -r '.value')
[ "$has_tauri" = "true" ] || fail "window.__TAURI__ is missing from the settings page (got $has_tauri)"

status=$(wd POST "/session/$sid/execute/async" \
  '{"script":"const done = arguments[arguments.length - 1]; window.__TAURI__.core.invoke(\"get_status\").then((s) => done(s), (e) => done({ error: String(e) }));","args":[]}')
echo "$status" | jq '.value' > "$out/get_status.json"
cat "$out/get_status.json"
[ "$(echo "$status" | jq -r '.value.running')" = "true" ] \
  || fail "get_status over IPC did not say the sidecar is running"

# The settings window starts hidden -- the app lives in the tray -- so it is
# shown the way the tray's Settings item would, from inside the page, before
# the screenshot.
wd POST "/session/$sid/execute/async" \
  '{"script":"const done = arguments[arguments.length - 1]; window.__TAURI__.window.getCurrentWindow().show().then(() => done(true), (e) => done(String(e)));","args":[]}' \
  | jq -c '.value'
sleep 2
headline=$(wd POST "/session/$sid/execute/sync" \
  '{"script":"const h = document.getElementById(\"headline\"); return h ? h.textContent : null","args":[]}' | jq -r '.value')
echo "settings window headline: $headline"
wd GET "/session/$sid/screenshot" | jq -r '.value' | base64 -d > "$out/settings-window.png" \
  || echo "warning: the webdriver screenshot failed"
import -window root "$out/screen-settings.png" || true
file "$out"/*.png || true

cleanup_driver
trap - EXIT
sleep 3
stop_sidecar
kill "$xvfb" 2>/dev/null || true
echo "desktop launch smoke: ok"
