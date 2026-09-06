#!/bin/bash
# Fail if the app links a Swift overlay that only exists for old deployment
# targets.
#
# This is the static half of the check that `launch-smoke.sh` makes
# dynamically, and it exists because the dynamic one cannot be relied on: a
# GitHub macOS runner ships only the newest iOS runtime, and the newest runtime
# is precisely the one on which this bug does NOT reproduce.
#
# How it detects the problem. When Apple folds a Swift overlay into its parent
# framework, the SDK stub keeps the old name but points elsewhere:
#
#   $SDK/usr/lib/swift/libswiftWebKit.tbd
#     install-name: /System/Library/Frameworks/WebKit.framework/WebKit
#     exports: '$ld$previous$/usr/lib/swift/libswiftWebKit.dylib$$7$14.0$18.4$_$…'
#
# A deployment target inside that range makes the linker emit a load command
# for the OLD path -- a file newer runtimes no longer ship, so dyld kills the
# process before main(). So: any /usr/lib/swift/libswift*.dylib we link whose
# SDK stub names a different install-name is a back-deployment trap, and the
# fix is to stop using whichever API pulled it in.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="${1:-build/Build/Products/Debug-iphonesimulator/FleetRunner.app}"
[ -d "$APP" ] || { echo "no app bundle at $APP -- build first" >&2; exit 1; }

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
[ -d "$SDK" ] || { echo "no iphonesimulator SDK" >&2; exit 1; }

BINS=()
for b in "$APP/FleetRunner" "$APP/FleetRunner.debug.dylib"; do
  [ -f "$b" ] && BINS+=("$b")
done
[ "${#BINS[@]}" -gt 0 ] || { echo "no binary inside $APP" >&2; exit 1; }

problems=0
for bin in "${BINS[@]}"; do
  while read -r lib; do
    [ -n "$lib" ] || continue
    name="$(basename "$lib" .dylib)"
    tbd="$SDK/usr/lib/swift/${name}.tbd"
    [ -f "$tbd" ] || continue
    install_name="$(awk -F"'" '/^install-name:/ {print $2; exit}' "$tbd")"
    # Unquoted install-names appear too.
    [ -n "$install_name" ] || install_name="$(awk '/^install-name:/ {print $2; exit}' "$tbd")"
    if [ -n "$install_name" ] && [ "$install_name" != "$lib" ]; then
      echo "FAIL: $(basename "$bin") links $lib" >&2
      echo "      but the SDK says that overlay now lives at:" >&2
      echo "        $install_name" >&2
      echo "      so the old dylib is a back-deployment stub that newer runtimes" >&2
      echo "      do not ship, and the app will not launch on them." >&2
      echo "      Find the Swift-only API pulling it in and use the Objective-C one:" >&2
      grep -o "\$ld\$previous\$${lib}\$[^']*" "$tbd" 2>/dev/null \
        | sed 's/.*\$_\$//; s/\$$//' \
        | while read -r sym; do xcrun swift-demangle --compact "$sym" 2>/dev/null; done \
        | grep -v FORCE_LOAD | sed 's/^/        /' | head -12 >&2
      problems=$((problems + 1))
    fi
  done < <(otool -L "$bin" 2>/dev/null | grep -o "/usr/lib/swift/libswift[A-Za-z_]*\.dylib" | sort -u)
done

if [ "$problems" -gt 0 ]; then
  echo >&2
  echo "$problems back-deployment trap(s). See waitForFonts in WebShotsWorkload.swift" >&2
  echo "for what fixing one looks like." >&2
  exit 1
fi

echo "== no back-deployed Swift overlay is linked -- ok"
