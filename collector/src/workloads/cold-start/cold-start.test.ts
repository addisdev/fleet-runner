// cold-start's refusals, against a fake context. Everything up to the first
// adb call: the params it rejects, a job with no targets, and the iOS rows that
// must say why there is no number rather than file a spawn time as one.
import { NoTargetsError } from "../../fleet-client.js";
import type { Job, Target, WorkloadCtx } from "../types.js";
import { run } from "./index.js";

type Check = (name: string, cond: boolean, detail?: string) => void;
type Row = Record<string, unknown>;

function fakeCtx(targets: Target[]) {
  const rows: Row[] = [];
  const ctx: WorkloadCtx = {
    host: "test-host",
    log: () => {},
    postResult: async (row) => {
      rows.push(row);
    },
    postBeacon: async () => {},
    fetchArtifact: async () => {
      throw new Error("cold-start fetches nothing");
    },
    uploadArtifact: async () => {
      throw new Error("cold-start uploads nothing");
    },
    listTargets: async () => targets,
    selectTargets: async (_job, all) => all,
    leaseBudgetS: () => 600,
    locks: { acquire: async (_j, ids) => new Set(ids), release: async () => {} },
    secrets: {
      credentialsFor: async () => {
        throw new Error("cold-start needs no credentials");
      },
      redact: (s) => s,
      rokuDevPassword: async () => ({ ok: false, reason: "missing", detail: "no roku here" }),
    },
  };
  return { ctx, rows };
}

const job = (params: Record<string, unknown>, platform = "android"): Job =>
  ({ job_id: "cs-1", workload: "cold-start", executor: "host", params, app: { name: "a", build: "1", sha256: "x", platform } }) as unknown as Job;

async function rejects(p: Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

export async function runColdStartChecks(check: Check): Promise<void> {
  console.log("\ncold-start (fake ctx)");
  const phone: Target = { id: "emulator-5554", platform: "android", kind: "simulator", driver: "adb" };

  check("no app_id is refused before anything runs", await rejects(run(job({}), fakeCtx([phone]).ctx), /params\.app_id/));
  check("an unknown launch state is refused by name", await rejects(run(job({ app_id: "a.b", states: ["lukewarm"] }), fakeCtx([phone]).ctx), /lukewarm/));
  check("an empty states list is refused", await rejects(run(job({ app_id: "a.b", states: [] }), fakeCtx([phone]).ctx), /empty/));

  const none = fakeCtx([]);
  let noTargets = false;
  try {
    await run(job({ app_id: "a.b" }), none.ctx);
  } catch (e) {
    noTargets = e instanceof NoTargetsError;
  }
  check("no matching targets is a NoTargetsError, which the executor turns into a skip", noTargets);

  const sim: Target = { id: "SIM-1", platform: "ios", kind: "simulator", driver: "simctl" };
  const dev: Target = { id: "00008110-AAAA", platform: "ios", kind: "device", driver: "devicectl" };
  const ios = fakeCtx([sim, dev]);
  await run(job({ app_id: "a.b" }, "ios"), ios.ctx);
  const simRow = ios.rows.find((r) => r.device_id === "SIM-1");
  const devRow = ios.rows.find((r) => r.device_id === "00008110-AAAA");
  check("an iOS simulator gets a failed row naming why, not a spawn time",
    simRow?.ok === false && /XCTApplicationLaunchMetric/.test(String(simRow?.error)) && simRow?.metrics === undefined);
  check("an iOS device gets a failed row naming the force-stop gap", devRow?.ok === false && /force-stop/.test(String(devRow?.error)));
  const final = ios.rows.find((r) => r.final === true);
  check("the closing row is the host's and is not ok", final?.device_id === "host:test-host" && final?.ok === false);
}
