// One night of explore, as a single command that returns when the night is over.
//
// On ultra the night is scheduled by the harness's night queue, not by the
// brain: the queue admits a job only when memory pressure is normal, enough
// memory is free and no CI job is running, and it needs to know when the job
// has finished so the memory is free again. So instead of a long-lived
// executor claiming whatever the brain hands it, this command:
//
//   1. opens the tunnel to the brain and checks, before anything expensive,
//      that each spec has a build to test (`--fresh-build`: one published
//      tonight), that the night has time left for it, and with `--sim` that
//      Xcode has had its first-launch install;
//   2. warms the model (`--warm "<cmd>"`), retrying a warm-up the host refused
//      for memory for up to `--warm-wait` minutes, and hands the same command
//      to the workload to run again if the model is unloaded mid-night;
//   3. boots the night's emulator or simulator if it is not already up (and
//      remembers it did);
//   4. enqueues each spec on the brain with tonight's date in its id, pinned to
//      this executor's name, with `minutes` cut to what is left of the night;
//   5. runs an executor in this process until that job is done, failed or
//      cancelled;
//   6. shuts down only what it booted -- also when it is stopped by a signal
//      or crashes (from 2026-11-12; see src/workloads/explore/night-devices.ts).
//
// Emulators it boots are written down (`~/.fleet/explore-night/booted.json`,
// with the emulator's boot id). A night that finds its own earlier boot still
// up with no live owner adopts it and shuts it down at its end; an emulator
// with no record is someone else's and is never shut down.
//
//   npx tsx scripts/explore-night.ts --sweep [--dry-run]
//
// is the morning backstop (launchd `com.addisdev.fleet-explore-sweep`, 06:00
// and hourly through the day): it stops recorded emulators whose night is over
// -- the night's process gone and no brain job on the device -- with
// `adb emu kill`, and forgets records whose emulator is gone or was replaced.
//
// A spec that cannot run tonight -- no build for tonight, no time left, a
// model the host has no room to load -- is posted to the brain as a skip
// (ok: true, error "skipped: ...") and does not count against the night. The
// exit code is 0 when every job finished or skipped and 1 otherwise: ultra's
// night queue has no skip code, and a missing upstream build is not this
// job's failure.
//
//   npx tsx scripts/explore-night.ts --spec examples/jobs/explore-garden-ultra.json \
//     [--avd fleet-explore-1 | --sim name:runtime:devicetype] [--tunnel jump:host:port]
//     [--fresh-build] [--warm "bash ~/harness/shelf.sh warm pilot"] [--warm-wait 10]
//     [--until 07:30] [--max-minutes N] [--min-minutes 15] [--dry-run]
//
// --until is the night queue's hard stop (default 07:30). --max-minutes is the
// job's own kill timer; by default it is read from the night queue's manifest
// for $NIGHT_JOB (read-only), which is the only place the job can learn it.
// The night ends at whichever comes first. --dry-run opens the tunnel, runs
// the checks and prints the plan; it enqueues nothing, posts nothing, warms
// nothing and boots nothing.
//
// --tunnel opens `ssh -N -L <local>:<host>:<port> <jump>` for the length of
// the night and closes it after, for a brain on another machine. On ultra it
// is not used any more: the brain runs there (since 2026-10-21) and the night
// manifests set FLEET_URL=http://127.0.0.1:8789. Until then the brain was on
// fleet-host, which ultra cannot route to, and every night hopped through a
// third Mac.
//
// Env: FLEET_URL (the brain, or the local end of the tunnel), FLEET_EXECUTOR_NAME (default
// "ultra"), NIGHT_JOB / NIGHT_ROOT (the night queue's job name and directory),
// and HARNESS_GATEWAY / HARNESS_KEY, which the night queue sets and the
// workload reads.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  NIGHT, buildMissing, fetchedSince, lastLine, nightEnd, nightManifestMinutes, nightStart, planSpecs,
  warmRefusedForMemory, type BrainBuild,
} from "../src/workloads/explore/night.js";
import {
  adoptable, deviceBusy, readRecords, stateFile, sweepAction, withRecord, withoutSerial, writeRecords,
  type BootRecord, type Seen,
} from "../src/workloads/explore/night-devices.js";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// When the night queue started this job, near enough: its max_minutes runs from here.
const STARTED = new Date(Date.now() - process.uptime() * 1000);
const a = process.argv.slice(2);
const arg = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const BASE = (process.env.FLEET_URL ?? "http://127.0.0.1:18788").replace(/\/+$/, "");
const NAME = process.env.FLEET_EXECUTOR_NAME ?? "ultra";
const SDK = process.env.ANDROID_HOME ?? path.join(process.env.HOME ?? "", "Library/Android/sdk");
const ADB = path.join(SDK, "platform-tools/adb");
// Local time, like every other time in these lines ("the night ends at 06:14")
// and in the night queue's own log; UTC here put two clocks in one line.
const log = (m: string) => console.log(`[explore-night ${new Date().toTimeString().slice(0, 8)}] ${m}`);
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

