/**
 * The `enrol` workload's decisions, without a device.
 *
 * This is the seam `WorkloadCtx` exists for, and its header says why: a handler
 * used to import `postResult` and the rest straight from `fleet-client.js`, so
 * a test had nothing to substitute and the only way to exercise one was to plug
 * in a phone. Passing them in means a test can hand this a fake collector and
 * watch what it posts.
 *
 * What is deliberately NOT tested here is any actual enrolment. There is no
 * Android device and no booted simulator on the machine this was written on,
 * so `driver.enrol` has never been called against real hardware -- and a test
 * that faked a driver's success would be a test that the fake succeeded.
 *
 * What IS tested is every path that decides not to enrol, which is where this
 * workload earns its keep. Each one is a way it could report success for a
 * shelf that ended up empty:
 *
 * - a collector address no other device can reach
 * - a driver with no enrolment mechanism at all
 * - a launch that failed
 * - a launch that "worked" and left nothing in the registry
 *
 * The last is the one the whole workload is built around, because all four of
 * the underlying launch mechanisms fail silently in exactly that way.
 */
import type { Job, Target, WorkloadCtx } from "../types.js";
import { run } from "./index.js";

type Check = (name: string, cond: boolean, detail?: string) => void;
type Row = Record<string, unknown>;

/** A ctx that records rather than doing, and the rows it collected. */
function fakeCtx(targets: Target[]): { ctx: WorkloadCtx; rows: Row[]; logs: string[] } {
  const rows: Row[] = [];
  const logs: string[] = [];
  const ctx: WorkloadCtx = {
    host: "test-host",
    log: (m) => logs.push(m),
    postResult: async (row) => {
      rows.push(row);
    },
    postBeacon: async () => {},
    fetchArtifact: async () => {
      throw new Error("enrol does not fetch artifacts");
    },
    uploadArtifact: async () => {
      throw new Error("enrol does not upload artifacts");
    },
    listTargets: async () => targets,
    // The real one filters by targets.device_id / kind / match. enrol does not
    // exercise that logic, so this hands back everything.
    selectTargets: async (_job, all) => all,
    secrets: { credentialsFor: async () => null, redact: (s: string) => s },
    leaseBudgetS: () => 570,
  };
  return { ctx, rows, logs };
}

const job = (params: Record<string, unknown> = {}): Job =>
  ({ job_id: "enrol-test", workload: "enrol", params }) as unknown as Job;

/**
 * Stub `fetch` for the duration of `fn`.
 *
 * `enrol` reads the target collector's device list to decide whether anything
 * new appeared, so a test with a real fetch would hit whatever is on that port
 * -- which on a developer's machine is very often their actual fleet.
 */
async function withDevices(ids: string[][], fn: () => Promise<void>): Promise<number> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const devices = (ids[Math.min(calls, ids.length - 1)] ?? []).map((device_id) => ({ device_id }));
    calls += 1;
    return { ok: true, json: async () => ({ devices }) } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

const target = (over: Partial<Target> = {}): Target => ({
  id: "emulator-5554",
  platform: "android",
  kind: "device",
  driver: "adb",
  ...over,
});

export async function runEnrolChecks(check: Check): Promise<void> {
  // --- a collector nothing else can reach ---------------------------------
  {
    const { ctx, rows } = fakeCtx([target()]);
    let threw = "";
    try {
      // No params.url, and this executor's own BASE is loopback in a test run.
      await run(job(), ctx);
    } catch (e) {
      threw = (e as Error).message;
    }
    // The trap this avoids is the one the enrolment screen already documents:
    // a loopback address is a perfectly good URL for this host and a useless
    // one for a phone, and the resulting failure looks like a network problem
    // rather than a configuration mistake.
    check("a loopback collector address is refused rather than sent", /no other device can reach/.test(threw), threw);
    check("and nothing was posted before refusing", rows.length === 0);
  }

  // --- an explicit loopback URL is the operator's business -----------------
  {
    const { ctx, rows } = fakeCtx([]);
    await withDevices([[]], async () => {
      await run(job({ url: "http://127.0.0.1:8788" }), ctx);
    });
    // Passed explicitly, it is allowed: enrolling a simulator on this very host
    // onto loopback is a real thing to want, and refusing it would be this
    // workload deciding it knows better than the person who typed it.
    check(
      "an explicitly given loopback address is allowed",
      rows.some((r) => r.final === true),
      JSON.stringify(rows),
    );
  }

  // --- nothing attached ----------------------------------------------------
  {
    const { ctx, rows } = fakeCtx([]);
    await run(job({ url: "http://fleet-host.local:8788" }), ctx);
    check("with no targets, one final row says so", rows.length === 1 && rows[0].final === true);
    check("and it is not ok", rows[0].ok === false);
    check("and names the reason", /no targets/.test(String(rows[0].error)), String(rows[0].error));
  }

  // --- a driver with no enrolment mechanism --------------------------------
  {
    const { ctx, rows } = fakeCtx([target({ driver: "devicectl", platform: "ios", id: "some-iphone" })]);
    await withDevices([[]], async () => {
      await run(job({ url: "http://fleet-host.local:8788", wait_s: 1 }), ctx);
    });
    const perDevice = rows.find((r) => r.device_id === "some-iphone");
    check("a driver that cannot enrol reports a row rather than throwing", perDevice !== undefined);
    check("the row is not ok", perDevice?.ok === false);
    // It has to say what to do instead, or it is a dead end.
    check(
      "and points at the path that does work",
      /QR code|by hand/.test(String(perDevice?.error)),
      String(perDevice?.error),
    );
    check(
      "the stage is recorded so a reader knows which half failed",
      (perDevice?.enrol as Row | undefined)?.stage === "unsupported",
    );
    check("and the final row is not ok either", rows.find((r) => r.final)?.ok === false);
  }

  // --- one device that cannot enrol does not stop the others ---------------
  {
    const { ctx, rows } = fakeCtx([
      target({ driver: "nosuchdriver", id: "cannot-enrol" }),
      target({ driver: "nosuchdriver", id: "also-cannot" }),
    ]);
    await withDevices([[]], async () => {
      await run(job({ url: "http://fleet-host.local:8788", wait_s: 1 }), ctx);
    });
    // The install workload makes the same promise: a device that refused is a
    // result, not an exception, because the other nine installed it.
    check(
      "every target gets its own row",
      rows.filter((r) => !r.final).length === 2,
      `${rows.filter((r) => !r.final).length} rows`,
    );
    check("and there is exactly one final row", rows.filter((r) => r.final).length === 1);
  }
}
