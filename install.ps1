# Fleet Runner's installer for Windows.
#
#   irm https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.ps1 | iex
#
#   $env:FLEET_VERSION = '0.5.0'          # a specific release rather than the latest
#   $env:FLEET_INSTALL_DIR = 'D:\fleet'   # somewhere other than $env:USERPROFILE\.fleet
#   irm https://raw.githubusercontent.com/addisdev/fleet-runner/main/install.ps1 | iex
#
# Environment variables rather than parameters, because `irm | iex` has nowhere
# to put an argument -- the script is a string being evaluated, not a command
# being invoked. install.sh reads the same two names.
#
# ## About the runtime
#
# **This script requires Node 22.13 or newer on PATH. The release does NOT ship
# its own runtime.** The reasoning is the same as install.sh's, and the two are
# deliberately identical: `.github/workflows/release.yml` builds no runtime, so
# neither installer may look for one. 22.13 is where `node:sqlite` stopped
# needing a flag, and the collector's database is `node:sqlite`.
#
# ## No administrator rights
#
# Everything is written under the install directory, which is inside the user
# profile by default, and the only thing touched outside it is the *user* PATH
# in HKCU -- which is per-user and needs no elevation. Nothing installs a
# service, writes to Program Files, or touches the machine PATH. If Windows
# prompts you for administrator rights while running this, something is wrong;
# stop and read it.
#
# ## What has not been checked
#
# This has never been run against a published release, because there is no
# published release yet, and the fleet CLI itself has never been run on Windows
# at all -- see fleet/README.md's Status section. Treat every line below as
# untested against the real thing.

$ErrorActionPreference = 'Stop'

$Repo = 'addisdev/fleet-runner'
$Releases = "https://github.com/$Repo/releases"

function Die([string]$Message) {
    Write-Host ''
    Write-Host "install.ps1: $Message" -ForegroundColor Red
    # `throw` rather than `exit`: under `irm | iex` this script is running inside
    # the user's own session, and `exit` there closes their shell.
    throw $Message
}

# Windows PowerShell 5.1 negotiates whatever ServicePointManager was left set
# to, which on older images is SSL3/TLS1.0 -- and github.com has refused those
# for years. The symptom is "The request was aborted: Could not create SSL/TLS
# secure channel", which reads like a network fault rather than a protocol one.
# PowerShell 7 defaults sensibly and this is a no-op there.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # A build with no ServicePointManager to configure is a build that already
    # negotiates TLS 1.2. Not worth failing over.
}

function Get-FleetArch {
    # PROCESSOR_ARCHITEW6432 is checked first because a 32-bit PowerShell host
    # on a 64-bit Windows reports PROCESSOR_ARCHITECTURE as x86 and puts the
    # real answer in the W6432 variable. Reading only the obvious one is how an
    # arm64 machine ends up being told it is unsupported.
    $raw = $env:PROCESSOR_ARCHITEW6432
    if (-not $raw) { $raw = $env:PROCESSOR_ARCHITECTURE }
    switch ($raw) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default {
            Die "$raw is not an architecture Fleet Runner publishes a release for.
  x64 and arm64 are built here. On anything else, clone the repository and run
  fleet from a checkout -- it is plain Node and has no native code."
        }
    }
}

function Test-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $null }
    try {
        $raw = (& node -v 2>$null | Select-Object -First 1)
    } catch {
        return $null
    }
    # `-match` rather than a negated test, so that reading $Matches immediately
    # after is unambiguously reading the match that just succeeded.
    if ($raw -match '^v?(\d+)\.(\d+)\.') {
        return [pscustomobject]@{
            Text  = $raw.Trim()
            Major = [int]$Matches[1]
            Minor = [int]$Matches[2]
        }
    }
    return $null
}

