#!/bin/sh
# Fleet Runner's installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.sh | sh
#   FLEET_VERSION=0.5.0 sh install.sh     # a specific release rather than the latest
#   FLEET_INSTALL_DIR=/opt/fleet sh install.sh
#
# ## About the runtime -- the one decision worth stating up front
#
# **This script requires Node 22.13 or newer on PATH. The release does NOT ship
# its own runtime.**
#
# `fleet/src/paths.ts` reserves `~/.fleet/runtime` for a private Node, and that
# is still the better end state. It is not what this installs, because bundling
# a runtime means downloading and re-publishing an official Node build for four
# platform pairs, carrying its licence, and keeping it patched -- and none of
# that has been done or tested. `.github/workflows/release.yml` therefore builds
# no runtime, and this script does not look for one. The two agree, which is the
# property that matters: an installer that prefers a bundled runtime a workflow
# never produced fails on a machine with no Node, saying something that is not
# true.
#
# 22.13 is not an arbitrary floor. It is the release where `node:sqlite` stopped
# needing a flag, and the collector's database is `node:sqlite`.
#
# ## No sudo, anywhere
#
# Nothing here writes outside the install directory, which is under $HOME by
# default. That is deliberate and it is project-wide: the collector has no
# system service, no /usr/local writes and no privileged ports, so an installer
# that asked for a password would be asking for something the software never
# uses. If you point FLEET_INSTALL_DIR at a system path, create it and make it
# yours first -- this script will not escalate to do it for you.
#
# ## Why everything is inside main()
#
# `curl | sh` feeds the shell a stream. A connection that drops halfway leaves
# the shell having already run whatever it read, so a script that executes as it
# is parsed can half-install. Defining functions and calling `main "$@"` on the
# very last line means a truncated download runs nothing at all.

set -eu

REPO="addisdev/fleet-runner"
RELEASES="https://github.com/${REPO}/releases"

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# --- fetching --------------------------------------------------------------
#
# curl or wget, whichever is there. `--proto '=https' --tlsv1.2` on the curl
# path refuses a plaintext redirect: this script downloads something it is about
# to execute, so a downgrade has to be an error rather than a fallback.

fetch_to_file() { # url dest
  if have curl; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif have wget; then
    wget -q --https-only -O "$2" "$1"
  else
    die "neither curl nor wget is installed, so nothing can be downloaded"
  fi
}

fetch_to_stdout() { # url
  if have curl; then
    curl -fsSL --proto '=https' --tlsv1.2 "$1"
  elif have wget; then
    wget -q --https-only -O - "$1"
  else
    die "neither curl nor wget is installed, so nothing can be downloaded"
  fi
}

# --- what machine is this --------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *)
      die "$(uname -s) is not a platform Fleet Runner publishes a release for.
  macOS and Linux are built here, Windows is install.ps1. On anything else,
  clone the repository and run fleet from a checkout -- it is plain Node."
      ;;
  esac
}

detect_arch() {
  # `uname -m` is the only portable answer, and it spells the same two
  # architectures four ways depending on who is asking.
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *)
      die "$(uname -m) is not an architecture Fleet Runner publishes a release for.
  x86_64 and arm64 are built here. On anything else, clone the repository and
  run fleet from a checkout -- it is plain Node and has no native code."
      ;;
  esac
}

# --- node ------------------------------------------------------------------

node_version_ok() {
  if ! have node; then
    return 1
  fi
  v="$(node -v 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  # Written as if-blocks rather than `[ ... ] && return 0`, because under
  # `set -e` a trailing && list that evaluates false takes the shell down with
  # it -- which here would look like the installer crashing on old Node rather
  # than explaining it.
  case "$major$minor" in
    *[!0-9]*) return 1 ;; # a version string this cannot parse is not a pass
  esac
  if [ "$major" -gt 22 ]; then
    return 0
  fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; then
    return 0
  fi
  return 1
}

