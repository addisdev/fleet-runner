#!/bin/bash
# Generate FleetRunner.xcodeproj from whichever spec this machine can build.
#
# The llama.cpp xcframework is 850 MB and gitignored, and Xcode treats a
# declared-but-missing XCFramework as a hard build error rather than skipping
# it. So the framework is named in project.llama.yml only, and this script
# picks that spec when the framework is actually here.
#
# Without it you get a working runner with the synthetic and Core ML backends;
# the LLM workloads report that their backend is unavailable, which is the
# honest answer rather than a link error.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Homebrew's bin is not on a non-interactive PATH (ssh, launchd), and a bare
# `xcodegen` there fails in a way that looks like the project is fine.
XCODEGEN="$(command -v xcodegen || echo /opt/homebrew/bin/xcodegen)"
[ -x "$XCODEGEN" ] || {
  echo "xcodegen not found. brew install xcodegen" >&2
  exit 1
}

if [ -d Frameworks/llama.xcframework ]; then
  echo "== llama.xcframework present — generating with the llama.cpp backend"
  exec "$XCODEGEN" generate --spec project.llama.yml
else
  echo "== no llama.xcframework — generating without the llama.cpp backend"
  echo "   (synthetic and Core ML backends still build; see project.llama.yml"
  echo "    for how to build the framework)"
  exec "$XCODEGEN" generate --spec project.yml
fi