/** The AVD name and kernel boot id of what runs on `serial`, or null when nothing answers. */
async function seenOn(serial: string): Promise<Seen> {
  const avd = await run(ADB, ["-s", serial, "emu", "avd", "name"], { timeout: 15_000 }).then((r) => r.stdout.split("\n")[0].trim(), () => "");
  if (!avd) return null;
  const bootId = await run(ADB, ["-s", serial, "shell", "cat", "/proc/sys/kernel/random/boot_id"], { timeout: 15_000 })
    .then((r) => r.stdout.trim(), () => "");
  return { avd, boot_id: bootId };
}

/** Whether `pid` is a live explore-night process (not just any process that reused the pid). */
async function ownerAlive(pid: number): Promise<boolean> {
  if (!(pid > 0) || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); } catch { return false; }
  const cmd = await run("ps", ["-o", "command=", "-p", String(pid)]).then((r) => r.stdout, () => "");
  return cmd.includes("explore-night");
}

const STATE = stateFile();
const record = (rec: BootRecord) => writeRecords(STATE, withRecord(readRecords(STATE), rec));
const forget = (serial: string) => writeRecords(STATE, withoutSerial(readRecords(STATE), serial));

/** Ask the emulator to quit (`adb emu kill`) and wait until adb no longer lists it. */
async function stopEmulator(serial: string, waitS = 60): Promise<boolean> {
  await run(ADB, ["-s", serial, "emu", "kill"], { timeout: 15_000 }).catch(() => {});
  for (let i = 0; i < waitS / 2; i++) {
    await sleep(2000);
    const { stdout } = await run(ADB, ["devices"]).catch(() => ({ stdout: "" }));
    if (!stdout.split("\n").some((l) => l.split("\t")[0] === serial)) return true;
  }
  return false;
}

