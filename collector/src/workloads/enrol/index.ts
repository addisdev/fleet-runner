// enrol: tell every attached device which collector to talk to.
//
// ## The problem
//
// The enrolment screen has said this from the beginning:
//
//   > The hard part of enrolling a phone is not the software, it is typing the
//   > collector's address on a touch keyboard without a typo, once per device.
//
// A QR code answers that for a phone, because a phone has a camera. It answers
// nothing for the platforms that came next. A television has no camera and a
// remote-control keyboard is an on-screen grid; a Roku's is worse. And once a
// fleet has more than one brain, "which collector is this device pointed at"
// stops being a thing you set once and becomes a thing you change.
//
// There are exactly two ways to solve it: the device finds the brain, or the
// brain reaches the device. mDNS discovery is the first. This is the second,
// and it is the one that works when multicast is blocked -- which is guest
// wifi, most offices, and every Docker bridge network.
//
// ## What it actually does
//
// Nothing clever. Every platform already has a way to hand a launching app a
// parameter, and each driver knows its own:
//
//   adb        `am start -S --es base_url <url>`
//   simctl     `simctl launch` with SIMCTL_CHILD_FLEET_URL
//   devicectl  a `fleetrunner://join` URL, opened on the device
//   roku       `POST /launch/dev?fleet_url=<url>` over ECP
//
// The workload's own job is the part none of them do: decide what URL to send,
// launch, and then **verify the device actually registered** rather than
// reporting that a launch command exited zero.
//
// ## Why it verifies
//
// Because every one of those four mechanisms fails silently in the same way. An
// `am start` against a package that is not installed exits 0 and prints an
// error to stdout. A `simctl launch` succeeds against an app that ignores its
// environment. An ECP launch returns 200 for a channel that then cannot reach
// the address it was given. In every case the operator would be told the device
// was enrolled, walk away, and find an empty shelf.
//
// So the result row for a device is "it registered within the window" or the
// reason it did not, and the reason names which of the two halves failed --
// the launch, or the registration after it.
import { BASE } from "../../fleet-client.js";
import { driverNamed } from "../../drivers/index.js";
import type { Job, Target, WorkloadCtx } from "../types.js";

const DEFAULT_WAIT_S = 90;

type Params = {
  url?: string;
  device_id_prefix?: string;
  wait_s?: number;
};

