#!/bin/bash
# Fill in a service template from this machine and load it.
#
#   deploy/install-agent.sh com.addisdev.fleet-runner-machine.plist   # macOS
#   deploy/install-agent.sh fleet-runner-machine.service              # Linux
#   deploy/install-agent.sh <template> --print
#
# The templates in this directory carry placeholder paths. That is not
# tidiness: neither launchd nor systemd expands `~`, neither reads your login
# PATH, and neither complains about a path that does not exist — a unit with
# someone else's home directory in it fails by quietly doing nothing at all.
# So every path is absolute, and every absolute path is filled in here, on the
# machine that will actually run the thing.
#
# Every value can be overridden from the environment:
#   FLEET_URL=http://fleet-host.local:8788 deploy/install-agent.sh <template>
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE=""
PRINT_ONLY=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --print) PRINT_ONLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)  TEMPLATE="$arg" ;;
  esac
done

if [ -z "$TEMPLATE" ]; then
  echo "usage: $0 <template> [--print] [--force]" >&2
  echo >&2
  echo "available templates:" >&2
  (cd "$DEPLOY_DIR" && ls *.plist *.service 2>/dev/null | sed 's/^/  /') >&2
  exit 2
fi

SRC="$DEPLOY_DIR/${TEMPLATE##*/}"
[ -f "$SRC" ] || { echo "no such template: $SRC" >&2; exit 1; }

# --- the facts about this machine -------------------------------------------
# Resolved absolutely, because a service manager gets no shell to resolve names.
: "${FLEET_HOME:=$(cd "$DEPLOY_DIR/.." && pwd)}"
: "${NODE:=$(command -v node || true)}"
[ -n "$NODE" ] || { echo "node not found on PATH; set NODE=/abs/path/to/node" >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
: "${NODE_BIN_DIR:=$(dirname "$NODE")}"

# Loopback by default: the collector's own machine is the only address that is
# right without asking. Anywhere else, pass FLEET_URL.
: "${FLEET_URL:=http://127.0.0.1:8788}"
: "${FLEET_POOLS:=machines}"
# The agent's own default is machine-<hostname>, computed the same way. Filling
# it in here rather than leaving the variable empty means the installed unit
# says out loud which device id it registers as.
: "${FLEET_DEVICE_ID:=machine-$(hostname | tr '[:upper:]' '[:lower:]' | sed -e 's/\.\(local\|lan\|home\|internal\)$//' -e 's/[^a-z0-9_-]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//')}"

# tsx is how the agent runs TypeScript without a build step. If it is missing,
# the service would respawn every ten seconds forever, so say so now.
if [ ! -f "$FLEET_HOME/node_modules/tsx/dist/cli.mjs" ]; then
  echo "warning: $FLEET_HOME/node_modules/tsx not found — run 'npm install' first" >&2
fi

FILLED="$(sed \
  -e "s|__FLEET_HOME__|$FLEET_HOME|g" \
  -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__FLEET_URL__|$FLEET_URL|g" \
  -e "s|__FLEET_DEVICE_ID__|$FLEET_DEVICE_ID|g" \
  -e "s|__FLEET_POOLS__|$FLEET_POOLS|g" \
  "$SRC")"

# A placeholder that survived means a path this script does not know about.
# Installing it would produce a service that fails silently, which is the exact
# failure mode the templates exist to prevent.
if LEFT="$(printf '%s' "$FILLED" | grep -o '__[A-Z_]\{2,\}__' | sort -u)" && [ -n "$LEFT" ]; then
  echo "unsubstituted placeholders remain:" >&2
  printf '  %s\n' $LEFT >&2
  echo "set them in the environment and re-run" >&2
  exit 1
fi

if [ "$PRINT_ONLY" = 1 ]; then
  printf '%s\n' "$FILLED"
  exit 0
fi

case "$SRC" in
  *.plist)
    command -v launchctl >/dev/null 2>&1 || { echo "launchctl not found; this template is macOS-only" >&2; exit 1; }
    LABEL="$(printf '%s' "$FILLED" | awk '/<key>Label<\/key>/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}')"
    [ -n "$LABEL" ] || { echo "could not read Label from $SRC" >&2; exit 1; }

    DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents"

    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && [ "$FORCE" != 1 ]; then
      echo "$LABEL is already loaded. Re-run with --force to replace it, or stop it first:" >&2
      echo "  launchctl bootout gui/\$(id -u)/$LABEL" >&2
      exit 1
    fi

    printf '%s\n' "$FILLED" > "$DEST"
    plutil -lint "$DEST" >/dev/null || { echo "generated plist is malformed: $DEST" >&2; exit 1; }

    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$DEST" || { echo "bootstrap failed for $LABEL" >&2; exit 1; }

    echo "installed and loaded: $LABEL"
    echo "  plist   $DEST"
    echo "stop it with:  launchctl bootout gui/\$(id -u)/$LABEL"
    ;;

  *.service)
    command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found; this template is systemd-only" >&2; exit 1; }
    UNIT="${SRC##*/}"
    DEST="$HOME/.config/systemd/user/$UNIT"
    mkdir -p "$HOME/.config/systemd/user"

    if systemctl --user is-active --quiet "$UNIT" && [ "$FORCE" != 1 ]; then
      echo "$UNIT is already running. Re-run with --force to replace it, or stop it first:" >&2
      echo "  systemctl --user stop $UNIT" >&2
      exit 1
    fi

    printf '%s\n' "$FILLED" > "$DEST"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT" || { echo "enable failed for $UNIT" >&2; exit 1; }

    echo "installed and started: $UNIT"
    echo "  unit    $DEST"
    # Without lingering, a user unit stops at logout, which on a headless box
    # means it stops as soon as the SSH session that installed it ends.
    loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes' ||
      echo "note: run 'sudo loginctl enable-linger $USER' to keep it running after logout"
    echo "stop it with:  systemctl --user stop $UNIT"
    ;;

  *)
    echo "unrecognised template type: $SRC" >&2
    exit 1
    ;;
esac

echo "  node    $NODE"
echo "  cwd     $FLEET_HOME"
echo "  device  $FLEET_DEVICE_ID -> $FLEET_URL"