function Assert-Node {
    $v = Test-NodeVersion
    if ($v -and ($v.Major -gt 22 -or ($v.Major -eq 22 -and $v.Minor -ge 13))) {
        Write-Host "  node       $($v.Text)"
        return
    }
    $found = if ($v) { $v.Text } else { 'not on PATH' }
    Die "Fleet Runner needs Node 22.13 or newer, and this machine has: $found.

  22.13 is where node:sqlite lost its experimental flag, and the collector's
  database is node:sqlite -- an older Node does not fail politely, it fails at
  the first query.

  Install it from https://nodejs.org/ (or nvm-windows, or winget install
  OpenJS.NodeJS.LTS) and run this again. This release carries no runtime."
}

function Resolve-FleetVersion {
    if ($env:FLEET_VERSION) {
        # A leading v is what the tag looks like and what people paste; the
        # asset names carry the bare number.
        return ($env:FLEET_VERSION -replace '^v', '')
    }
    # Same trade-off as install.sh: the API rather than the /releases/latest
    # redirect, and the same escape hatch when the unauthenticated rate limit
    # bites -- set FLEET_VERSION and this call does not happen.
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    try {
        $latest = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers @{ 'User-Agent' = 'fleet-install' }
    } catch {
        Die "could not work out the latest version from $api ($($_.Exception.Message)).
  Either there is no published release yet, or this address is rate limited.
  Pick one from $Releases and set `$env:FLEET_VERSION = '<version>'."
    }
    if (-not $latest.tag_name) {
        Die "$api answered without a tag_name, so there is no version to install.
  Pick one from $Releases and set `$env:FLEET_VERSION = '<version>'."
    }
    return ($latest.tag_name -replace '^v', '')
}

