// One night of explore, as a single command that returns when the night is over.
//
// On ultra the night is scheduled by the harness's night queue, not by the
// brain: the queue admits a job only when memory pressure is normal, enough
// memory is free and no CI job is running, and it needs to know when the job
// has finished so the memory is free again. So instead of a long-lived
// executor claiming whatever the brain hands it, this command:
//
//   1. boots the night's emulator if it is not already up (and remembers it did);
//   2. enqueues the job spec on the brain with tonight's date in its id, pinned
//      to this executor's name;
//   3. runs an executor in this process until that job is done, failed or
//      cancelled;
//   4. shuts down only what it booted, and exits 0 for a job that finished and
//      1 for one that did not.
//
//   npx tsx scripts/explore-night.ts --spec examples/jobs/explore-garden-ultra.json \
//     [--avd fleet-explore-1] [--tunnel runner-ts:192.168.50.27:8788]
//
// --tunnel opens `ssh -N -L <local>:<host>:<port> <jump>` for the length of
// the night and closes it after. ultra sits on the Mini's side of the home
// network and cannot route to the brain on fleet-host at all; runner-host,
// on the tailnet, can. A tunnel that exists only while a night runs is one
// fewer service to keep alive on a machine whose services are LaunchDaemons.
//
// Env: FLEET_URL (the brain, through the tunnel), FLEET_EXECUTOR_NAME (default
// "ultra"), and HARNESS_GATEWAY / HARNESS_KEY, which the night queue sets and
// the workload reads.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const a = process.argv.slice(2);
const arg = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const BASE = (process.env.FLEET_URL ?? "http://127.0.0.1:18788").replace(/\/+$/, "");
const NAME = process.env.FLEET_EXECUTOR_NAME ?? "ultra";
const SDK = process.env.ANDROID_HOME ?? path.join(process.env.HOME ?? "", "Library/Android/sdk");
const ADB = path.join(SDK, "platform-tools/adb");
const log = (m: string) => console.log(`[explore-night ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The serial of a running emulator with this AVD name, or null. */
async function emulatorFor(avd: string): Promise<string | null> {
  const { stdout } = await run(ADB, ["devices"]).catch(() => ({ stdout: "" }));
  for (const serial of stdout.split("\n").slice(1).map((l) => l.split("\t")[0]).filter((s) => s.startsWith("emulator-"))) {
    const name = await run(ADB, ["-s", serial, "emu", "avd", "name"]).then((r) => r.stdout.split("\n")[0].trim(), () => "");
    if (name === avd) return serial;
  }
  return null;
}

async function bootEmulator(avd: string): Promise<{ serial: string; booted: boolean }> {
  const running = await emulatorFor(avd);
  if (running) return { serial: running, booted: false };
  log(`booting ${avd}`);
  const child = spawn(path.join(SDK, "emulator/emulator"), ["-avd", avd, "-no-window", "-no-audio", "-no-snapshot-save", "-no-boot-anim"],
    { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const serial = await emulatorFor(avd);
    if (serial) {
      const done = await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"]).then((r) => r.stdout.trim(), () => "");
      if (done === "1") { log(`${avd} is up as ${serial}`); return { serial, booted: true }; }
    }
  }
  throw new Error(`${avd} did not finish booting in ten minutes`);
}

async function jobStatus(id: string): Promise<{ status: string; last_error?: string | null }> {
  const res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET /api/jobs/${id} -> ${res.status}`);
  return await res.json() as { status: string; last_error?: string | null };
}

/** Open the tunnel and wait until the brain answers through it. */
async function openTunnel(spec: string): Promise<() => void> {
  const [jump, host, port] = spec.split(":");
  const local = new URL(BASE).port || "18788";
  if (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false)) {
    log(`the brain already answers at ${BASE}; no tunnel needed`);
    return () => {};
  }
  const ssh = spawn("/usr/bin/ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `${local}:${host}:${port}`, jump], { stdio: "ignore" });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false)) {
      log(`tunnel to ${host}:${port} through ${jump} is up`);
      return () => { ssh.kill(); };
    }
    if (ssh.exitCode !== null) break;
  }
  ssh.kill();
  throw new Error(`no route to the brain: ssh -L ${local}:${host}:${port} ${jump} did not come up`);
}

async function main() {
  const tunnel = arg("--tunnel");
  const closeTunnel = tunnel ? await openTunnel(tunnel) : () => {};
  process.once("exit", () => closeTunnel());
  const specPath = arg("--spec");
  if (!specPath) throw new Error("--spec <job spec JSON> is required");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown> & { targets?: Record<string, unknown>; job_id?: string };
  const avd = arg("--avd");
  const night = new Date().toISOString().slice(0, 10);
  const jobId = `${spec.job_id ?? "explore"}-${night}-${Date.now().toString(36).slice(-4)}`;

  let emulator: { serial: string; booted: boolean } | null = null;
  if (avd) emulator = await bootEmulator(avd);

  const body = {
    ...spec,
    job_id: jobId,
    targets: { ...(spec.targets ?? {}), executor: NAME, ...(emulator ? { device_id: emulator.serial } : {}) },
  };
  const res = await fetch(`${BASE}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST /jobs -> ${res.status}: ${await res.text()}`);
  log(`queued ${jobId} for executor ${NAME}`);

  // The executor reads FLEET_URL and FLEET_EXECUTOR_NAME when its module loads,
  // so they are settled before the import rather than passed in.
  process.env.FLEET_URL = BASE;
  process.env.FLEET_EXECUTOR_NAME = NAME;
  const { startExecutor } = await import("../src/executor.js");
  const executor = await startExecutor();

  let final = { status: "unknown" } as { status: string; last_error?: string | null };
  try {
    for (;;) {
      await sleep(20_000);
      final = await jobStatus(jobId).catch((e) => { log(`status: ${(e as Error).message}`); return final; });
      if (["done", "failed", "cancelled"].includes(final.status)) break;
    }
  } finally {
    executor.stop();
    if (emulator?.booted) {
      log(`shutting down ${avd}`);
      await run(ADB, ["-s", emulator.serial, "emu", "kill"]).catch(() => {});
    }
  }
  log(`${jobId}: ${final.status}${final.last_error ? ` (${final.last_error})` : ""}`);
  process.exit(final.status === "done" ? 0 : 1);
}

main().catch((e) => {
  console.error(`[explore-night] ${(e as Error).message}`);
  process.exit(1);
});