require_node() {
  if node_version_ok; then
    say "  node       $(node -v)"
    return 0
  fi
  if have node; then
    found="$(node -v 2>/dev/null || printf 'unreadable')"
  else
    found="not on PATH"
  fi
  die "Fleet Runner needs Node 22.13 or newer, and this machine has: ${found}.

  22.13 is where node:sqlite lost its experimental flag, and the collector's
  database is node:sqlite -- an older Node does not fail politely, it fails at
  the first query.

  Install it from https://nodejs.org/ (or nvm, fnm, or your package manager)
  and run this script again. This release does not carry its own runtime."
}

# --- checksums -------------------------------------------------------------
#
# Verification is not optional and there is no flag to skip it. This script
# downloads an archive over the network and then runs what is inside it; a
# checksum that can be waved past is a checksum that will be waved past on
# exactly the download that needed it.

sha256_of() { # file
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then
    openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else
    die "no sha256sum, shasum or openssl on this machine, so the download
  cannot be verified -- and this installer does not install unverified files.
  Install one of them, or download the release by hand from ${RELEASES}."
  fi
}

# --- version ---------------------------------------------------------------

resolve_version() {
  if [ -n "${FLEET_VERSION:-}" ]; then
    # A leading v is what the tag looks like and what people paste, but the
    # asset names carry the bare number.
    printf '%s' "${FLEET_VERSION#v}"
    return 0
  fi
  # The GitHub API rather than the /releases/latest redirect, because the
  # redirect is only readable with curl's `-w %{url_effective}` and this script
  # also has to work under wget. The cost is the unauthenticated rate limit --
  # 60 requests an hour per address, shared by everything behind one NAT. When
  # that is what bites, `FLEET_VERSION=0.5.0` skips this call entirely.
  api="https://api.github.com/repos/${REPO}/releases/latest"
  tag="$(fetch_to_stdout "$api" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)"
  if [ -z "$tag" ]; then
    die "could not work out the latest version from ${api}.
  Either there is no published release yet, or this address is rate limited.
  Pick one from ${RELEASES} and set FLEET_VERSION=<version>."
  fi
  printf '%s' "${tag#v}"
}

# --- PATH ------------------------------------------------------------------

on_path() { # dir
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# The file to suggest, per shell. Suggested and never edited: this script has no
# business rewriting a dotfile it did not write, and getting that wrong is the
# kind of thing somebody discovers weeks later in a login shell that no longer
# starts.
path_hint_file() {
  case "${SHELL:-}" in
    */zsh) printf '~/.zshrc' ;;
    */bash) printf '~/.bashrc (or ~/.bash_profile on macOS)' ;;
    */fish) printf '~/.config/fish/config.fish' ;;
    *) printf 'your shell profile' ;;
  esac
}

