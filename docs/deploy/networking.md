# Networking

Two things here cost an evening each to diagnose, and both look exactly like an
ordinary network problem.

## macOS gates local-network access, and launchd cannot ask

**The symptom.** The same Node binary that reaches the collector's LAN address
perfectly from Terminal gets `EHOSTUNREACH` when launchd starts it. Confirmed by
running the identical fetch both ways.

**The cause.** macOS 26 and later gate local-network access per application, and
a process started by launchd has no grant and **no way to prompt for one**.
There is no error that says so; the connection simply fails as though the host
were unreachable.

**The workaround that is deployed.** Loopback is not gated. So a tunnel forwards
a local port to the collector and the executor talks to `127.0.0.1`:

```
deploy/install-agent.sh com.addisdev.fleet-tunnel.plist
```

The executor's `FLEET_URL` then points at the forwarded loopback port rather
than at the LAN address.

**The cleaner fix**, if you have a human at the keyboard: grant Local Network
access to `node` in System Settings and point `FLEET_URL` back at the LAN
address. The tunnel can then be removed. It is not what ships because it cannot
be done over SSH.

The same tunnel carries a **reverse** forward, which is how alerts reach a
desktop notification on the machine somebody is actually looking at rather than
dying on a headless host. See [Alerts](alerts.md).

## Network shaping

Any host job may carry `params.network`: `offline`, `offline-after-<n>s`, `3g`
or `lossy`.

It is applied before the workload and always restored in a `finally`, and the
intent is journalled before the device is touched, so a crash between the two is
recoverable. The executor restores every attached device on startup, before its
first claim — **a phone left offline by a crashed executor is a phone that looks
dead forever.**

**An unknown profile name throws.** A typo that silently ran unshaped would turn
an offline test into a test that proves nothing and still passes, which is the
one outcome worth engineering against here.

### What is actually reachable is narrower than the vocabulary

| Profile | Android device | iOS simulator | iOS device |
|---|---|---|---|
| `offline` | `svc wifi disable`, verified afterwards | not supported | not supported |
| `3g` / `lossy` | refused | host `dnctl`/`pfctl`, opt-in | refused |

The refusals are deliberate:

- **`offline` is refused on an adb-tcp serial.** Disabling wifi there cuts the
  executor's own control channel, leaving no way to restore and a permanently
  stranded phone.
- **`3g` and `lossy` on a real phone are refused, not approximated.** In-device
  shaping needs root, and host dummynet only shapes traffic that transits the
  Mac, which a phone on wifi does not.
- **`simctl status_bar override --dataNetwork` is not used.** It redraws the
  status-bar icon and changes no packet — the purest form of the fake-offline
  trap this module exists to avoid.

### Host-side shaping is opt-in and needs one-time setup

The `dnctl`/`pfctl` path is gated on three preconditions it **verifies rather
than assumes**, because pf silently ignores rules loaded into an anchor nothing
references — a no-op that looks exactly like success:

1. `FLEET_NET_SHAPE_HOST=1`
2. passwordless sudo for `dnctl` and `pfctl`
3. a `fleet-shape` anchor actually referenced in `/etc/pf.conf`:

```
dummynet-anchor "fleet-shape"
anchor "fleet-shape"
```

The executor will not edit `/etc/pf.conf` itself. Shaping also requires a scoped
destination (`params.network_to`, or `targets.url`); unscoped, it would shape the
executor's own link to the collector and to adb.

!!! warning "This path is reasoned through but has not been run"

    Adding the anchor and exercising it once by hand is worth doing before a
    schedule depends on it.

## Reaching the collector from a phone

Runner apps default to `http://127.0.0.1:8788` and take the host's address in
their own settings screen, so nothing is baked into a binary.

- A **simulator** reaches loopback directly, because it shares the Mac's network
  stack.
- An **Android device on USB** can use `adb reverse tcp:8788 tcp:8788`.
- A **device on the network** needs the host's `.local` name or its tailnet
  address. Give the host a DHCP reservation, or use the `.local` name — a lease
  change would otherwise strand every device at once.

The dashboard's enrolment screen (`/dash/devices/new`) shows a QR code of an
address derived from **the host's own network interfaces**, not from the
browser's origin. View the dashboard through an SSH tunnel and your origin is
`127.0.0.1`, which is a fine URL for you and a useless one for a phone.