async function bootEmulator(avd: string): Promise<{ serial: string; booted: boolean }> {
  const running = await emulatorFor(avd);
  if (running) {
    const seen = await seenOn(running);
    const alive = new Map<number, boolean>();
    for (const r of readRecords(STATE)) alive.set(r.owner_pid, await ownerAlive(r.owner_pid));
    const mine = adoptable(readRecords(STATE), running, seen, (pid) => alive.get(pid) ?? false);
    if (mine) {
      log(`${avd} is already up as ${running}, booted by an earlier night (pid ${mine.owner_pid}) that is gone; ` +
        "adopting it, so it is shut down when this night ends");
      record({ ...mine, owner_pid: process.pid });
      return { serial: running, booted: true };
    }
    log(`${avd} is already up as ${running} and this night did not boot it; it is left up afterwards`);
    return { serial: running, booted: false };
  }
  log(`booting ${avd}`);
  const child = spawn(path.join(SDK, "emulator/emulator"), ["-avd", avd, "-no-window", "-no-audio", "-no-snapshot-save", "-no-boot-anim"],
    { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const serial = await emulatorFor(avd);
    if (serial) {
      const done = await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"]).then((r) => r.stdout.trim(), () => "");
      if (done === "1") {
        log(`${avd} is up as ${serial}`);
        const seen = await seenOn(serial);
        record({ kind: "emulator", avd, serial, boot_id: seen?.boot_id ?? "", owner_pid: process.pid, booted_at: new Date().toISOString() });
        return { serial, booted: true };
      }
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

/** All values of a repeated flag. */
const args = (k: string) => a.flatMap((x, i) => (x === k && a[i + 1] ? [a[i + 1]] : []));

/**
 * A simulator by name, created if missing, booted if not. `spec` is
 * `name:runtime:devicetype`, e.g.
 * `fleet-explore-ios:com.apple.CoreSimulator.SimRuntime.iOS-26-5:com.apple.CoreSimulator.SimDeviceType.iPhone-16`.
 * A 26.x runtime, not 27: XCUITest runners abort on the iOS 27 runtime here.
 */
async function bootSimulator(spec: string): Promise<{ udid: string; booted: boolean }> {
  const [name, runtime, deviceType] = spec.split(":");
  const list = JSON.parse((await run("xcrun", ["simctl", "list", "devices", "-j"], { maxBuffer: 16 << 20 })).stdout) as
    { devices: Record<string, { name: string; udid: string; state: string; isAvailable: boolean }[]> };
  let found = (list.devices[runtime] ?? []).find((d) => d.name === name && d.isAvailable);
  if (!found) {
    log(`creating simulator ${name} (${runtime})`);
    const udid = (await run("xcrun", ["simctl", "create", name, deviceType, runtime])).stdout.trim();
    found = { name, udid, state: "Shutdown", isAvailable: true };
  }
  const booted = found.state !== "Booted";
  if (booted) {
    log(`booting simulator ${name}`);
    await run("xcrun", ["simctl", "boot", found.udid]).catch(() => {});
    await run("xcrun", ["simctl", "bootstatus", found.udid, "-b"], { timeout: 600_000 });
  }
  // A fresh simulator puts iOS's "slide to type" tip over the app the first
  // time a keyboard opens. It is the system's, not the app's, and the judge
  // would otherwise file it.
  await run("xcrun", ["simctl", "spawn", found.udid, "defaults", "write", "com.apple.keyboard.preferences",
    "DidShowContinuousPathIntroduction", "-bool", "true"]).catch(() => {});
  return { udid: found.udid, booted };
}

type Spec = Record<string, unknown> & {
  job_id?: string;
  targets?: Record<string, unknown>;
  app?: { name?: string; build?: string; sha256?: string; platform?: string };
  params?: Record<string, unknown> & { minutes?: number; changed?: { repo?: string } };
};
type Item = { path: string; spec: Spec; asked: number; jobId: string };
/** A spec that will not run tonight, and what to post for it. */
type Verdict = { ok: boolean; error: string };

const minutesLeft = (end: Date) => Math.floor((end.getTime() - Date.now()) / 60_000);
const hhmm = (d: Date) => d.toTimeString().slice(0, 5);

/** Why this spec has nothing to test tonight, or null. Asked of the brain, through the tunnel. */
async function buildProblem(item: Item, fresh: boolean): Promise<Verdict | null> {
  const app = item.spec.app;
  if (!app?.sha256) return null; // explores whatever is installed
  if (app.sha256 !== "latest") {
    const res = await fetch(`${BASE}/artifacts/${app.sha256}`, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(15_000) })
      .catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, error: `could not ask the brain for build ${app.sha256.slice(0, 12)}: ${res.message}` };
    await res.body?.cancel().catch(() => {});
    // A pinned build that is gone is this spec's own problem, not an upstream one.
    if (res.status === 404) return { ok: false, error: `build ${app.build ?? app.sha256.slice(0, 12)} of ${app.name ?? "the app"} is not on the brain` };
    return null;
  }
  if (!app.name) return null; // the brain refuses it at enqueue, and says why
  const res = await fetch(`${BASE}/api/artifacts?app=${encodeURIComponent(app.name)}&per_page=1`, { signal: AbortSignal.timeout(15_000) })
    .catch((e: Error) => e);
  if (res instanceof Error || !res.ok) {
    return { ok: false, error: `could not ask the brain for ${app.name}'s builds: ${res instanceof Error ? res.message : `GET /api/artifacts -> ${res.status}`}` };
  }
  const newest = ((await res.json()) as { artifacts?: BrainBuild[] }).artifacts?.[0];
  if (!newest) return { ok: true, error: buildMissing(app.name, undefined, new Date())! };
  if (!fresh) return null;
  const since = nightStart(new Date());
  const why = buildMissing(app.name, newest, since, fetchedSince(item.spec.params?.changed?.repo, since));
  return why ? { ok: true, error: why } : null;
}

/**
 * Post a spec that will not run as a finished job: enqueued, then closed at
 * once with a final row on host:<executor>, the way the executor itself
 * closes a job it skips. No executor is polling yet, so nothing claims it in
 * between. The build is left out: nothing was tested, and a skip pinned to
 * yesterday's build would read as yesterday's build having been tested.
 */
async function postUnrun(item: Item, v: Verdict): Promise<string> {
  const { sha256: _sha, build: _build, ...app } = item.spec.app ?? {};
  const body = {
    ...item.spec, job_id: item.jobId, ...(item.spec.app ? { app } : {}),
    targets: { ...(item.spec.targets ?? {}), executor: NAME },
  };
  const tag = path.basename(item.path);
  try {
    const q = await fetch(`${BASE}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!q.ok) return `${tag}: POST /jobs -> ${q.status} ${(await q.text()).slice(0, 200)}`;
    const r = await fetch(`${BASE}/results`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ schema: 1, kind: "result", job_id: item.jobId, device_id: `host:${NAME}`, iter: 0, final: true, ok: v.ok, error: v.error.slice(0, 500) }),
    });
    if (!r.ok) return `${tag}: POST /results -> ${r.status}`;
  } catch (e) {
    return `${tag}: ${(e as Error).message}`;
  }
  log(`${item.jobId}: ${v.ok ? "" : "failed: "}${v.error}`);
  return `${item.jobId}: ${v.ok ? "skipped" : "failed"}`;
}

/**
 * Why Xcode cannot run a simulator test tonight, or null. After an Xcode
 * update its first-launch install (CoreSimulator among it) has to run before
 * xcodebuild can drive a simulator; until then every FleetDriver start fails a
 * minute in with "CoreSimulator is out of date". ultra's Xcode updated itself
 * to 27.1 on 2026-10-16 and the TV and Apple nights failed that way after
 * warming a 25 GB model for nothing. `-checkFirstLaunchStatus` answers in a
 * second, and only the owner can run the fix (it needs sudo). FLEET_XCODEBUILD
 * stands in for xcodebuild in the tests, which must not depend on this host's Xcode.
 */
async function xcodeProblem(): Promise<string | null> {
  const dir = await run("xcode-select", ["-p"]).then((r) => r.stdout.trim(), () => "Xcode");
  const code = await run(process.env.FLEET_XCODEBUILD ?? "xcodebuild", ["-checkFirstLaunchStatus"], { timeout: 60_000 }).then(() => 0, (e: { code?: number }) => e.code ?? 1);
  if (code === 0) return null;
  return `Xcode at ${dir.replace(/\/Contents\/Developer$/, "")} needs its first-launch install (xcodebuild -checkFirstLaunchStatus exit ${code}); ` +
    "run `sudo xcodebuild -runFirstLaunch` on this host";
}

/** Run the warm-up command, retrying a refusal for memory until `untilMs`. */
async function warmUp(cmd: string, untilMs: number): Promise<{ ok: true } | { ok: false; refused: boolean; line: string }> {
  for (let attempt = 1; ; attempt++) {
    const out = await run("/bin/bash", ["-c", cmd], { timeout: 15 * 60_000, maxBuffer: 4 << 20 })
      .then((r) => ({ code: 0, text: `${r.stdout}${r.stderr}` }),
        (e: { code?: number; stdout?: string; stderr?: string; message: string }) => ({ code: e.code ?? 1, text: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message }));
    for (const l of out.text.split("\n").filter((x) => x.trim())) log(`warm: ${l}`);
    if (out.code === 0) return { ok: true };
    const refused = warmRefusedForMemory(out.text);
    if (!refused || Date.now() + 60_000 > untilMs) return { ok: false, refused, line: lastLine(out.text) || `exit ${out.code}` };
    if (attempt === 1) log(`the warm-up was refused for memory; retrying every minute until ${hhmm(new Date(untilMs))}`);
    await sleep(60_000);
  }
}

/**
 * The morning backstop: stop every recorded emulator whose night is over.
 * Asks the brain whether a job is on the device first; a brain that does not
 * answer keeps the emulator up (the next sweep tries again).
 */
async function sweep(dry: boolean): Promise<void> {
  const records = readRecords(STATE);
  if (!records.length) { log(`sweep: no emulator booted by a night is on record (${STATE})`); return; }
  let bad = 0;
  for (const rec of records) {
    const seen = await seenOn(rec.serial);
    const alive = seen ? await ownerAlive(rec.owner_pid) : false;
    let busy: string | null = null;
    if (seen && !alive) {
      busy = await fetch(`${BASE}/api/devices/${encodeURIComponent(rec.serial)}`, { signal: AbortSignal.timeout(15_000) })
        .then(async (r) => (r.status === 404 ? null : r.ok ? deviceBusy(await r.json() as { current_job?: string | null; lock?: unknown })
          : `the brain answered ${r.status} for the device, so it may be in use`),
        (e: Error) => `the brain did not answer (${e.message}), so it may be in use`);
    }
    const act = sweepAction(rec, seen, { ownerAlive: alive, busy });
    log(`sweep: ${act.action}: ${act.why}`);
    if (dry) continue;
    if (act.action === "forget") forget(rec.serial);
    if (act.action === "stop") {
      if (await stopEmulator(rec.serial)) { log(`sweep: ${rec.avd} (${rec.serial}) is down`); forget(rec.serial); }
      else { log(`sweep: ${rec.avd} (${rec.serial}) still listed a minute after emu kill; the next sweep tries again`); bad++; }
    }
  }
  if (dry) log("sweep: dry run, nothing stopped or forgotten");
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (a.includes("--sweep")) return sweep(a.includes("--dry-run"));
  // Several --spec flags run one after another on the same device, sharing
  // the tunnel and the executor: a night can drive Holo4 and then the
  // resident model through the same bench, or a TV bench and its explorers.
  const specPaths = args("--spec");
  if (!specPaths.length) throw new Error("--spec <job spec JSON> is required (repeatable)");
  const avd = arg("--avd");
  const sim = arg("--sim");
  const warm = arg("--warm");
  const dry = a.includes("--dry-run");
  const fresh = a.includes("--fresh-build");
  const num = (k: string) => { const v = arg(k); if (v === undefined) return undefined; const n = Number(v); if (!(n > 0)) throw new Error(`${k} wants a positive number, got "${v}"`); return n; };
  const minUseful = num("--min-minutes") ?? NIGHT.minUsefulMin;
  const warmWait = num("--warm-wait") ?? NIGHT.warmWaitMin;
  const maxMinutes = num("--max-minutes") ?? nightManifestMinutes();
  const night = new Date().toISOString().slice(0, 10);

  const items: Item[] = specPaths.map((p) => {
    const spec = JSON.parse(readFileSync(p, "utf8")) as Spec;
    const asked = typeof spec.params?.minutes === "number" ? spec.params.minutes : 150;
    return { path: p, spec, asked, jobId: `${spec.job_id ?? "explore"}-${night}-${Math.random().toString(36).slice(2, 6)}` };
  });

  const { end, by } = nightEnd({ now: new Date(), startedAt: STARTED, until: arg("--until"), maxMinutes });
  log(`the night ends at ${hhmm(end)} (${by}): ${minutesLeft(end)} minutes left; the specs ask for ${items.map((i) => i.asked).join(" + ")}`);

  const tunnel = arg("--tunnel");
  const closeTunnel = tunnel ? await openTunnel(tunnel) : () => {};
  process.once("exit", () => closeTunnel());

  // --- preflight: cheap checks before the model or a device ----------------
  const verdicts = new Map<Item, Verdict>();
  for (const item of items) {
    const v = await buildProblem(item, fresh);
    if (v) verdicts.set(item, v);
  }
  const runnable = () => items.filter((i) => !verdicts.has(i));
  const tooShort = (left: number) =>
    `skipped: ${Math.max(0, left)} minutes left before ${by}, under the ${minUseful}-minute minimum for this spec`;
  {
    const left = minutesLeft(end);
    const list = runnable();
    const plan = planSpecs(list.map((i) => i.asked), left, { minUsefulMin: minUseful });
    list.forEach((i, k) => { if (plan.minutes[k] === 0) verdicts.set(i, { ok: true, error: tooShort(left) }); });
    if (plan.short && plan.minutes.some((m) => m > 0)) {
      log(`short night: ${list.map((i, k) => `${path.basename(i.path)} ${plan.minutes[k]} of ${i.asked} min`).join(", ")}`);
    }
  }
  // A host problem, not a spec's: a failure with its reason, so the night
  // queue's check stays red until someone fixes it, but found before the
  // model is warmed rather than ten minutes into each job.
  if (sim && process.platform === "darwin" && runnable().length) {
    const why = await xcodeProblem();
    if (why) for (const i of runnable()) verdicts.set(i, { ok: false, error: why });
  }
  for (const [i, v] of verdicts) log(`${path.basename(i.path)}: ${v.ok ? "" : "cannot run: "}${v.error}`);

  if (dry) {
    for (const i of runnable()) log(`would run ${path.basename(i.path)}`);
    if (warm && runnable().length) log(`would warm: ${warm}`);
    if ((avd || sim) && runnable().length) log(`would boot ${avd ?? sim?.split(":")[0]} if it is not up`);
    log(`dry run: nothing enqueued, posted, warmed or booted`);
    process.exit(0);
  }

  const outcomes: string[] = [];
  const finish = (): never => {
    const bad = outcomes.filter((o) => !/: (done|skipped)$/.test(o));
    log(bad.length ? `not every job finished: ${bad.join("; ")}` : `all ${outcomes.length} job(s) done or skipped: ${outcomes.join("; ")}`);
    process.exit(bad.length ? 1 : 0);
  };
  const postAll = async (v?: Verdict) => {
    for (const i of items) {
      const verdict = verdicts.get(i) ?? v;
      if (verdict) outcomes.push(await postUnrun(i, verdict));
    }
  };

  if (runnable().length === 0) { await postAll(); finish(); }

  // --- the model ---------------------------------------------------------
  if (warm) {
    // The shelf on ultra unloads an on-demand model it finds idle under
    // memory pressure, and between two missions the model is idle. With this
    // set, its warm-up records a hold for the model that lasts as long as this
    // process; the workload's warm-up after a drop inherits it too. A warm
    // command that knows nothing of it ignores it.
    process.env.SHELF_HOLD_PID = String(process.pid);
    // The wait for room may use the night, but must leave the minimum.
    const w = await warmUp(warm, Math.min(Date.now() + warmWait * 60_000, end.getTime() - (minUseful + NIGHT.safetyMin) * 60_000));
    if (!w.ok) {
      const v: Verdict = w.refused
        ? { ok: true, error: `skipped: the model would not load, no room on this host: ${w.line}` }
        : { ok: false, error: `the model did not load: ${w.line}` };
      for (const i of runnable()) verdicts.set(i, v);
      await postAll();
      finish();
    }
  }

  // --- devices and the executor -------------------------------------------
  let emulator: { serial: string; booted: boolean } | null = null;
  let simulator: { udid: string; booted: boolean } | null = null;
  let executor: { stop: () => void } | null = null;
  // Shut down only what this night booted (or adopted), once, however it
  // ends: normally, on the night queue's SIGTERM at max_minutes (it waits 30 s
  // before SIGKILL), or on a crash. On 11-02 an unhandled fetch failure took
  // the old `finally` with it and the emulator stayed up for nine days.
  let shutting: Promise<void> | null = null;
  const shutDown = () => shutting ??= (async () => {
    executor?.stop();
    if (emulator?.booted) {
      log(`shutting down ${avd}`);
      if (await stopEmulator(emulator.serial, 20)) forget(emulator.serial);
      else log(`${avd} (${emulator.serial}) is still listed after emu kill; the morning sweep stops it`);
    }
    if (simulator?.booted) {
      log(`shutting down simulator ${sim?.split(":")[0]}`);
      await run("xcrun", ["simctl", "shutdown", simulator.udid]).catch(() => {});
    }
  })();
  const bail = (why: string, code: number) => {
    log(why);
    void shutDown().finally(() => process.exit(code));
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => bail(`${sig}: stopping the night`, 143));
  process.once("unhandledRejection", (e) => bail(`crashed: ${(e as Error)?.message ?? String(e)}`, 1));
  process.once("uncaughtException", (e) => bail(`crashed: ${e.message}`, 1));

  if (avd) emulator = await bootEmulator(avd);
  if (sim) simulator = await bootSimulator(sim);
  const deviceId = emulator?.serial ?? simulator?.udid;

  // The executor reads FLEET_URL and FLEET_EXECUTOR_NAME when its module loads,
  // so they are settled before the import rather than passed in.
  process.env.FLEET_URL = BASE;
  process.env.FLEET_EXECUTOR_NAME = NAME;
  // The model shelf may unload the model mid-night; the workload runs this
  // again when the server says it has no such model.
  if (warm) process.env.FLEET_EXPLORE_WARM = warm;
  const { startExecutor } = await import("../src/executor.js");
  executor = await startExecutor();

  try {
    for (const item of items) {
      const v = verdicts.get(item);
      if (v) { outcomes.push(await postUnrun(item, v)); continue; }
      // Plan again with the time actually left: warming and booting took some,
      // and so did the specs before this one.
      const left = minutesLeft(end);
      const rest = items.filter((i) => !verdicts.has(i) && items.indexOf(i) >= items.indexOf(item));
      const minutes = planSpecs(rest.map((i) => i.asked), left, { minUsefulMin: minUseful }).minutes[0];
      if (!minutes) { outcomes.push(await postUnrun(item, { ok: true, error: tooShort(left) })); continue; }
      const short = minutes < item.asked;
      if (short) log(`${path.basename(item.path)}: ${minutes} of its ${item.asked} minutes (${left} left before ${by})`);
      const { spec, jobId } = item;
      const body = {
        ...spec, job_id: jobId,
        params: { ...(spec.params ?? {}), minutes, ...(short ? { short_night: { asked: item.asked } } : {}) },
        targets: { ...(spec.targets ?? {}), executor: NAME, ...(deviceId ? { device_id: deviceId } : {}) },
      };
      const res = await fetch(`${BASE}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { outcomes.push(`${path.basename(item.path)}: POST /jobs -> ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
      log(`queued ${jobId} for executor ${NAME}`);
      let final = { status: "unknown" } as { status: string; last_error?: string | null };
      for (;;) {
        await sleep(20_000);
        final = await jobStatus(jobId).catch((e) => { log(`status: ${(e as Error).message}`); return final; });
        if (["done", "failed", "cancelled", "skipped"].includes(final.status)) break;
      }
      log(`${jobId}: ${final.status}${final.last_error ? ` (${final.last_error})` : ""}`);
      outcomes.push(`${jobId}: ${final.status}`);
    }
  } finally {
    await shutDown();
  }
  finish();
}

main().catch((e) => {
  console.error(`[explore-night] ${(e as Error).message}`);
  process.exit(1);
});
