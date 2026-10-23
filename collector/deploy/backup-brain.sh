#!/bin/sh
# Back up everything about a brain that is not reproducible.
#
# Three things, and the second is the one people forget:
#
#   1. The database. Every result the fleet has ever measured. Copied with
#      sqlite3's own `.backup`, not `cp`, because the collector is running and
#      writing: a plain copy of a WAL-mode database mid-transaction is a file
#      that restores into a page it cannot read.
#   2. The suites. Maestro flows and Playwright specs live in the collector's
#      flows/ and web-specs/ directories and **are not in git** -- they name
#      the apps under test, which is why they were never published. On the
#      fleet this was written for, the only copy in existence was on one 2016
#      laptop. Losing it would mean every nightly still ran and tested nothing.
#   3. The config. `~/.fleet/config.json`, which is now where the deployment
#      lives -- roles, ports, the env map that points at everything above.
#
# Artifacts are deliberately NOT here. They are content-addressed, they are
# most of a gigabyte, and the useful ones are referenced by a baseline or a
# result row that this backup already carries. Copying them nightly would turn
# a five-second job into a long one and fill the disk it is protecting.
#
# Usage:  backup-brain.sh [destination]     (default: ~/fleet-backups)
#
# Environment:
#   FLEET_BACKUP_KEEP     how many to keep (default 14)
#   FLEET_HOME            where config.json lives (default ~/.fleet)
#   FLEET_BACKUP_NO_DB    1 on a host that runs no brain but keeps the suites
#                         (fleet-host since 2026-10-21: its executor still runs
#                         the flows and specs). Without it, a brain that does
#                         not answer is a failure, never a quiet suites-only run
#   FLEET_BACKUP_OUTBOX   path to an outbox sealer (`outbox.sh <app> <stamp>
#                         <path>`, as on ultra) to hand each backup to the
#                         off-site pull. Unset: no off-site copy from here
#   FLEET_BACKUP_OUTBOX_APP  the bundle name in the outbox (default fleet-brain)
set -eu

DEST="${1:-$HOME/fleet-backups}"
KEEP="${FLEET_BACKUP_KEEP:-14}"
FLEET_HOME="${FLEET_HOME:-$HOME/.fleet}"
STAMP=$(date +%Y%m%d-%H%M%S)

# Read the collector's own answer for where things are rather than assuming the
# default layout. A brain that adopted an older collector's directories -- which
# is how this one was migrated -- has them somewhere else entirely, and a backup
# that confidently copied the empty default would look like it worked.
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$FLEET_HOME/config.json" 2>/dev/null | head -1)
PORT="${PORT:-8788}"
SYSTEM=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/system" 2>/dev/null || true)

