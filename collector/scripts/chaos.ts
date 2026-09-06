/**
 * The collector's own guarantees, made to fail on purpose.
 *
 *   npm run chaos
 *
 * The README and operations doc promise specific things about what happens when
 * something goes wrong: a lapsed lease is requeued, an exhausted job fails
 * rather than requeueing forever, a corrupted artifact is refused by hash, a
 * cancelled job stays cancelled, and nothing is lost when the collector dies
 * mid-job. Every one of those is load-bearing — they are why a runner that
 * loses power does not strand work — and until now every one of them was a
 * sentence in a document.
 *
 * ## Why this starts its own collector
 *
 * It could be a workload, and a `chaos` workload the fleet dispatches would be
 * a fine nightly. It is a script instead because the honest version of this
 * test kills the collector, and a workload that kills the collector it was
 * dispatched by is a workload that can kill the one running the house. There
 * is no flag safe enough to make that a good default. So: its own collector, on
 * a spare port, with a temporary database — the same isolation `npm test`
 * already uses and for the same reason.
 *
 * ## Why it is not in `npm test`
 *
 * It spends most of its time waiting for timeouts to elapse, which is the
 * opposite of what a suite run on every commit should do. It is a thing you run
 * when you have changed the sweep, the lease, or the artifact store.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (typeof a === "string" || a === null) return reject(new Error("no port"));
      srv.close(() => resolve(a.port));
    });
  });
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "fleet-chaos-"));
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const dataDir = path.join(dir, "data");
  const artifactDir = path.join(dir, "artifacts");
  let collector: ChildProcess | undefined;

  const env = {
    ...process.env,
    FLEET_PORT: String(port),
    FLEET_DATA_DIR: dataDir,
    FLEET_ARTIFACT_DIR: artifactDir,
    FLEET_LOG_FILE: path.join(dir, "c.log"),
    // Fast, because every assertion here waits for it.
    FLEET_SWEEP_MS: "1000",
    FLEET_SCHEDULER_TICK_MS: "60000",
  };

  const start = async () => {
    const proc = spawn(process.execPath, [TSX, "src/server.ts"], { cwd: ROOT, env, stdio: "ignore" });
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return proc; } catch { /* not up */ }
      await sleep(300);
    }
    throw new Error("collector did not start");
  };

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const job = async (id: string) => (await api("GET", `/api/jobs/${id}`)).body;

  try {
    collector = await start();
    const DEV = "chaos-device";
    await api("POST", "/devices/register", {
      device_id: DEV, descriptor: { model: "Chaos", os: "android-14" }, pools: ["chaos"],
      capabilities: ["benchmark"],
    });

    // --- 1. a runner that dies mid-job does not strand the work ---------------
    //
    // The promise: a claim is good until its lease deadline, and a runner that
    // stops beaconing has its job requeued rather than leaving it 'claimed'
    // forever. This is the guarantee a flat battery or an OOM kill depends on.
    console.log("\n1. a lease that lapses is requeued");
    await api("POST", "/jobs", {
      schema: 1, job_id: "chaos-lease", workload: "benchmark", executor: "device", backend: "synthetic",
      lease: { ttl_s: 2, max_attempts: 3 }, targets: { device_id: DEV },
    });
    const claimed = (await api("GET", `/devices/${DEV}/next-job`)).body;
    check("the job is claimed", claimed?.job_id === "chaos-lease", JSON.stringify(claimed));
    check("and reads as claimed", (await job("chaos-lease"))?.status === "claimed");
    // Now go silent. No beacons, no result.
    await sleep(5000);
    const requeued = await job("chaos-lease");
    check("a silent runner's job returns to the queue", requeued?.status === "queued", requeued?.status);
    check("and the attempt is counted", requeued?.attempts >= 1, String(requeued?.attempts));

    // --- 2. it does not requeue forever --------------------------------------
    //
    // The other half, and the one that matters at 3am: a job whose runner keeps
    // dying must eventually fail, or a broken device turns one job into an
    // infinite loop that hides every other failure in the dashboard.
    console.log("\n2. attempts run out and the job fails");
    for (let i = 0; i < 4; i++) {
      await api("GET", `/devices/${DEV}/next-job`);
      await sleep(3500);
    }
    const dead = await job("chaos-lease");
    check("an exhausted job fails rather than looping", dead?.status === "failed", dead?.status);
    check("and says why", /lease/i.test(dead?.last_error ?? ""), dead?.last_error ?? "");

    // --- 3. a corrupted artifact is refused, by the consumer -----------------
    //
    // The artifact store is content-addressed, which is only a guarantee if
    // something checks — and the thing that checks is deliberately NOT the
    // collector. `GET /artifacts/:sha` streams whatever is at that path without
    // hashing it, because verifying on read means hashing an 850 MB model on
    // every single download, and the number that would protect is one every
    // consumer already computes for itself.
    //
    // So the guarantee lives in `fetchArtifact`, on both the executor and the
    // machine agent: fetch, hash while reading, refuse on mismatch. That also
    // covers corruption in transit, which a server-side check never could.
    //
    // This section originally asserted that the SERVER refused, and failed —
    // correctly. The assertion was testing a promise the system does not make,
    // at a layer that does not make it. It now tests the layer that does.
    console.log("\n3. a corrupted artifact is refused by whoever fetches it");
    const payload = Buffer.from("the original contents of a build artifact");
    const sha = createHash("sha256").update(payload).digest("hex");
    const up = await fetch(`${BASE}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-artifact-name": "chaos.bin" },
      body: payload,
    });
    const upBody = await up.json() as { sha256: string };
    check("an artifact uploads under its own hash", upBody.sha256 === sha, `${upBody.sha256} vs ${sha}`);

    const before = await fetch(`${BASE}/artifacts/${sha}`);
    check("it downloads intact", before.ok && (await before.text()) === payload.toString());

    // Rot it on disk, the way a bad sector or a half-finished copy would.
    const findStored = async (root: string): Promise<string | null> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
          const hit = await findStored(full);
          if (hit) return hit;
        } else if (entry.name.includes(sha.slice(0, 16)) || entry.name === sha) {
          return full;
        }
      }
      return null;
    };
    const stored = await findStored(artifactDir);
    if (!stored) {
      check("the stored artifact can be found on disk", false, `nothing matching ${sha.slice(0, 16)} under ${artifactDir}`);
    } else {
      await writeFile(stored, "this is not what was uploaded");

      // The store hands the rotted bytes over without complaint. Asserted
      // rather than glossed over, because it is the fact that makes the
      // consumer's check load-bearing rather than belt-and-braces.
      const after = await fetch(`${BASE}/artifacts/${sha}`);
      const body = after.ok ? await after.text() : "";
      const served = createHash("sha256").update(body).digest("hex");
      check(
        "the store itself does not re-hash on read, by design",
        after.ok && served !== sha,
        `expected the store to serve the rotted bytes unchecked; got ${after.status}`,
      );

      // And the consumer refuses them. This is the real guarantee: the same
      // fetchArtifact both the host executor and the machine agent use.
      // Imported dynamically because it reads FLEET_URL at module load.
      process.env.FLEET_URL = BASE;
      const { fetchArtifact } = await import("../src/fleet-client.js");
      let refused: string | null = null;
      try {
        await fetchArtifact(sha, path.join(dir, "fetched.bin"));
      } catch (e) {
        refused = (e as Error).message;
      }
      check("a consumer refuses a rotted artifact", refused !== null,
        "fetchArtifact accepted bytes that do not hash to the sha it asked for");
      check("and the refusal names a hash mismatch", /hash mismatch/i.test(refused ?? ""), refused ?? "");
    }

    // --- 4. the collector dying does not lose the fleet ----------------------
    //
    // SQLite in WAL mode is the promise. A collector killed mid-write must come
    // back with its devices, its jobs and its history, because launchd will
    // restart it and nobody will be watching when it does.
    console.log("\n4. the collector is killed and comes back");
    await api("POST", "/jobs", {
      schema: 1, job_id: "chaos-survive", workload: "benchmark", executor: "device", backend: "synthetic",
      targets: { device_id: DEV },
    });
    const beforeKill = await job("chaos-survive");
    check("a job exists before the kill", beforeKill?.status === "queued", beforeKill?.status);

    // SIGKILL, not SIGTERM: a clean shutdown proves nothing about durability.
    collector.kill("SIGKILL");
    await sleep(1500);
    collector = await start();

    const afterKill = await job("chaos-survive");
    check("the job survives a SIGKILL", afterKill?.status === "queued", afterKill?.status);
    const devs = (await api("GET", "/api/devices")).body;
    check("the device survives too", (devs?.devices ?? []).some((d: any) => d.device_id === DEV));
    const failedStill = await job("chaos-lease");
    check("history survives: the failed job is still failed", failedStill?.status === "failed", failedStill?.status);
    const size = await stat(path.join(dataDir, "fleet.db"));
    check("the database is on disk and non-empty", size.size > 0, String(size.size));

    // --- 5. a cancelled job stays cancelled across a restart -----------------
    //
    // 'cancelled' is deliberately not 'failed' — the dashboard's failure counts
    // and every alert built on them depend on that distinction surviving.
    console.log("\n5. cancelled is not failed, and stays that way");
    await api("POST", "/api/jobs/chaos-survive/cancel");
    const cancelled = await job("chaos-survive");
    check("the job cancels", cancelled?.status === "cancelled", cancelled?.status);
    collector.kill("SIGKILL");
    await sleep(1500);
    collector = await start();
    const stillCancelled = await job("chaos-survive");
    check("and is still cancelled, not failed, after a restart",
      stillCancelled?.status === "cancelled", stillCancelled?.status);

    // A cancelled job must not be handed out again by the sweep.
    await sleep(3000);
    const notReoffered = (await api("GET", `/devices/${DEV}/next-job`)).body;
    check("a cancelled job is never re-offered",
      notReoffered?.job_id !== "chaos-survive", JSON.stringify(notReoffered));
  } catch (e) {
    failed++;
    console.error(`  ${(e as Error).message}`);
  } finally {
    collector?.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nchaos: ALL PASS" : `\nchaos: ${failed} FAILURE(S)`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
