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

  // --- no targets is a skip ------------------------------------------------
  const e = new NoTargetsError("no targets attached");
  check("an empty target list has its own error type", e instanceof NoTargetsError && e instanceof Error);
  check("and a name a log line can show", e.name === "NoTargetsError");
}