field() { printf '%s' "$SYSTEM" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
DATA_DIR=$(field data_dir)
if [ -z "$DATA_DIR" ] && [ "${FLEET_BACKUP_NO_DB:-0}" = "1" ] && [ -z "${FLEET_DATA_DIR:-}" ]; then
  echo "backup-brain: no brain on this host (FLEET_BACKUP_NO_DB=1); suites and config only"
elif [ -z "$DATA_DIR" ]; then
  echo "backup-brain: the collector on port $PORT did not answer /api/system." >&2
  echo "  A brain that is down is not a reason to skip the backup, but its data" >&2
  echo "  directory has to come from somewhere. Set FLEET_DATA_DIR and re-run." >&2
  DATA_DIR="${FLEET_DATA_DIR:-}"
  [ -n "$DATA_DIR" ] || exit 1
fi

envval() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$FLEET_HOME/config.json" 2>/dev/null | head -1; }
FLOWS=$(envval FLEET_FLOWS_DIR)
SPECS=$(envval FLEET_WEB_SPECS_DIR)

mkdir -p "$DEST"
OUT="$DEST/brain-$STAMP"
mkdir -p "$OUT"

echo "backup-brain -> $OUT"

# 1. the database
if [ -z "$DATA_DIR" ]; then
  echo "  fleet.db        none: this host runs no brain"
elif [ -f "$DATA_DIR/fleet.db" ]; then
  sqlite3 "$DATA_DIR/fleet.db" ".backup '$OUT/fleet.db'"
  # A backup nobody checked is a file, not a backup.
  if [ "$(sqlite3 "$OUT/fleet.db" 'pragma integrity_check;')" != "ok" ]; then
    echo "backup-brain: the copy failed its integrity check; keeping it for inspection" >&2
    mv "$OUT" "$OUT-CORRUPT"
    exit 1
  fi
  echo "  fleet.db        $(wc -c < "$OUT/fleet.db" | tr -d ' ') bytes, integrity ok"
else
  echo "  fleet.db        MISSING at $DATA_DIR/fleet.db" >&2
fi

# 2. the suites, and 3. the config
[ -n "$FLOWS" ] && [ -d "$FLOWS" ] && { tar -czf "$OUT/flows.tar.gz" -C "$(dirname "$FLOWS")" "$(basename "$FLOWS")"; echo "  flows.tar.gz    from $FLOWS"; }
[ -n "$SPECS" ] && [ -d "$SPECS" ] && { tar -czf "$OUT/web-specs.tar.gz" -C "$(dirname "$SPECS")" "$(basename "$SPECS")"; echo "  web-specs.tar.gz from $SPECS"; }
[ -f "$FLEET_HOME/config.json" ] && { cp "$FLEET_HOME/config.json" "$OUT/config.json"; echo "  config.json"; }

# What this backup was taken from, so a restore does not have to guess.
{
  echo "taken     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host      $(hostname)"
  echo "data_dir  ${DATA_DIR:-<none: no brain on this host>}"
  echo "flows     ${FLOWS:-<unset>}"
  echo "specs     ${SPECS:-<unset>}"
  echo "fleet     $("$FLEET_HOME/bin/fleet" version 2>/dev/null | head -1 || echo unknown)"
} > "$OUT/MANIFEST.txt"

# Off-site. The sealer encrypts and verifies; this only hands it one gzip of
# the directory (a sqlite file shrinks a lot, and the outbox pays per byte on
# both machines). A failed hand-off fails the run: the local copy is fine, but
# nobody would otherwise notice the off-site one had stopped.
if [ -n "${FLEET_BACKUP_OUTBOX:-}" ]; then
  APP="${FLEET_BACKUP_OUTBOX_APP:-fleet-brain}"
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/fleet-outbox.XXXXXX")
  tar -czf "$TMP/brain-$STAMP.tar.gz" -C "$DEST" "brain-$STAMP"
  if "$FLEET_BACKUP_OUTBOX" "$APP" "$(date -u +%Y-%m-%dT%H%M%SZ)" "$TMP/brain-$STAMP.tar.gz"; then
    echo "  outbox          sealed as $APP ($(wc -c < "$TMP/brain-$STAMP.tar.gz" | tr -d ' ') bytes before encryption)"
    rm -rf "$TMP"
  else
    rm -rf "$TMP"
    echo "backup-brain: the outbox refused the bundle; the local copy is kept" >&2
    OUTBOX_FAILED=1
  fi
fi

# Rotation. Sorted by name, which is sorted by time because the stamp leads.
COUNT=$(find "$DEST" -maxdepth 1 -type d -name 'brain-*' | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$DEST" -maxdepth 1 -type d -name 'brain-*' | sort | head -n "$((COUNT - KEEP))" | while read -r old; do
    rm -rf "$old"
    echo "  pruned $(basename "$old")"
  done
fi

echo "  kept $(find "$DEST" -maxdepth 1 -type d -name 'brain-*' | wc -l | tr -d ' ') of $KEEP"
[ -z "${OUTBOX_FAILED:-}" ] || exit 1