export async function run(job: Job, ctx: WorkloadCtx): Promise<void> {
  const params = (job.params ?? {}) as Params;
  // The collector this executor is claiming from, unless told otherwise. That
  // is nearly always right: the person enqueueing this is looking at the
  // dashboard of the brain they want devices on.
  //
  // A loopback address is refused rather than sent. It is a perfectly good URL
  // for this host and a useless one for a phone, and a device enrolled onto
  // `127.0.0.1` fails in a way that looks like a network problem rather than a
  // configuration mistake -- which is the same trap the enrolment screen's
  // "the QR encodes an address derived from the host's own interfaces" note
  // exists to avoid.
  const url = params.url ?? BASE;
  if (/\/\/(127\.|localhost|\[::1\])/.test(url) && !params.url) {
    throw new Error(
      `this executor talks to the collector on ${BASE}, which no other device can reach. ` +
        "Pass params.url with the collector's LAN or tailnet address.",
    );
  }

  const targets = await ctx.selectTargets(job, await ctx.listTargets());
  if (targets.length === 0) {
    await ctx.postResult({
      job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: false,
      error: "no targets attached to this executor",
    });
    return;
  }

  const waitS = typeof params.wait_s === "number" && params.wait_s > 0 ? params.wait_s : DEFAULT_WAIT_S;
  const before = await registeredIds(url);
  let iter = 0;
  let allOk = true;

  for (const target of targets) {
    iter += 1;
    const driver = driverNamed(target.driver);
    const deviceId = params.device_id_prefix ? `${params.device_id_prefix}-${target.id}` : undefined;

    if (!driver?.enrol) {
      // Not a failure of this device so much as a gap in the fleet, and it is
      // reported as a row rather than thrown so the other nine devices still
      // get enrolled.
      allOk = false;
      await ctx.postResult({
        job_id: job.job_id, device_id: target.id, iter, ok: false,
        error:
          `the ${target.driver ?? "unknown"} driver cannot enrol a device. ` +
          "Use the QR code on /dash/devices/new, or point this device at the collector by hand.",
        enrol: { target: target.id, platform: target.platform, driver: target.driver ?? null, stage: "unsupported" },
      });
      continue;
    }

    ctx.log(`enrolling ${target.id} (${target.platform}) onto ${url}`);
    try {
      await driver.enrol(target, { url, deviceId });
    } catch (e) {
      allOk = false;
      await ctx.postResult({
        job_id: job.job_id, device_id: target.id, iter, ok: false,
        error: `launch failed: ${(e as Error).message}`,
        enrol: { target: target.id, platform: target.platform, driver: target.driver ?? null, stage: "launch" },
      });
      continue;
    }

    // The half that matters. A launch that exited zero proves nothing.
    const appeared = await waitForRegistration(url, before, waitS, () =>
      ctx.postBeacon(job.job_id, `host:${ctx.host}`, { enrolling: target.id }),
    );
    if (appeared) {
      ctx.log(`${target.id} registered as ${appeared}`);
      await ctx.postResult({
        job_id: job.job_id, device_id: target.id, iter, ok: true,
        enrol: {
          target: target.id, platform: target.platform, driver: target.driver ?? null,
          stage: "registered", registered_as: appeared, collector: url,
        },
      });
      before.add(appeared);
    } else {
      allOk = false;
      await ctx.postResult({
        job_id: job.job_id, device_id: target.id, iter, ok: false,
        error:
          `launched, but nothing new registered with ${url} within ${waitS}s. ` +
          "The runner may not be installed, may not read the launch parameter, or may not be able to reach that address.",
        enrol: { target: target.id, platform: target.platform, driver: target.driver ?? null, stage: "registration" },
      });
    }
  }

  await ctx.postResult({
    job_id: job.job_id, device_id: `host:${ctx.host}`, iter: 0, final: true, ok: allOk,
    enrol: { collector: url, attempted: targets.length },
  });
}

/** Which device ids the target collector already knows about. */
async function registeredIds(base: string): Promise<Set<string>> {
  try {
    const res = await fetch(`${base}/api/devices`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new Set();
    const body = (await res.json()) as { devices: { device_id: string }[] };
    return new Set(body.devices.map((d) => d.device_id));
  } catch {
    // A collector this executor cannot read is one it may still be able to
    // enrol onto -- they are different networks' problems. An empty set means
    // every device that appears counts as new, which is the safe direction:
    // it can only make this report a success it should have reported anyway.
    return new Set();
  }
}

/**
 * Wait for a device id that was not there before.
 *
 * Identity by absence rather than by name, because the runner chooses its own
 * id and this cannot predict it. An Android runner's is derived from the model
 * and a hash; a Roku's is `GetChannelClientId()`, which is a per-publisher
 * value nothing outside the device can compute. Watching for anything new is
 * the only thing that works for all four.
 *
 * The cost is that a device registering for an unrelated reason during the
 * window would be credited to this enrolment. On a shelf being deliberately
 * enrolled that is a fair trade for a check that works at all.
 */
async function waitForRegistration(
  base: string,
  before: Set<string>,
  waitS: number,
  beacon: () => Promise<void>,
): Promise<string | null> {
  const deadline = Date.now() + waitS * 1_000;
  let lastBeacon = 0;
  while (Date.now() < deadline) {
    // The lease has to survive a ninety-second wait per device across a shelf
    // of them, and nothing else here beacons.
    if (Date.now() - lastBeacon > 30_000) {
      lastBeacon = Date.now();
      await beacon().catch(() => {});
    }
    const now = await registeredIds(base);
    for (const id of now) if (!before.has(id)) return id;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}
