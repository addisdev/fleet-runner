/**
 * The self-check's arithmetic and its parsing.
 *
 * The clock offset is the piece most worth pinning down: it is four
 * timestamps and a sign convention, and getting the sign backwards would
 * report a fast machine as slow — which the alert would still fire on, so
 * nothing would ever reveal it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  offsetMs, roundTripMs, readNtpTimestamp, clientPacket, NTP_EPOCH_OFFSET_S, ntpOffsetMs,
} from "../src/clock.js";
import {
  parseXcodebuildVersion, parseAdbVersion, parseGradleVersion, parseNodeVersion,
  parseLaunchctlList, parseSystemctlIsActive,
} from "../src/versions.js";
import { countFailed, toolCheck, agentLoadedCheck } from "../src/workloads/selfcheck.js";
import type { CheckRow } from "../src/protocol.js";

// --- clock -------------------------------------------------------------------

test("a perfectly synchronised clock with symmetric latency reads zero", () => {
  // Sent at 1000, server saw it at 1050, replied at 1050, we got it at 1100:
  // 100 ms round trip, no skew. Naively taking t2 - t1 would report 50 ms of
  // clock error that is really just half the network path.
  assert.equal(offsetMs({ t1: 1000, t2: 1050, t3: 1050, t4: 1100 }), 0);
  assert.equal(roundTripMs({ t1: 1000, t2: 1050, t3: 1050, t4: 1100 }), 100);
});

test("a positive offset means this machine is behind the server", () => {
  // The server is 500 ms ahead: it saw the request at 1550 and replied at 1550
  // while our clock went 1000 -> 1100.
  assert.equal(offsetMs({ t1: 1000, t2: 1550, t3: 1550, t4: 1100 }), 500);
});

test("a negative offset means this machine is ahead of the server", () => {
  assert.equal(offsetMs({ t1: 1000, t2: 550, t3: 550, t4: 1100 }), -500);
});

test("asymmetric server processing time does not become skew", () => {
  // The server held the request for 40 ms before replying. That is not clock
  // error, and the averaging removes it.
  assert.equal(offsetMs({ t1: 1000, t2: 1050, t3: 1090, t4: 1140 }), 0);
  assert.equal(roundTripMs({ t1: 1000, t2: 1050, t3: 1090, t4: 1140 }), 100);
});

test("an NTP timestamp round-trips against a known instant", () => {
  const buf = Buffer.alloc(48);
  const unixMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  buf.writeUInt32BE(Math.floor(unixMs / 1000) + NTP_EPOCH_OFFSET_S, 32);
  buf.writeUInt32BE(0, 36);
  assert.equal(readNtpTimestamp(buf, 32), unixMs);
});

test("the fractional half is a fraction of a second, not milliseconds", () => {
  const buf = Buffer.alloc(48);
  buf.writeUInt32BE(NTP_EPOCH_OFFSET_S, 32);
  buf.writeUInt32BE(2 ** 31, 36); // exactly half a second
  assert.equal(readNtpTimestamp(buf, 32), 500);
});

test("an all-zero timestamp is null, not the year 1900", () => {
  // An unsynchronised server sends zeros. Reading that as a real instant would
  // report an offset of about -3.9e12 ms and take the alert with it.
  assert.equal(readNtpTimestamp(Buffer.alloc(48), 32), null);
  assert.equal(readNtpTimestamp(Buffer.alloc(8), 32), null, "a short packet answers null too");
});

test("the request is a client-mode NTPv4 packet", () => {
  const p = clientPacket();
  assert.equal(p.length, 48);
  assert.equal(p[0] >> 6, 0, "leap indicator");
  assert.equal((p[0] >> 3) & 0b111, 4, "version 4");
  assert.equal(p[0] & 0b111, 3, "mode 3 = client");
});

test("an unreachable NTP host answers null rather than throwing", async () => {
  // 203.0.113.0/24 is TEST-NET-3: reserved for documentation, routed nowhere.
  assert.equal(await ntpOffsetMs("203.0.113.1", 300), null);
});

// --- tool versions -----------------------------------------------------------

test("xcodebuild's two lines become one version string", () => {
  assert.equal(parseXcodebuildVersion("Xcode 16.2\nBuild version 16C5032a\n"), "16.2 (16C5032a)");
  assert.equal(parseXcodebuildVersion("Xcode 15.4\n"), "15.4");
  assert.equal(parseXcodebuildVersion(null), null);
  assert.equal(parseXcodebuildVersion("xcode-select: error: tool 'xcodebuild' requires Xcode"), null);
});

test("adb reports the platform-tools version, not the protocol one", () => {
  // 1.0.41 has been the bridge protocol version for years and distinguishes
  // nothing; 35.0.2 is the install somebody may need to update.
  const text = "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /opt/adb\n";
  assert.equal(parseAdbVersion(text), "35.0.2-12147458");
  assert.equal(parseAdbVersion("Android Debug Bridge version 1.0.41\n"), "1.0.41");
  assert.equal(parseAdbVersion(null), null);
});

test("gradle's version survives its banner", () => {
  const text = [
    "", "------------------------------------------------------------",
    "Gradle 8.7", "------------------------------------------------------------",
    "", "Build time: 2024-03-22", "",
  ].join("\n");
  assert.equal(parseGradleVersion(text), "8.7");
  assert.equal(parseGradleVersion("Gradle 9.0-rc-1\n"), "9.0-rc-1");
  assert.equal(parseGradleVersion("command not found"), null);
});

test("node's leading v is not part of the version", () => {
  assert.equal(parseNodeVersion("v22.14.0\n"), "22.14.0");
  assert.equal(parseNodeVersion("22.14.0"), "22.14.0");
  assert.equal(parseNodeVersion(null), null);
});

// --- service manager ---------------------------------------------------------

test("launchctl: a running job reports its pid", () => {
  const plist = '{\n\t"PID" = 4711;\n\t"LastExitStatus" = 0;\n\t"Label" = "com.addisdev.fleet-runner-machine";\n};';
  assert.deepEqual(parseLaunchctlList(plist), { loaded: true, pid: 4711, lastExit: 0 });
});

test("launchctl: loaded but crash-looping is not the same as running", () => {
  // No PID and a non-zero last exit is a KeepAlive job that cannot start. The
  // dashboard would otherwise show a machine as fine because something else —
  // a hand-started `npm start` — is posting its beacons.
  assert.deepEqual(parseLaunchctlList('{\n\t"LastExitStatus" = 256;\n};'), {
    loaded: true, pid: null, lastExit: 256,
  });
});

test("launchctl: no output at all means the label is not loaded", () => {
  assert.deepEqual(parseLaunchctlList(null), { loaded: false, pid: null, lastExit: null });
});

test("systemctl: only active and activating count as loaded", () => {
  assert.deepEqual(parseSystemctlIsActive("active\n"), { loaded: true, state: "active" });
  // RestartSec=10 means a healthy agent spends seconds at a time activating.
  assert.deepEqual(parseSystemctlIsActive("activating\n"), { loaded: true, state: "activating" });
  assert.deepEqual(parseSystemctlIsActive("failed\n"), { loaded: false, state: "failed" });
  assert.deepEqual(parseSystemctlIsActive("inactive\n"), { loaded: false, state: "inactive" });
  assert.deepEqual(parseSystemctlIsActive("unknown\n"), { loaded: false, state: "unknown" });
  assert.deepEqual(parseSystemctlIsActive(null), { loaded: false, state: null });
});

// --- the count the alert rule reads ------------------------------------------

test("checks_failed counts failures and never skips", () => {
  const checks: CheckRow[] = [
    { name: "disk_free", ok: true, value: 400 },
    { name: "tool:xcodebuild", ok: null, detail: "not on PATH" },
    { name: "tool:adb", ok: null, detail: "not on PATH" },
    { name: "clock_offset", ok: false, value: 9000 },
    { name: "agent_loaded", ok: false },
  ];
  assert.equal(countFailed(checks), 2);
  assert.equal(countFailed([]), 0);
  assert.equal(countFailed(checks.filter((c) => c.ok !== false)), 0,
    "three skipped and one passing check is zero failures, not four");
});

test("a tool that is not installed is skipped, not failed", async () => {
  const row = await toolCheck("xcodebuild", ["-version"], parseXcodebuildVersion, { PATH: "" });
  assert.equal(row.name, "tool:xcodebuild");
  assert.equal(row.ok, null, "a Linux box has no Xcode; that is not a fault");
  assert.equal(countFailed([row]), 0);
});

test("a tool that is installed but answers nothing recognisable fails", async () => {
  // /usr/bin/true exists, runs, and prints nothing: a broken install, which is
  // the one thing this workload exists to notice.
  const row = await toolCheck("true", ["--version"], parseGradleVersion, { PATH: "/usr/bin:/bin" });
  assert.equal(row.ok, false);
  assert.equal(countFailed([row]), 1);
});

test("a platform with no service manager skips the agent check", async () => {
  const row = await agentLoadedCheck("win32", {});
  assert.equal(row.ok, null);
  assert.match(row.detail ?? "", /win32/);
});

test("a Linux box without systemctl skips rather than fails the agent check", async () => {
  const row = await agentLoadedCheck("linux", { PATH: "" });
  assert.equal(row.ok, null);
});
