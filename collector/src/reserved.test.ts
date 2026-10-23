/**
 * Reserved devices: the rule, and the host executor applying it.
 *
 * The case is the growth pilot's phone on ultra: signed in to Instagram, and
 * cabled to a Mac whose executor also runs the explore night and anything else
 * that says `os ~ 'android'`. The brain-side half (claims, fan-out, routing,
 * enqueue refusals) is exercised over HTTP in smoke.ts; this is the pure rule
 * and the executor's own device selection, which never talks to the brain's
 * database.
 */
import { selectTargets, type Job } from "./executor.js";
import { pinsDevice, reservationAllows, RESERVATION_LABEL } from "./reserved.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const PHONE = "988a1b3541354f565a";
const LABEL = "growth-instagram";
const android = { model: "SM-G955U", os: "android-9", serial: PHONE };

export async function runReservationChecks(check: Check) {
  // --- the rule ---------------------------------------------------------------
  check("an unreserved device takes any job", reservationAllows({}, PHONE, null, android));
  check("a reserved device refuses a job with no reservation",
    !reservationAllows({ targets: { match: "os ~ 'android'" } }, PHONE, LABEL, android));
  check("a reserved device refuses the label without a pin (a fan-out or pool carrying it)",
    !reservationAllows({ reservation: LABEL, targets: { match: "os ~ 'android'" } }, PHONE, LABEL, android));
  check("a reserved device refuses a pin without the label (a stale script, a retry --device)",
    !reservationAllows({ targets: { device_id: PHONE } }, PHONE, LABEL, android));
  check("a reserved device refuses another reservation's label",
    !reservationAllows({ reservation: "other", targets: { device_id: PHONE } }, PHONE, LABEL, android));
  check("label + targets.device_id is allowed",
    reservationAllows({ reservation: LABEL, targets: { device_id: PHONE } }, PHONE, LABEL, android));
  check("label + targets.match device_id == '<id>' is allowed (the kit's shape)",
    reservationAllows({ reservation: LABEL, targets: { match: `device_id == '${PHONE}'` } }, PHONE, LABEL, android));
  check("a pin narrowed further still pins",
    pinsDevice({ match: `device_id == '${PHONE}' && os ~ 'android'` }, PHONE, android));
  check("a serial pin counts, since the serial is the id",
    pinsDevice({ match: `serial == '${PHONE}'` }, PHONE, android));
  check("an || that would match the phone under any name does not pin",
    !pinsDevice({ match: `device_id == '${PHONE}' || os ~ 'android'` }, PHONE, android));
  check("a negated pin does not pin", !pinsDevice({ match: `device_id != 'something-else'` }, PHONE, android));
  check("a pin on another device does not pin this one", !pinsDevice({ device_id: "emulator-5554" }, PHONE, android));
  check("a malformed match pins nothing", !pinsDevice({ match: "device_id ==" }, PHONE, android));
  check("labels: a sane label passes", RESERVATION_LABEL.test(LABEL) && RESERVATION_LABEL.test("pilot:ig.2"));
  check("labels: spaces, quotes and empty are refused",
    !RESERVATION_LABEL.test("growth phone") && !RESERVATION_LABEL.test("x'") && !RESERVATION_LABEL.test(""));

  // --- the host executor's own selection --------------------------------------
  // Two cabled phones (serials, not emulator-NNNN, so membership asks no adb).
  // The executor picks devices from what it can see, so this is the half the
  // brain cannot enforce for it.
  const OTHER = "R58M12ABCDE";
  const attached = [
    { id: PHONE, platform: "android", kind: "device" as const },
    { id: OTHER, platform: "android", kind: "device" as const },
  ];
  const reserved_devices = { [PHONE]: LABEL };
  const job = (j: Partial<Job>): Job => ({ job_id: "t", workload: "ui-test", reserved_devices, ...j });
  const ids = (ts: { id: string }[]) => ts.map((t) => t.id).join(",");

  const unpinned = await selectTargets(job({}), attached);
  check("executor: an unpinned job runs on everything but the reserved phone", ids(unpinned) === OTHER, ids(unpinned));

  const pinnedNoLabel = await selectTargets(job({ targets: { device_id: PHONE } }), attached);
  check("executor: a pin without the label gets nothing", pinnedNoLabel.length === 0, ids(pinnedNoLabel));

  const labelledFanout = await selectTargets(job({ reservation: LABEL, targets: {} }), attached);
  check("executor: the label alone does not unlock the phone", ids(labelledFanout) === OTHER, ids(labelledFanout));

  const growth = await selectTargets(job({ reservation: LABEL, targets: { device_id: PHONE } }), attached);
  check("executor: label + device_id gets exactly the phone", ids(growth) === PHONE, ids(growth));

  // The kit's job: targets.match "device_id == '<id>'". This also proves the
  // executor evaluates device_id at all -- it used to describe an Android
  // target without it, so this pin matched nothing once claimed.
  const kit = await selectTargets(job({ reservation: LABEL, targets: { match: `device_id == '${PHONE}'` } }), attached);
  check("executor: label + a device_id match gets exactly the phone", ids(kit) === PHONE, ids(kit));

  const plainPin = await selectTargets({ job_id: "t", workload: "ui-test", targets: { match: `device_id == '${OTHER}'` } }, attached);
  check("executor: targets.match can name device_id on an unreserved device", ids(plainPin) === OTHER, ids(plainPin));

  const oldBrain = await selectTargets({ job_id: "t", workload: "ui-test" }, attached);
  check("executor: with no reservations sent, nothing is held back", oldBrain.length === 2, ids(oldBrain));
}
