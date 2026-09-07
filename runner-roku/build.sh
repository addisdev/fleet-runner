#!/usr/bin/env bash
#
# Package the channel for sideloading, and optionally push it to a Roku.
#
# A Roku channel is a zip with `manifest` at its ROOT. That is the whole build:
# there is no compiler, no linker and no toolchain to install, because
# BrightScript is interpreted on the device. It also means nothing here can tell
# you whether the code compiles -- the first parse error you will ever see is on
# the television, in the sideload page's "Install" response or in the device's
# debug console on port 8085.
#
# Usage:
#   ./build.sh                          package only -> build/fleet-runner-roku.zip
#   ./build.sh --install <roku-ip>      package, then upload as a dev channel
#   ./build.sh --install <ip> --launch http://fleet-host.local:8788
#                                       ... and launch it against that collector
#
# The developer password is read from the macOS Keychain, never from a flag:
#
#   security add-generic-password -s fleet-roku-dev -a rokudev -w
#
# which prompts rather than taking the password as an argument. Set
# ROKU_DEV_KEYCHAIN_SERVICE to use a different service name.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/build"
ZIP="$OUT_DIR/fleet-runner-roku.zip"
KEYCHAIN_SERVICE="${ROKU_DEV_KEYCHAIN_SERVICE:-fleet-roku-dev}"

ROKU_IP=""
LAUNCH_URL=""
DEVICE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) ROKU_IP="${2:-}"; shift 2 ;;
    --launch) LAUNCH_URL="${2:-}"; shift 2 ;;
    --device-id) DEVICE_ID="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- package ----------------------------------------------------------------

# Zip from INSIDE runner-roku/, so the archive's root entries are `manifest`,
# `source/` and `components/`. Zipping the directory itself produces an archive
# whose root is `runner-roku/`, and Roku rejects that with "Failed to parse
# manifest" -- which reads like a syntax error in the manifest and is really an
# archive built one directory too high. It is the single most common way a first
# sideload fails.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cd "$HERE"

# Only what the channel needs at runtime. The README and this script would
# install perfectly happily and are dead weight on a device with limited
# storage; -x on the zip is cheaper than remembering to keep them elsewhere.
zip -q -r "$ZIP" manifest source components images \
  -x '*.DS_Store' -x '__MACOSX/*'

echo "packaged $(du -h "$ZIP" | cut -f1) -> $ZIP"

if [[ -z "$ROKU_IP" ]]; then
  cat <<EOF

Sideload it by hand at http://<roku-ip>/plugin_install (user: rokudev), or:

  ./build.sh --install <roku-ip> --launch http://fleet-host.local:8788

Developer mode must be enabled on the Roku first: Home x3, Up x2, Right, Left,
Right, Left, Right on the remote, then accept the agreement and set a password.
The Roku reboots and the install page appears at its IP on port 80.
EOF
  exit 0
fi

# --- install ----------------------------------------------------------------

if ! command -v security >/dev/null 2>&1; then
  echo "no \`security\` command on this host, so there is no Keychain to read the" >&2
  echo "developer password from. Install by hand at http://$ROKU_IP/plugin_install." >&2
  exit 1
fi

if ! PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a rokudev -w 2>/dev/null)"; then
  echo "no Keychain item for service '$KEYCHAIN_SERVICE', account 'rokudev'." >&2
  echo "Add one with:  security add-generic-password -s $KEYCHAIN_SERVICE -a rokudev -w" >&2
  exit 1
fi

# The password goes to curl on stdin as a config file, never as an argument.
# `curl -u user:pass` puts the secret in argv, and argv is world-readable
# through ps on every machine this might run on -- the same rule
# collector/src/secrets.ts follows, for the same reason.
#
# /plugin_install wants a multipart form with mysubmit=Replace and the archive
# in `archive`, behind HTTP digest auth as `rokudev`. Roku answers 200 with an
# HTML page whether it worked or not, so the response is grepped rather than
# trusted: a failed install and a successful one differ only in the page's text.
echo "installing to $ROKU_IP ..."
RESPONSE="$(printf 'user = "rokudev:%s"\n' "$PASSWORD" | curl -sS --digest --config - \
  -F "mysubmit=Replace" \
  -F "archive=@$ZIP" \
  -F "passwd=" \
  "http://$ROKU_IP/plugin_install" || true)"

if echo "$RESPONSE" | grep -qi "Identical to previous version\|Application Received\|Install Success"; then
  echo "installed."
else
  echo "install did not report success. The device said:" >&2
  # Strip tags so the actual message is readable; Roku's page is mostly markup.
  echo "$RESPONSE" | sed -e 's/<[^>]*>//g' | tr -s '[:space:]' ' ' | cut -c1-500 >&2
  exit 1
fi

# --- launch -----------------------------------------------------------------

if [[ -n "$LAUNCH_URL" ]]; then
  # ECP launch with parameters. This is the enrolment path: the collector URL
  # arrives over the network so nobody has to type it on the remote, and the
  # channel writes it to the registry so every later launch is bare.
  #
  # The URL is percent-encoded because it contains `:` and `/`, which would
  # otherwise terminate the query parameter and the channel would launch with a
  # truncated collector address and no error anywhere.
  ENCODED="$(printf '%s' "$LAUNCH_URL" | sed -e 's/%/%25/g' -e 's|:|%3A|g' -e 's|/|%2F|g' -e 's/?/%3F/g' -e 's/&/%26/g' -e 's/=/%3D/g')"
  QUERY="fleet_url=$ENCODED"
  if [[ -n "$DEVICE_ID" ]]; then
    QUERY="$QUERY&device_id=$DEVICE_ID"
  fi
  curl -sS -d '' "http://$ROKU_IP:8060/launch/dev?$QUERY" >/dev/null
  echo "launched against $LAUNCH_URL"
  echo
  echo "Watch it register:  curl -s http://<collector>/api/devices | grep roku"
  echo "Read its log:       telnet $ROKU_IP 8085"
fi
