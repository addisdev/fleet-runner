/**
 * What an Apple target is, when simctl could not say.
 *
 * `describeTarget` asks simctl first and devicectl second. devicectl lists
 * simulators as well as hardware, and it used to treat reaching the devicectl
 * branch as proof of hardware -- so when simctl's own listing came back empty
 * (a 20-second `simctl list` timing out on a shared Mac under load is enough),
 * every booted simulator registered as a physical phone. A week of that put
 * four imaginary iPhones on the shelf with no presence TTL to remove them.
 */
import { describeTarget } from "./executor.js";
import { NoTargetsError } from "./fleet-client.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

export async function runDescribeChecks(check: Check) {
  const sim = {
    identifier: "D7825499-3634-4DEA-AD0E-8191B8236DD3", marketingName: "iPhone 16",
    osVersion: "18.4", transport: "sameMachine", pairingState: "paired", platform: "iOS",
  };
  const phone = {
    identifier: "0F72BFF3-696B-564C-9163-8E5462A1508E", marketingName: "iPhone 16 Pro",
    osVersion: "26.7", productType: "iPhone17,1", transport: "wired", pairingState: "paired", platform: "iOS",
  };

  // simctl gave nothing (null), so devicectl is all there is to go on.
  const d1 = await describeTarget({ id: sim.identifier, platform: "ios", kind: "device" } as never, null, [sim]);
  check("a devicectl entry on sameMachine is a simulator, whatever the target claimed", d1.kind === "simulator",
    JSON.stringify(d1));
  check("and it says so in soc too, which isSimulator() reads", d1.soc === "simulator", JSON.stringify(d1));
  check("it keeps its real name and version", d1.model === "iPhone 16" && d1.os === "ios-18.4", JSON.stringify(d1));

  const d2 = await describeTarget({ id: phone.identifier, platform: "ios", kind: "device" } as never, null, [phone]);
  check("a wired devicectl entry is still hardware", d2.kind === "device", JSON.stringify(d2));
  check("and keeps its product type as the soc", d2.soc === "iPhone17,1", JSON.stringify(d2));

  // --- an Apple TV simulator is tvOS ----------------------------------------
  // simctl's runtime key was read for `iOS-` only, so a tvOS simulator
  // registered as plain "ios" and every `os ~ 'tvos'` job skipped with "no
  // device matches" -- three fleet-explore-tv nights in a row.
  const sims = {
    "com.apple.CoreSimulator.SimRuntime.tvOS-26-5": [{ udid: "TV-SIM", name: "fleet-explore-tvos" }],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "IOS-SIM", name: "fleet-explore-ios" }],
  };
  const tv = await describeTarget({ id: "TV-SIM", platform: "tvos", kind: "simulator" } as never, sims, null);
  check("a tvOS simulator's os is tvos-<version>", tv.os === "tvos-26.5", JSON.stringify(tv));
  check("and it is a simulator", tv.kind === "simulator" && tv.soc === "simulator", JSON.stringify(tv));
  const ph = await describeTarget({ id: "IOS-SIM", platform: "ios", kind: "simulator" } as never, sims, null);
  check("an iOS simulator is still ios-<version>", ph.os === "ios-26.5", JSON.stringify(ph));
  const { evalMatch } = await import("./match.js");
  check("os ~ 'tvos' selects the TV and not the phone",
    evalMatch("os ~ 'tvos'", tv) && !evalMatch("os ~ 'tvos'", ph));
  check("os ~ 'ios' selects the phone and not the TV",
    evalMatch("os ~ 'ios'", ph) && !evalMatch("os ~ 'ios'", tv));

  // --- a Roku is a Roku ------------------------------------------------------
  // It used to fall through to the iOS fallback and register as an iPhone.
  const express = {
    ip: "192.168.50.218", port: 8060, serial: "YJ00AB123456", modelName: "Roku Express 4K+",
    deviceType: "STB", softwareVersion: "15.1.4", developerEnabled: true,
  };
  const r1 = await describeTarget(
    { id: "roku-YJ00AB123456", platform: "roku", kind: "device", driver: "roku" } as never, null, null, [express]);
  check("a Roku registers under its own model and firmware",
    r1.model === "Roku Express 4K+" && r1.os === "roku-15.1.4", JSON.stringify(r1));
  check("and carries the address tvloop is pointed at", r1.ip === "192.168.50.218" && r1.developer_enabled === true,
    JSON.stringify(r1));
  check("and is attached to this host, which host routing follows", typeof r1.attached_to === "string");
  const r2 = await describeTarget({ id: "roku-gone", platform: "roku", kind: "device" } as never, null, null, []);
  check("a Roku discovery lost track of is still a Roku, not an iPhone", r2.os === "roku", JSON.stringify(r2));
  // It used to say nothing, and the collector's fallback guess for anything
  // that is not iOS is Android: the shelf's Roku Express listed as android.
  check("a Roku says its platform is roku", r1.platform === "roku" && r2.platform === "roku",
    JSON.stringify([r1.platform, r2.platform]));
  const { devicePlatform } = await import("./api/shared.js");
  check("and the collector believes it", devicePlatform(r1) === "roku", devicePlatform(r1));
  check("os ~ 'roku' still selects it", evalMatch("os ~ 'roku'", r1) && evalMatch("os ~ 'roku-15'", r1));

  const { rokuPresenceHere } = await import("./drivers/roku.js");
  check("Roku presence is off unless this host is told it owns them",
    !rokuPresenceHere({}) && rokuPresenceHere({ FLEET_ROKU: "1" }));

  // --- no targets is a skip ------------------------------------------------
  const e = new NoTargetsError("no targets attached");
  check("an empty target list has its own error type", e instanceof NoTargetsError && e instanceof Error);
  check("and a name a log line can show", e.name === "NoTargetsError");
}