# --- the install itself ----------------------------------------------------

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"

  # FLEET_INSTALL_DIR is the directory the release is unpacked *into*, and the
  # executable lands in its bin/. It is not the bin directory itself, and it
  # cannot be: fleet resolves runner-web/ and dash/dist/ relative to its own
  # location (see assetRoot() in fleet/src/paths.ts), so the layout has to stay
  # whole. Installing only the binary somewhere gives you a collector that
  # serves a blank dashboard.
  dir="${FLEET_INSTALL_DIR:-${HOME}/.fleet}"
  bin="${dir}/bin"

  # This script does `rm -rf "$dir/bin"` below to replace an old install. A
  # FLEET_INSTALL_DIR of "/" would make that `rm -rf /bin`, so the value is
  # checked once here rather than trusted five lines later.
  case "$dir" in
    "" | "/") die "FLEET_INSTALL_DIR is ${dir:-empty}, which is not somewhere this will install." ;;
    /*) ;;
    *) die "FLEET_INSTALL_DIR must be an absolute path; got '${dir}'." ;;
  esac

  version="$(resolve_version)"
  asset="fleet-${version}-${os}-${arch}.tar.gz"
  base="${RELEASES}/download/v${version}"

  say "Fleet Runner ${version}"
  say "  platform   ${os}/${arch}"
  say "  install    ${dir}"
  require_node

  tmp="$(mktemp -d)"
  # INT and TERM as well as EXIT: a Ctrl-C halfway through a download should not
  # leave a hundred megabytes in /tmp.
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say ""
  say "Downloading ${asset}"
  if ! fetch_to_file "${base}/${asset}" "${tmp}/${asset}"; then
    die "could not download ${base}/${asset}.
  Check that v${version} exists at ${RELEASES} and publishes an asset for
  ${os}/${arch}."
  fi

  # Every release publishes one SHASUMS256.txt covering all of its assets, so
  # this is one extra request regardless of how many platforms exist.
  if ! fetch_to_file "${base}/SHASUMS256.txt" "${tmp}/SHASUMS256.txt"; then
    die "downloaded ${asset} but ${base}/SHASUMS256.txt is not there, so it
  cannot be verified. Refusing to install it."
  fi

  # `$2` is the filename column. The leading `*` is what sha256sum writes for a
  # file it read in binary mode, and it is not part of the name.
  expected="$(awk -v want="$asset" '$2 == want || $2 == "*" want { print $1 }' "${tmp}/SHASUMS256.txt" | head -n 1)"
  if [ -z "$expected" ]; then
    die "SHASUMS256.txt for v${version} does not list ${asset}, so there is
  nothing to check the download against. Refusing to install it."
  fi
  actual="$(sha256_of "${tmp}/${asset}")"
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for ${asset}.
    expected  ${expected}
    got       ${actual}
  Nothing has been installed. This is either a corrupted download or a file
  that is not the one the release published; retry, and if it happens again
  report it rather than working around it."
  fi
  say "  sha256     ok"

  mkdir -p "${tmp}/unpack"
  tar -xzf "${tmp}/${asset}" -C "${tmp}/unpack"
  # The archive's single top-level directory is named for the asset, which is a
  # contract with release.yml: it builds the archive from a directory of exactly
  # this name. Relying on it avoids `--strip-components`, which busybox tar on
  # a small Linux box does not always have.
  root="${tmp}/unpack/fleet-${version}-${os}-${arch}"
  [ -d "$root" ] || die "the archive does not contain fleet-${version}-${os}-${arch}/ as expected.
  This is a packaging bug in the release, not something to work around here."

  # The install directory and FLEET_HOME are the same directory by default, so
  # this replaces only the entries a release owns and never the directory
  # itself. `rm -rf "$dir"` would take config.json, data/, artifacts/ and logs/
  # with it -- every result the fleet has ever recorded -- and an upgrade that
  # deletes your history is a worse outcome than an upgrade that fails.
  mkdir -p "$dir"
  for entry in bin runner-web dash examples schemas; do
    if [ -d "${root}/${entry}" ]; then
      rm -rf "${dir:?}/${entry}"
      cp -R "${root}/${entry}" "${dir}/${entry}"
    fi
  done

  chmod +x "${bin}/fleet.mjs"
  # `fleet` beside `fleet.mjs`. The archive ships this link already; recreating
  # it is idempotent and covers an archive built before it did. A symlink rather
  # than a copy, because Node resolves it before setting import.meta.url, so
  # assetRoot() still lands on the install directory.
  ln -sf fleet.mjs "${bin}/fleet"

  # Run the thing that was just installed. If the bundle is broken, or Node
  # cannot load it, that is worth finding out now rather than the first time
  # somebody types `fleet up`.
  installed="$("${bin}/fleet" version 2>&1)" || die "installed ${bin}/fleet but it does not run:
${installed}"
  say "  installed  ${bin}/fleet (reports ${installed})"

  say ""
  if on_path "$bin"; then
    say "Next:  fleet up"
  else
    say "${bin} is not on your PATH. Add it:"
    say ""
    say "    export PATH=\"${bin}:\$PATH\"     # in $(path_hint_file)"
    say ""
    say "Next:  ${bin}/fleet up"
  fi
  say ""
  say "\`fleet doctor\` says what this machine can and cannot run, and why."
}

main "$@"