function Install-Fleet {
    # PowerShell 6+ defines $IsWindows; 5.1 does not, and 5.1 only exists on
    # Windows. So an undefined value means Windows and a defined false means
    # somebody is running this from pwsh on a Mac, where install.sh is the
    # right script.
    if ((Test-Path variable:IsWindows) -and -not $IsWindows) {
        Die 'this is the Windows installer. On macOS and Linux use install.sh.'
    }

    $arch = Get-FleetArch

    # FLEET_INSTALL_DIR is the directory the release is unpacked *into*, and the
    # executable lands in its bin\. It is not the bin directory itself, and it
    # cannot be: fleet resolves runner-web\ and dash\dist\ relative to its own
    # location (see assetRoot() in fleet/src/paths.ts), so the layout has to
    # stay whole. Installing only the binary somewhere gives you a collector
    # that serves a blank dashboard.
    $dir = if ($env:FLEET_INSTALL_DIR) { $env:FLEET_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.fleet' }
    $dir = [System.IO.Path]::GetFullPath($dir)
    $bin = Join-Path $dir 'bin'

    $version = Resolve-FleetVersion
    # win32 rather than windows, to match process.platform -- which is the name
    # the rest of this project already spells the operating system with.
    $name = "fleet-$version-win32-$arch"
    $asset = "$name.zip"
    $base = "$Releases/download/v$version"

    Write-Host "Fleet Runner $version"
    Write-Host "  platform   win32/$arch"
    Write-Host "  install    $dir"
    Assert-Node

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("fleet-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Write-Host ''
        Write-Host "Downloading $asset"
        $zip = Join-Path $tmp $asset
        try {
            # -UseBasicParsing works on both hosts and, on 5.1, avoids taking a
            # dependency on Internet Explorer's engine having ever been run.
            Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -UseBasicParsing
        } catch {
            Die "could not download $base/$asset ($($_.Exception.Message)).
  Check that v$version exists at $Releases and publishes an asset for
  win32/$arch."
        }

        # Verification is not optional and there is no flag to skip it. This
        # downloads an archive over the network and then runs what is inside it;
        # a checksum that can be waved past is one that will be waved past on
        # exactly the download that needed it.
        $sumsFile = Join-Path $tmp 'SHASUMS256.txt'
        try {
            Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $sumsFile -UseBasicParsing
        } catch {
            Die "downloaded $asset but $base/SHASUMS256.txt is not there, so it
  cannot be verified. Refusing to install it."
        }

        # Lines are `<hex>  <name>`, with the name optionally prefixed by `*`
        # for a file sha256sum read in binary mode. The `*` is not part of it.
        $expected = $null
        foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
            $parts = $line -split '\s+', 2
            if ($parts.Count -lt 2) { continue }
            $named = $parts[1].Trim().TrimStart('*')
            if ($named -eq $asset) { $expected = $parts[0].Trim(); break }
        }
        if (-not $expected) {
            Die "SHASUMS256.txt for v$version does not list $asset, so there is
  nothing to check the download against. Refusing to install it."
        }
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($actual -ne $expected.ToUpperInvariant()) {
            Die "checksum mismatch for $asset.
    expected  $expected
    got       $actual
  Nothing has been installed. This is either a corrupted download or a file
  that is not the one the release published; retry, and if it happens again
  report it rather than working around it."
        }
        Write-Host '  sha256     ok'

        $unpack = Join-Path $tmp 'unpack'
        Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
        # The archive's single top-level directory is named for the asset, which
        # is a contract with release.yml: it builds the archive from a directory
        # of exactly this name.
        $root = Join-Path $unpack $name
        if (-not (Test-Path -LiteralPath $root)) {
            Die "the archive does not contain $name\ as expected.
  This is a packaging bug in the release, not something to work around here."
        }

        # The install directory and FLEET_HOME are the same directory by
        # default, so this replaces only the entries a release owns and never
        # the directory itself. Removing $dir wholesale would take config.json,
        # data\, artifacts\ and logs\ with it -- every result the fleet has ever
        # recorded -- and an upgrade that deletes your history is a worse
        # outcome than an upgrade that fails.
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        foreach ($entry in @('bin', 'runner-web', 'dash', 'examples', 'schemas')) {
            $from = Join-Path $root $entry
            if (-not (Test-Path -LiteralPath $from)) { continue }
            $to = Join-Path $dir $entry
            if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
            Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
        }

        # `fleet` as a command. Windows has no equivalent of the unix symlink
        # this project uses elsewhere -- a real symlink needs either developer
        # mode or elevation, which this installer will not ask for -- so the
        # shim is a .cmd, which PATHEXT makes runnable as plain `fleet`. cmd
        # propagates the exit code of its last command, so `fleet doctor` in a
        # batch file still reports what it decided.
        $shim = Join-Path $bin 'fleet.cmd'
        @(
            '@echo off'
            'node "%~dp0fleet.mjs" %*'
        ) | Set-Content -LiteralPath $shim -Encoding ASCII

        # Run the thing that was just installed. If the bundle is broken, or
        # Node cannot load it, that is worth finding out now rather than the
        # first time somebody types `fleet up`.
        $reported = (& $shim version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            Die "installed $shim but it does not run:`n$reported"
        }
        Write-Host "  installed  $shim (reports $reported)"
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    Add-ToUserPath $bin

    Write-Host ''
    Write-Host 'Next:  fleet up'
    Write-Host ''
    Write-Host '`fleet doctor` says what this machine can and cannot run, and why.'
}

function Add-ToUserPath([string]$Dir) {
    # This one differs from install.sh on purpose. On macOS and Linux the script
    # prints an `export PATH=...` line and lets you put it in the dotfile you
    # actually use, because it has no business rewriting a file it did not
    # write. Windows has no such file: the durable per-user PATH is a registry
    # value, this script is the only thing that would ever set it, and telling
    # somebody to open the environment-variables dialog is not an install.
    #
    # HKCU, so no elevation. The machine PATH is never touched.
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) { $entries = $current -split ';' | Where-Object { $_ -ne '' } }
    if ($entries -contains $Dir) {
        Write-Host "  path       already on your user PATH"
        return
    }
    [Environment]::SetEnvironmentVariable('Path', (@($entries + $Dir) -join ';'), 'User')
    # The registry change reaches new processes only, so this session gets the
    # directory too -- otherwise `fleet up` on the next line fails for somebody
    # who just watched the installer say it succeeded.
    $env:Path = "$env:Path;$Dir"
    Write-Host "  path       added $Dir to your user PATH"
    Write-Host "             (already live in this window; other open terminals need restarting)"
}

Install-Fleet
