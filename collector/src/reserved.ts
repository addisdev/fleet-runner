/**
 * Reserved devices: hardware that only one kind of job may touch.
 *
 * The case that made this necessary is a phone signed in to a real account --
 * the growth pilot's Instagram phone on ultra -- where any other job that
 * happens to match it opens other apps on top of a logged-in session. Pools and
 * match expressions cannot protect it: they say what a job WANTS, and an
 * unpinned `os ~ 'android'`, a fan-out or the explore night wants every Android
 * device it can see. A reservation turns it round and says what the DEVICE
 * accepts.
 *
 * A reserved device is given only to a job that
 *
 *   1. carries the same label in `reservation`, and
 *   2. names the device explicitly: `targets.device_id`, or a `targets.match`
 *      that pins its id (it matches this device and would stop matching if the
 *      device had any other id -- `device_id == '<id>'` is the usual form).
 *
 * Both, because each alone fails open. A label alone lets a fan-out carrying it
 * land on every reserved device with that label as well as the rest of the
 * shelf; a pin alone is what a stale script or a retry with `--device` already
 * has.
 *
 * Pure on purpose: the brain judges claims and fan-out with it, and the host
 * executor -- a separate process that must not open the brain's database --
 * applies the same rule to the devices it can see.
 */
import { evalMatch } from "./match.js";

/** A reservation label: short, and safe to print in a table or a log line. */
export const RESERVATION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The parts of a job spec a reservation is judged on. */
export type ReservationSubject = {
  reservation?: unknown;
  targets?: { device_id?: string; match?: string } | null;
};

/** Stands in for "some other device" when testing whether a match pins an id. */
const ANOTHER_DEVICE = "\u0000another-device";

/**
 * Does this job name this device explicitly?
 *
 * `targets.device_id` is the plain answer. For `targets.match` the test is
 * behavioural rather than textual: the expression must select this device, and
 * must stop selecting it once every field carrying the device's id (device_id,
 * and serial or udid where they are the same string) is swapped for another
 * id. That accepts `device_id == 'X' && os ~ 'android'` and refuses
 * `device_id == 'X' || os ~ 'android'`, which would have matched this phone
 * whatever it was called.
 */
export function pinsDevice(
  targets: ReservationSubject["targets"],
  deviceId: string,
  descriptor: Record<string, unknown>,
): boolean {
  if (!targets) return false;
  if (targets.device_id) return targets.device_id === deviceId;
  if (!targets.match) return false;
  const self = { ...descriptor, device_id: deviceId };
  const other: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(self)) other[k] = v === deviceId ? ANOTHER_DEVICE : v;
  try {
    return evalMatch(targets.match, self) && !evalMatch(targets.match, other);
  } catch {
    return false;
  }
}

/**
 * May this job run on this device? Always yes for an unreserved device (`label`
 * null or undefined); for a reserved one, only with the same label and an
 * explicit pin.
 */
export function reservationAllows(
  job: ReservationSubject,
  deviceId: string,
  label: string | null | undefined,
  descriptor: Record<string, unknown>,
): boolean {
  if (!label) return true;
  return job.reservation === label && pinsDevice(job.targets, deviceId, descriptor);
}

/** Why a reserved device was not offered, in the words a skip or a warning uses. */
export function reservedReason(deviceId: string, label: string): string {
  return `${deviceId} is reserved for '${label}': only a job with reservation '${label}' that pins it ` +
    `(targets.device_id, or targets.match "device_id == '${deviceId}'") may use it`;
}
