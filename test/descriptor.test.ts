/**
 * The descriptor's contract is that it always answers. Whatever is missing —
 * /proc on a Mac, system_profiler on Linux, wmic anywhere but Windows — comes
 * back null and registration still happens, because an agent that refuses to
 * start on an unfamiliar machine is not an agent you can drop on a laptop.
 *
 * Every case below asks for a platform this test is not running on, which is
 * the cheapest way to make every probe fail at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, APP_VER, mbFromSizeString, wmicValue } from "../src/descriptor.js";
import { parsePmsetBatt, speedLimitToThermal, celsiusToThermal, loadOneMinute, idleSeconds, beacon } from "../src/telemetry.js";
import { firstMatch, finite, run, out, readText, orNull } from "../src/probe.js";
import { defaultDeviceId } from "../src/agent.js";

const FOREIGN: NodeJS.Platform[] = ["linux", "win32", "darwin", "aix"];

for (const platform of FOREIGN) {
  test(`describe("${platform}") never throws and always carries the match fields`, async () => {
    const d = await describe(platform);
    for (const key of ["model", "soc", "ram_mb", "os", "app_ver", "kind", "arch", "gpu", "vram_mb", "cpu_cores"]) {
      assert.ok(key in d, `descriptor is missing ${key}`);
    }
    assert.equal(d.app_ver, APP_VER);
    // These are set from Node itself, so they are answerable on any platform.
    assert.equal(typeof d.arch, "string");
    assert.ok(d.ram_mb === null || d.ram_mb > 0);
    // Everything else is either a real answer or an honest null, never junk.
    for (const v of [d.model, d.soc, d.os, d.gpu]) assert.ok(v === null || typeof v === "string");
    assert.ok(d.kind === null || d.kind === "laptop" || d.kind === "desktop");
  });
}

test("a beacon for a foreign platform is all nulls, not an error", async () => {
  const s = await beacon("aix");
  assert.equal(s.battery_pct, null);
  assert.equal(s.charging, null);
  assert.equal(s.thermal, null);
  assert.equal(s.on_ac, null);
  assert.equal(s.idle_s, null);
  // load_1m and disk_free_gb come from Node, so they answer everywhere but Windows.
  assert.ok(s.disk_free_gb === null || s.disk_free_gb > 0);
});

test("a beacon on this machine carries the fields the collector's constraints read", async () => {
  const s = await beacon();
  for (const key of ["battery_pct", "charging", "thermal", "on_ac", "idle_s", "load_1m", "disk_free_gb"]) {
    assert.ok(key in s, `beacon is missing ${key}`);
  }
});

test("a probe that cannot run reports null rather than throwing", async () => {
  assert.equal((await run("definitely-not-a-real-binary-xyz", [])).code, null);
  assert.equal(await out("definitely-not-a-real-binary-xyz", []), null);
  assert.equal(await readText("/definitely/not/a/file"), null);
  assert.equal(await orNull(async () => { throw new Error("boom"); }), null);
  assert.equal(firstMatch(null, /(x)/), null);
  assert.equal(finite("not a number"), null);
  assert.equal(finite(undefined), null);
  // Number(null) and Number("") are both 0, which would read as a machine with
  // no RAM rather than a probe that found nothing.
  assert.equal(finite(null), null);
  assert.equal(finite(""), null);
  assert.equal(finite("   "), null);
  assert.equal(finite("42"), 42);
  assert.equal(finite(0), 0);
});

test("a command that exits non-zero is null, not its stdout", async () => {
  assert.equal(await out("/usr/bin/false", []), null);
});

test("pmset output: a laptop on mains", () => {
  const p = parsePmsetBatt(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t94%; charging; 0:23 remaining present: true\n",
  );
  assert.equal(p.battery_pct, 94);
  assert.equal(p.charging, true);
  assert.equal(p.on_ac, true);
});

test("pmset output: a laptop on battery is not charging", () => {
  const p = parsePmsetBatt(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t61%; discharging; 3:02 remaining present: true\n",
  );
  assert.equal(p.battery_pct, 61);
  assert.equal(p.charging, false, "'discharging' contains 'charging' and must not be read as it");
  assert.equal(p.on_ac, false);
});

test("pmset output: a desktop has no battery, which is not 0%", () => {
  const p = parsePmsetBatt("Now drawing from 'AC Power'\n");
  assert.equal(p.battery_pct, null);
  assert.equal(p.on_ac, true);
});

test("pmset output: nothing at all is nothing at all", () => {
  assert.deepEqual(parsePmsetBatt(null), {});
});

test("the thermal mappings are the documented thresholds", () => {
  assert.equal(speedLimitToThermal(100), "nominal");
  assert.equal(speedLimitToThermal(80), "fair");
  assert.equal(speedLimitToThermal(60), "serious");
  assert.equal(speedLimitToThermal(30), "critical");
  assert.equal(celsiusToThermal(45), "nominal");
  assert.equal(celsiusToThermal(80), "fair");
  assert.equal(celsiusToThermal(90), "serious");
  assert.equal(celsiusToThermal(101), "critical");
});

test("macOS thermal reads on this machine, one way or the other", async () => {
  const { thermal } = await import("../src/telemetry.js");
  const t = await thermal();
  assert.ok(t === null || ["nominal", "fair", "serious", "critical"].includes(t));
});

test("Windows reports no load average rather than a fabricated zero", () => {
  assert.equal(loadOneMinute("win32"), null);
  const v = loadOneMinute("linux");
  assert.ok(v === null || v >= 0);
});

test("idle_s is null on a platform with no idle signal", async () => {
  assert.equal(await idleSeconds("aix"), null);
});

test("system_profiler size strings parse, and anything else is null", () => {
  assert.equal(mbFromSizeString("8 GB"), 8192);
  assert.equal(mbFromSizeString("1536 MB"), 1536);
  assert.equal(mbFromSizeString("1.5 GB"), 1536);
  assert.equal(mbFromSizeString("unified memory"), null);
});

test("wmic /value output parses, and a missing key is null", () => {
  const text = "\r\r\nModel=Latitude 7420\r\r\nName=Intel(R) Core(TM) i7\r\r\n";
  assert.equal(wmicValue(text, "Model"), "Latitude 7420");
  assert.equal(wmicValue(text, "Name"), "Intel(R) Core(TM) i7");
  assert.equal(wmicValue(text, "AdapterRAM"), null);
  assert.equal(wmicValue(null, "Model"), null);
  assert.equal(wmicValue("Model=\r\n", "Model"), null);
});

test("the device id is stable, sanitized, and hostname-derived", () => {
  assert.equal(defaultDeviceId("Taylors-MacBook-Pro.local"), "machine-taylors-macbook-pro");
  assert.equal(defaultDeviceId("build-box"), "machine-build-box");
  assert.equal(defaultDeviceId("weird host name!"), "machine-weird-host-name");
  assert.equal(defaultDeviceId(""), "machine-unknown");
  // Same input, same id: the registry key survives a restart.
  assert.equal(defaultDeviceId("rl6p9g7wyt.local"), defaultDeviceId("rl6p9g7wyt.local"));
});
