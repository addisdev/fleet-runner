/**
 * Which actuator reaches a target, chosen by the target's driver.
 *
 * Literal import specifiers, one per driver, for the reason static.ts gives:
 * a bundler follows a literal and nothing else, and an executor that never
 * meets a Roku never loads the Roku code.
 */
import type { Target } from "../../types.js";
import type { Actuator, Surface } from "../types.js";
import { targetHost } from "../../../drivers/roku.js";
import { AndroidActuator } from "./android.js";
import { RokuActuator } from "./roku.js";

export type ActuatorOptions = {
  surface?: Surface;
  log: (msg: string) => void;
  /** The Roku developer password, for sideloading; resolved on the host. */
  rokuPassword?: string;
};

export async function actuatorFor(t: Target, opts: ActuatorOptions): Promise<Actuator> {
  const driver = t.driver ?? (t.platform === "android" ? "adb" : t.platform === "roku" ? "roku" : t.kind === "device" ? "devicectl" : "simctl");
  if (driver === "adb") {
    const surface = opts.surface ?? ((await AndroidActuator.isTv(t)) ? "dpad" : "touch");
    return new AndroidActuator(t, { surface, log: opts.log });
  }
  if (driver === "roku") {
    if (!opts.rokuPassword) {
      throw new Error("a Roku needs its developer password for screenshots and sideloads; add it with " +
        "`security add-generic-password -s fleet-roku-dev -a rokudev -w`");
    }
    return RokuActuator.open(t, { host: await targetHost(t), password: opts.rokuPassword, log: opts.log });
  }
  throw new Error(`explore cannot drive ${t.id} yet: no actuator for the ${driver} driver on this executor`);
}
