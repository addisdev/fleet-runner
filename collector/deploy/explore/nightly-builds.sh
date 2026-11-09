#!/bin/bash
# Build tonight's apps from develop on ultra and hand them to the brain.
#
# The explore nights ask for `"sha256": "latest"`, which the brain resolves to
# the newest artifact uploaded under an app name. CI on ultra keeps reports,
# not installable builds, so this builds them here: one checkout per repo under
# ~/explore/builds, reset to origin/develop, the app's folder built for the
# emulator or the simulator, uploaded with the app name and `develop-<short sha>`
# as the build.
#
# Dozehound is one repo (addisdev/dozehound) since 2026-10-24: its tvOS and
# Fire TV apps build from tvos/ and firetv/ of one checkout,
# ~/explore/builds/dozehound, and the sha is the last commit that touched that
# folder, so a backend-only commit does not rebuild tvOS. The app names, which
# the brain keys builds by, stay dozehound-tvos and dozehound-firetv. The old
# per-app clones of the archived repos are no longer read. First time:
#
#   git clone https://github.com/addisdev/dozehound.git ~/explore/builds/dozehound
#
# A build that fails is reported and skipped, and the night that needs it
# skips too (explore-night.ts --fresh-build) rather than testing an old build
# again. An unchanged sha is not rebuilt; its last build is uploaded again so
# the brain shows it as tonight's.
#
#   nightly-builds.sh [--tunnel jump:host:port] [app ...]
#
# Apps: greenfolio-ios and dozehound-tvos by default; dozehound-firetv when
# named. The Fire TV app has no offline mode and refuses to start without a
# real https backend, so it is not built nightly until explore may read the
# production catalog (WB-297).
set -uo pipefail

BRAIN="${FLEET_URL:-http://127.0.0.1:18788}"
BUILDS="${EXPLORE_BUILDS:-$HOME/explore/builds}"
STATE="$BUILDS/.uploaded"
export PATH="/opt/homebrew/bin:$PATH"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

tunnel=""
apps=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tunnel) tunnel="$2"; shift 2 ;;
    *) apps+=("$1"); shift ;;
  esac
