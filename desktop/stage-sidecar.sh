#!/bin/sh
# Put `fleet` where the Tauri bundler expects a sidecar.
#
# This exists because a Tauri sidecar is ONE executable file copied into
# Fleet.app/Contents/MacOS/, and `fleet` is not one file. `fleet/build.mjs`
# emits a tree -- bin/fleet.mjs beside dash/dist, runner-web, examples and
# schemas -- and it keeps that relative layout on purpose, because
# `assetRoot()` in fleet/src/paths.ts resolves the dashboard and the browser
# runner against the bundle's own directory. Copy only the .mjs and you get a
# collector that starts, serves the API, and 404s the dashboard.
#
# So the sidecar is a shim. The tree goes in as an app resource, the shim finds
# it, and node is exec'd on bin/fleet.mjs from inside it, which puts assetRoot()
# back over the layout it expects.
#
#   ./stage-sidecar.sh          build fleet from this checkout and stage it
#   ./stage-sidecar.sh --skip-build   stage whatever is already in fleet/dist
#
# Then: cargo tauri dev   (or cargo tauri build)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
out="$here/src-tauri"

# The bundler looks for `binaries/fleet-<target triple>` and copies it in as
# plain `fleet`. A missing suffix is not an error you get told about clearly --
# it is "the sidecar could not be found" at runtime.
if command -v rustc >/dev/null 2>&1; then
  triple=$(rustc -vV | awk '/^host: /{print $2}')
else
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)  triple=aarch64-apple-darwin ;;
    Darwin/x86_64) triple=x86_64-apple-darwin ;;
    Linux/x86_64)  triple=x86_64-unknown-linux-gnu ;;
    Linux/aarch64) triple=aarch64-unknown-linux-gnu ;;
    *) echo "no rustc, and $(uname -s)/$(uname -m) is not one of the guesses. Install Rust." >&2; exit 1 ;;
  esac
  echo "note: rustc is not on PATH; guessing the target triple as $triple"
fi

if [ "${1:-}" != "--skip-build" ]; then
  echo "building fleet..."
  ( cd "$repo/fleet" && [ -d node_modules ] || npm install )
  ( cd "$repo/fleet" && node build.mjs )
fi

if [ ! -f "$repo/fleet/dist/bin/fleet.mjs" ]; then
  echo "$repo/fleet/dist/bin/fleet.mjs is missing. Run this without --skip-build." >&2
  exit 1
fi

echo "staging the fleet tree..."
rm -rf "$out/resources/fleet"
mkdir -p "$out/resources" "$out/binaries"
cp -R "$repo/fleet/dist" "$out/resources/fleet"

echo "writing the shim: binaries/fleet-$triple"
cat > "$out/binaries/fleet-$triple" <<'SHIM'
#!/bin/sh
# The Tauri sidecar. Finds the staged fleet tree and the Node to run it with.
set -eu
self=$(cd "$(dirname "$0")" && pwd)

# Contents/MacOS -> Contents/Resources on macOS; alongside the binary on Linux
# and in a dev build. Every candidate is listed rather than one being assumed,
# because "the sidecar is not where the bundler put it" and "the sidecar is
# broken" produce the same silence otherwise.
tree=""
for candidate in \
  "$self/../Resources/fleet" \
  "$self/../Resources/resources/fleet" \
  "$self/../lib/fleet" \
  "$self/../resources/fleet"
do
  if [ -f "$candidate/bin/fleet.mjs" ]; then tree=$candidate; break; fi
done
if [ -z "$tree" ]; then
  echo "fleet sidecar: no bin/fleet.mjs found near $self. Run desktop/stage-sidecar.sh and rebuild." >&2
  exit 127
fi

# An app launched from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin and
# nothing else -- the same class of problem docs/deploy records for launchd,
# which "does not read your login PATH". A Homebrew node in /opt/homebrew/bin
# is invisible here, so the usual places are checked by hand before PATH is
# trusted. ~/.fleet/runtime is where install.sh puts a private Node.
node=""
for candidate in \
  "${FLEET_NODE:-}" \
  "${FLEET_HOME:-$HOME/.fleet}/runtime/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node=$candidate; break; fi
done
[ -n "$node" ] || node=$(command -v node 2>/dev/null || true)
if [ -z "$node" ]; then
  echo "fleet sidecar: no node found. Fleet needs Node 22.13 or newer -- that is the release where node:sqlite lost its flag, and the collector's database is node:sqlite. Install it, or set FLEET_NODE." >&2
  exit 127
fi

exec "$node" "$tree/bin/fleet.mjs" "$@"
SHIM
chmod +x "$out/binaries/fleet-$triple"

echo
echo "  $out/resources/fleet          $(du -sh "$out/resources/fleet" | cut -f1)"
echo "  $out/binaries/fleet-$triple"
echo
echo "Now: cd desktop/src-tauri && cargo tauri dev"
