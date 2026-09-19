#!/bin/sh
# Copy a brain's backups onto another machine.
#
# `backup-brain.sh` protects against the database going wrong. This protects
# against the *machine* going wrong, which on a fleet whose brain is a 2016
# laptop is the likelier of the two. A backup that only exists on the disk it
# is backing up is a rehearsal.
#
# Runs on the machine doing the pulling, not on the brain, because that is the
# direction that works here: the brain is a LaunchAgent host with no inbound
# access to anywhere else, and every other machine can already reach it over
# SSH. It also means the brain needs no credentials for a second machine.
#
# Usage:  pull-brain-backups.sh [ssh-host] [destination]
#         defaults: fleet-host   ~/fleet-backups/<ssh-host>
#
# Environment:
#   FLEET_BACKUP_KEEP   how many to keep locally (default 14)
set -eu

HOST="${1:-fleet-host}"
DEST="${2:-$HOME/fleet-backups/$HOST}"
KEEP="${FLEET_BACKUP_KEEP:-14}"

mkdir -p "$DEST"

# BatchMode so a missing key fails now with a clear message instead of hanging
# on a password prompt no launchd job can answer.
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20"

if ! $SSH "$HOST" true 2>/dev/null; then
  echo "pull-brain-backups: cannot reach $HOST over SSH." >&2
  echo "  A laptop that is asleep is the ordinary reason, and not an error worth" >&2
  echo "  waking anybody for -- but a week of them is." >&2
  exit 1
fi

REMOTE=$($SSH "$HOST" 'ls -1d ~/fleet-backups/brain-* 2>/dev/null | sort | tail -1' || true)
if [ -z "$REMOTE" ]; then
  echo "pull-brain-backups: $HOST has no backups in ~/fleet-backups." >&2
  echo "  Is com.addisdev.fleet-backup installed and loaded there?" >&2
  exit 1
fi

NAME=$(basename "$REMOTE")
if [ -d "$DEST/$NAME" ]; then
  echo "pull-brain-backups: $NAME is already here; nothing new since the last pull"
else
  # -a to keep timestamps, so "how old is my newest copy" stays answerable.
  rsync -a --partial "$HOST:$REMOTE/" "$DEST/$NAME.partial/"
  mv "$DEST/$NAME.partial" "$DEST/$NAME"
  echo "pull-brain-backups: pulled $NAME ($(du -sh "$DEST/$NAME" | cut -f1))"
fi

# The copy is worth nothing if it does not open. Checked here rather than on
# the brain, because the bytes that matter are the ones that arrived.
if [ -f "$DEST/$NAME/fleet.db" ]; then
  if [ "$(sqlite3 "$DEST/$NAME/fleet.db" 'pragma integrity_check;' 2>/dev/null)" = "ok" ]; then
    echo "  integrity ok, $(sqlite3 "$DEST/$NAME/fleet.db" 'select count(*) from results;') results"
  else
    echo "  THE COPY DOES NOT OPEN -- keeping it as $NAME-CORRUPT for inspection" >&2
    mv "$DEST/$NAME" "$DEST/$NAME-CORRUPT"
    exit 1
  fi
fi

COUNT=$(find "$DEST" -maxdepth 1 -type d -name 'brain-*' | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$DEST" -maxdepth 1 -type d -name 'brain-*' | sort | head -n "$((COUNT - KEEP))" | while read -r old; do
    rm -rf "$old"; echo "  pruned $(basename "$old")"
  done
fi
echo "  kept $(find "$DEST" -maxdepth 1 -type d -name 'brain-*' | wc -l | tr -d ' ') of $KEEP in $DEST"
