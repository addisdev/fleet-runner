/**
 * Registry hygiene, against a real database.
 *
 * The rows are the live brain's, October 2026: an `iPhone 17 Pro` simulator
 * UUID offline for three weeks, a `fleet-explore-tv` simulator that registered
 * before `soc` was written, a real iPhone offline even longer (which must stay:
 * a phone in a drawer is still a phone), an Android emulator, and the Roku that
 * was listed twice. `last_seen` is written directly because a week of silence
 * is the whole point and a suite cannot wait for it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, openDb } from "./db.js";
import { declaredSimulator, forgetStaleSimulators, retireRokuIpDuplicate, rokuIpId, simulatorTtlDays } from "./registry-hygiene.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

export function runRegistryHygieneChecks(check: Check) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-hygiene-test-"));
  try {
    const db = openDb(dir);
    const add = (id: string, descriptor: Record<string, unknown>, daysAgo: number) =>
      db.prepare(
        `INSERT INTO devices (device_id, descriptor, pools, last_seen) VALUES (?, ?, '[]', datetime('now', ?))`,
      ).run(id, JSON.stringify(descriptor), `-${daysAgo * 86_400} seconds`);
    const exists = (id: string) => !!db.prepare("SELECT 1 FROM devices WHERE device_id = ?").get(id);

    add("75619D0E-5B01-46FA-967B-0964985BCE93", { model: "iPhone 17 Pro", os: "ios-27.0", soc: "simulator", kind: "simulator" }, 21);
    add("CECF9000-9FF1-4511-8D1E-CD3E2E34E1E0", { model: "fleet-explore-tv", os: "ios", kind: "simulator" }, 13);
    add("73BF450F-DD86-4DBC-AE25-763DE93B7508", { model: "simulator", os: "ios", soc: "simulator" }, 19);
    add("799804C0-17C7-430C-835D-AFCD50824381", { model: "iPhone 18 Pro", os: "ios-27.0", soc: "simulator", kind: "simulator" }, 1);
    add("09A99EFE-56C4-5FCF-9170-305B974BF662", { model: "iPhone 12 Pro", os: "ios-18.7.8", soc: "iPhone13,3", kind: "device" }, 51);
    add("emulator-5554", { model: "sdk_gphone64_arm64", os: "android-15", kind: "device" }, 30);
    add("machine-intel", { model: "MacBook Pro", soc: "x86_64", os: "macos-12.7.6", kind: "laptop" }, 40);
    add("LOCKED-SIM", { model: "fleet-sim-1", kind: "simulator", soc: "simulator" }, 30);
    db.prepare("INSERT INTO device_locks (device_id, job_id) VALUES ('LOCKED-SIM', 'some-job')").run();

    check("hygiene: the TTL defaults to 7 days and reads FLEET_SIMULATOR_TTL_DAYS",
      simulatorTtlDays({}) === 7 && simulatorTtlDays({ FLEET_SIMULATOR_TTL_DAYS: "2" }) === 2 && simulatorTtlDays({ FLEET_SIMULATOR_TTL_DAYS: "nope" }) === 7);
    check("hygiene: only a declared simulator counts",
      declaredSimulator({ kind: "simulator" }) && declaredSimulator({ soc: "simulator" }) &&
        !declaredSimulator({ soc: "x86_64" }) && !declaredSimulator({ model: "sdk_gphone64_arm64" }));

    const gone = forgetStaleSimulators(7);
    check("hygiene: simulators offline past the TTL are forgotten",
      !exists("75619D0E-5B01-46FA-967B-0964985BCE93") && !exists("CECF9000-9FF1-4511-8D1E-CD3E2E34E1E0") &&
        !exists("73BF450F-DD86-4DBC-AE25-763DE93B7508"), JSON.stringify(gone));
    check("hygiene: and named in what the sweep returns", gone.length === 3, JSON.stringify(gone));
    check("hygiene: a simulator seen yesterday stays", exists("799804C0-17C7-430C-835D-AFCD50824381"));
    check("hygiene: a real iPhone is never forgotten, however long it has been away", exists("09A99EFE-56C4-5FCF-9170-305B974BF662"));
    check("hygiene: nor an Android emulator, which comes back under the same serial", exists("emulator-5554"));
    check("hygiene: nor an Intel machine whose soc merely looks like a simulator's", exists("machine-intel"));
    check("hygiene: nor a simulator that holds a lock", exists("LOCKED-SIM"));
    check("hygiene: a second sweep has nothing left to do", forgetStaleSimulators(7).length === 0);

    // --- the Roku listed twice ---
    check("roku: the IP-named id is the executor's", rokuIpId("192.168.50.218") === "roku-ip-192-168-50-218");
    add("roku-ip-192-168-50-218", { model: "roku", os: "roku", ip: "192.168.50.218", kind: "device" }, 3);
    add("roku-ip-192-168-50-99", { model: "roku", os: "roku", ip: "192.168.50.99", kind: "device" }, 3);
    const serial = { platform: "roku", model: "Roku Express 4K+", os: "roku-15.3.4", serial: "X01600EMFRJ9", ip: "192.168.50.218" };
    check("roku: an IP-named registration never displaces anything", retireRokuIpDuplicate("roku-ip-192-168-50-218", serial) === null);
    check("roku: a serial-named registration retires the duplicate at its address",
      retireRokuIpDuplicate("roku-X01600EMFRJ9", serial) === "roku-ip-192-168-50-218" && !exists("roku-ip-192-168-50-218"));
    check("roku: and only that one", exists("roku-ip-192-168-50-99"));
    check("roku: a device with no address retires nothing", retireRokuIpDuplicate("roku-X01600EMFRJ9", { model: "roku" }) === null);
    check("roku: nor does a phone that happens to report an ip",
      retireRokuIpDuplicate("988a1b3541354f565a", { ip: "192.168.50.99" }) === null && exists("roku-ip-192-168-50-99"));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}