done
[ ${#apps[@]} -eq 0 ] && apps=(greenfolio-ios dozehound-tvos)

log() { echo "[$(date +%H:%M:%S)] $*"; }

ssh_pid=""
cleanup() { [ -n "$ssh_pid" ] && kill "$ssh_pid" 2>/dev/null; }
trap cleanup EXIT
if ! curl -sf -m 3 "$BRAIN/api/health" >/dev/null; then
  [ -z "$tunnel" ] && { log "the brain does not answer at $BRAIN and no --tunnel was given"; exit 2; }
  IFS=: read -r jump host port <<<"$tunnel"
  local_port="${BRAIN##*:}"
  /usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L "$local_port:$host:$port" "$jump" &
  ssh_pid=$!
  for _ in $(seq 30); do sleep 1; curl -sf -m 3 "$BRAIN/api/health" >/dev/null && break; done
  curl -sf -m 3 "$BRAIN/api/health" >/dev/null || { log "no route to the brain through $jump"; exit 2; }
  log "tunnel to $host:$port through $jump is up"
fi

mkdir -p "$STATE"

# upload <app> <platform> <file> <build>
upload() {
  local out
  out=$(curl -sf -X POST "$BRAIN/artifacts" \
    -H "content-type: application/octet-stream" \
    -H "x-artifact-name: $(basename "$3")" \
    -H "x-artifact-app: $1" -H "x-artifact-platform: $2" -H "x-artifact-build: $4" \
    --data-binary "@$3") || { log "$1: upload failed"; return 1; }
  log "$1: uploaded $4 ($out)"
}

# The .app from a simulator build, zipped with its folder: simctl installs a
# folder, and the explore workload unpacks the zip before installing.
# Secrets.xcconfig is gitignored and has to exist before xcodegen. Explore
# writes its own from the template, with the backend at a loopback port where
# nothing listens and a dummy key: the app counts as configured (Dozehound
# refuses to start otherwise; plain http is allowed to loopback), and no
# request from an explored build can reach a production backend. Collector
# keys stay empty, so no telemetry leaves either.
# xcode_build <dir> <scheme> <sdk> <destination> <out zip> <build log>
xcode_build() {
  local dir="$1" scheme="$2" sdk="$3" dest="$4" zip="$5" blog="$6" derived="$1/.derived" t
  for t in "$dir"/*/Config/Secrets.xcconfig.template; do
    [ -f "$t" ] || continue
    sed -E -e 's#^(SUPABASE_URL *=).*#\1 http:/$()/127.0.0.1:9#' \
      -e 's#^(SUPABASE_ANON_KEY *=).*#\1 explore-offline#' \
      -e 's#^(COLLECTOR_KEY[A-Z_]* *=).*#\1#' "$t" >"${t%.template}"
  done
  ( cd "$dir" && xcodegen generate --quiet ) || return 1
  # A destination, not -sdk: -sdk would build an embedded watch app against
  # the phone's SDK too, and it fails on WatchKit.
  xcodebuild -project "$dir/$(cd "$dir" && ls -d *.xcodeproj | head -1)" -scheme "$scheme" \
    -destination "$dest" -configuration Debug -derivedDataPath "$derived" \
    CODE_SIGNING_ALLOWED=NO build >"$blog" 2>&1 || { tail -30 "$blog"; return 1; }
  local app
  app=$(ls -d "$derived/Build/Products/Debug-$sdk/"*.app | grep -v -i -e watch -e widget -e topshelf | head -1)
  [ -d "$app" ] || return 1
  rm -f "$zip" && ditto -c -k --keepParent "$app" "$zip"
}

failed=0
synced=" "   # checkouts already reset to origin/develop in this run
for name in "${apps[@]}"; do
  # <checkout> <folder>: the app's repo under $BUILDS and where in it the app lives.
  case "$name" in
    dozehound-tvos) repo="$BUILDS/dozehound" folder=tvos ;;
    dozehound-firetv) repo="$BUILDS/dozehound" folder=firetv ;;
    *) repo="$BUILDS/$name" folder=. ;;
  esac
  dir="$repo/$folder"
  [ -d "$repo/.git" ] || { log "$name: no checkout at $repo"; failed=1; continue; }
  case "$synced" in
    *" $repo "*) ;;
    *)
      # Three tries: the home gateway sometimes refuses new connections for a
      # few minutes at a time.
      fetched=0
      for try in 1 2 3; do
        git -C "$repo" fetch -q origin develop 2>"$BUILDS/$name.fetch.log" && { fetched=1; break; }
        sleep $(( try * 20 ))
      done
      [ $fetched = 1 ] && git -C "$repo" reset -q --hard origin/develop || { log "$name: fetch failed: $(tail -1 "$BUILDS/$name.fetch.log")"; failed=1; continue; }
      synced="$synced$repo "
      ;;
  esac
  [ -d "$dir" ] || { log "$name: no $folder/ in $repo"; failed=1; continue; }
  if [ "$folder" = . ]; then
    sha=$(git -C "$repo" rev-parse --short=10 HEAD)
  else
    sha=$(git -C "$repo" rev-list -1 --abbrev-commit --abbrev=10 HEAD -- "$folder")
  fi
  build="develop-$sha"
  blog="$BUILDS/$name.build.log"
  case "$name" in
    dozehound-firetv) file="$dir/app/build/outputs/apk/debug/app-debug.apk"; platform=android ;;
    greenfolio-ios) file="$BUILDS/$name-$sha.zip"; platform=ios ;;
    dozehound-tvos) file="$BUILDS/$name-$sha.zip"; platform=tvos ;;
    *) log "$name: no recipe"; failed=1; continue ;;
  esac
  # Unchanged: upload the same bytes again rather than nothing. The brain
  # ignores the duplicate but stamps it as published now, and that stamp is
  # how the explore nights (`explore-night.ts --fresh-build`) tell "develop did
  # not move" from "this job did not run tonight".
  if [ "$(cat "$STATE/$name" 2>/dev/null)" = "$build" ] && [ -f "$file" ]; then
    upload "$name" "$platform" "$file" "$build" && log "$name: $build unchanged; republished for tonight" || failed=1
    continue
  fi
  log "$name: building $build"
  started=$(date +%s)
  case "$name" in
    dozehound-firetv)
      ( cd "$dir" && ./gradlew -q --no-daemon :app:assembleDebug >"$blog" 2>&1 ) || { tail -30 "$blog"; log "$name: build failed"; failed=1; continue; } ;;
    greenfolio-ios)
      xcode_build "$dir" GreenFolio iphonesimulator "generic/platform=iOS Simulator" "$file" "$blog" || { log "$name: build failed"; failed=1; continue; } ;;
    dozehound-tvos)
      xcode_build "$dir" Dozehound appletvsimulator "generic/platform=tvOS Simulator" "$file" "$blog" || { log "$name: build failed"; failed=1; continue; } ;;
  esac
  log "$name: built in $(( $(date +%s) - started )) s"
  upload "$name" "$platform" "$file" "$build" && echo "$build" >"$STATE/$name" || failed=1
  # Keep the newest zip only.
  ls -t "$BUILDS/$name"-*.zip 2>/dev/null | tail -n +2 | xargs rm -f
done
exit $failed
