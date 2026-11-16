/**
 * The night command's preflight, without a brain, a simulator or a model.
 *
 * The first half pins the pure pieces: when the night ends, how the minutes
 * left are shared among the specs, what counts as tonight's build, and which
 * warm-up failures are a host with no room. The second half runs
 * `scripts/explore-night.ts` itself against a fake brain, with a simulator
 * spec and a warm-up command that would both fail loudly if they were ever
 * reached, to show that a night with nothing to test or no time left posts a
 * skip and exits 0 before it touches either.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMissing, fetchedSince, lastLine, nextClock, nightEnd, nightManifestMinutes, nightStart, planSpecs,
  shortNightNote, warmRefusedForMemory,
} from "./night.js";
import {
  adoptable, deviceBusy, readRecords, sweepAction, withRecord, withoutSerial, writeRecords, type BootRecord,
} from "./night-devices.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const same = (a: Date, b: Date) => a.getTime() === b.getTime();

export async function runNightChecks(check: Check) {
  // --- when the night ends ---------------------------------------------------
  check("at 22:00 the 07:30 stop is tomorrow morning", same(nextClock(at(2026, 10, 14, 22), "07:30"), at(2026, 10, 15, 7, 30)));
  check("at 03:00 it is this morning", same(nextClock(at(2026, 10, 15, 3), "07:30"), at(2026, 10, 15, 7, 30)));
  check("at 07:30 exactly it is tomorrow", same(nextClock(at(2026, 10, 15, 7, 30), "07:30"), at(2026, 10, 16, 7, 30)));
  let threw = false;
  try { nextClock(new Date(), "7.30"); } catch { threw = true; }
  check("a malformed --until is refused, not guessed", threw);

  check("02:00 on Thursday belongs to Wednesday night", same(nightStart(at(2026, 10, 15, 2)), at(2026, 10, 14, 12)));
  check("22:00 on Wednesday is Wednesday night", same(nightStart(at(2026, 10, 14, 22)), at(2026, 10, 14, 12)));

  const e1 = nightEnd({ now: at(2026, 10, 15, 6, 30), startedAt: at(2026, 10, 15, 6, 30), maxMinutes: 90 });
  check("06:30 with 90 minutes: the 07:30 stop comes first", same(e1.end, at(2026, 10, 15, 7, 30)) && e1.by === "the 07:30 stop", JSON.stringify(e1));
  const e2 = nightEnd({ now: at(2026, 10, 14, 23), startedAt: at(2026, 10, 14, 23), maxMinutes: 150 });
  check("23:00 with 150 minutes: max_minutes comes first", same(e2.end, at(2026, 10, 15, 1, 30)) && /150-minute max_minutes/.test(e2.by), JSON.stringify(e2));
  const e3 = nightEnd({ now: at(2026, 10, 15, 6), startedAt: at(2026, 10, 15, 6), until: "06:45" });
  check("--until moves the stop", same(e3.end, at(2026, 10, 15, 6, 45)) && e3.by === "the 06:45 stop");

  // --- max_minutes from the night queue's manifest ----------------------------
  const files: Record<string, string> = {
    // path.join, so the keys match what the reader builds on Windows too.
    [path.join("/n", "recurring", "fleet-explore-tv.json")]: JSON.stringify({ name: "fleet-explore-tv", max_minutes: 150 }),
    [path.join("/n", "queue", "one-off.json")]: JSON.stringify({ name: "one-off" }),
  };
  const read = (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; };
  check("NIGHT_JOB's manifest gives max_minutes", nightManifestMinutes({ NIGHT_JOB: "fleet-explore-tv", NIGHT_ROOT: "/n" }, read) === 150);
  check("a manifest without it gets the queue's default of 60", nightManifestMinutes({ NIGHT_JOB: "one-off", NIGHT_ROOT: "/n" }, read) === 60);
  check("no NIGHT_JOB: no budget beyond --until", nightManifestMinutes({ NIGHT_ROOT: "/n" }, read) === undefined);
  check("a NIGHT_JOB that is not a manifest name is not a path", nightManifestMinutes({ NIGHT_JOB: "../etc/x", NIGHT_ROOT: "/n" }, read) === undefined);

  // --- sharing the minutes left ------------------------------------------------
  const full = planSpecs([60], 300);
  check("a night with room runs the spec as asked", full.minutes[0] === 60 && !full.short, JSON.stringify(full));
  const apple = planSpecs([60], 50);
  check("50 minutes left for a 60-minute spec: 37 (10 held back, 3 to start it)", apple.minutes[0] === 37 && apple.short, JSON.stringify(apple));
  const none = planSpecs([60], 25);
  check("25 minutes left: under the 15-minute minimum, so nothing runs", none.minutes[0] === 0 && none.short, JSON.stringify(none));
  const tv = planSpecs([45, 45, 30], 150);
  check("the TV night fits in 150 minutes", tv.minutes.join() === "45,45,30" && !tv.short, JSON.stringify(tv));
  const tv80 = planSpecs([45, 45, 30], 80);
  check("80 minutes: all three, in proportion", tv80.minutes.join() === "22,22,15" && tv80.short, JSON.stringify(tv80));
  const tv50 = planSpecs([45, 45, 30], 50);
  check("50 minutes: the last spec is dropped before anything goes under 15", tv50.minutes.join() === "17,17,0", JSON.stringify(tv50));
  check("20 minutes: none of the TV night", planSpecs([45, 45, 30], 20).minutes.every((m) => m === 0));
  check("a spec asking for less than the minimum needs only what it asks", planSpecs([10], 30).minutes[0] === 10);
  check("a custom minimum is honoured", planSpecs([60], 30, { minUsefulMin: 20 }).minutes[0] === 0 && planSpecs([60], 40, { minUsefulMin: 20 }).minutes[0] === 27);
  check("no specs, nothing to plan", planSpecs([], 100).minutes.length === 0);

  check("the short-night note says what ran in what time",
    shortNightNote(3, 7, 40, 60) === "short night: ran 3 of 7 cards: 40 minutes left of the 60 asked", shortNightNote(3, 7, 40, 60));
  check("and counts one card as a card", shortNightNote(1, 1, 20, 45).includes("ran 1 of 1 card:"));

  // --- tonight's build -------------------------------------------------------------
  const since = new Date("2026-10-14T16:00:00Z"); // noon EDT
  const tonight = { sha256: "a".repeat(64), build: "develop-3c16689273", published_at: "2026-10-15T02:52:59Z" };
  const lastNight = { sha256: "b".repeat(64), build: "develop-3c16689273", published_at: "2026-10-14T02:52:59Z" };
  check("a build published tonight is tonight's", buildMissing("greenfolio-ios", tonight, since) === null);
  const stale = buildMissing("greenfolio-ios", lastNight, since, false);
  check("last night's build is not, and the skip says why",
    !!stale && stale.startsWith("skipped: no greenfolio-ios build for tonight (fleet-explore-builds did not run") &&
      stale.includes("develop-3c16689273 from 2026-10-14 02:52 UTC"), String(stale));
  check("a checkout fetched tonight with no upload says the build job ran",
    /fetched develop but uploaded no build/.test(buildMissing("greenfolio-ios", lastNight, since, true) ?? ""));
  check("unknown checkout state says either",
    /did not run or did not upload it/.test(buildMissing("greenfolio-ios", lastNight, since, null) ?? ""));
  check("no build ever is a skip too",
    buildMissing("dozehound-tvos", undefined, since)?.startsWith("skipped: no dozehound-tvos build on the brain") === true);
  check("created_at stands in for an artifact never published by app",
    buildMissing("x", { sha256: "c".repeat(64), build: null, published_at: null, created_at: "2026-10-15T01:00:00Z" }, since) === null);

  const repo = mkdtempSync(path.join(os.tmpdir(), "fleet-night-repo-"));
  check("no checkout: unknown", fetchedSince(repo, since) === null);
  mkdirSync(path.join(repo, ".git"));
  writeFileSync(path.join(repo, ".git", "FETCH_HEAD"), "");
  utimesSync(path.join(repo, ".git", "FETCH_HEAD"), new Date("2026-10-13T03:00:00Z"), new Date("2026-10-13T03:00:00Z"));
  check("a checkout last fetched yesterday was not fetched tonight", fetchedSince(repo, since) === false);
  utimesSync(path.join(repo, ".git", "FETCH_HEAD"), new Date("2026-10-15T03:00:00Z"), new Date("2026-10-15T03:00:00Z"));
  check("one fetched at 23:00 was", fetchedSince(repo, since) === true);
  check("no repo named: unknown", fetchedSince(undefined, since) === null);

  // --- warm-ups -----------------------------------------------------------------
  const oct14 = "2026-10-15 05:09:50 not loading holo4-35b-a3b@holo4-35b-a3b-gguf: 64% free, needs 65%";
  check("10-14's warm-up was refused for memory", warmRefusedForMemory(oct14));
  check("so is one refused under pressure", warmRefusedForMemory("2026-10-15 05:09:50 not loading pilot: memory pressure"));
  check("a load that broke is not a refusal", !warmRefusedForMemory("2026-10-15 05:09:50 load FAILED holo4-35b-a3b"));
  check("the reason is the last line", lastLine(`a\n${oct14}\n\n`) === oct14);

  await runNightCommandChecks(check);
  runNightDeviceChecks(check);
  await runSweepCommandChecks(check);
}

const REC: BootRecord = {
  kind: "emulator", avd: "fleet-explore-1", serial: "emulator-5554", boot_id: "b007-1d", owner_pid: 4242, booted_at: "2026-11-02T22:15:19-05:00",
};

/** Which emulators a night may shut down, and what the morning sweep does (11-02: one stayed up nine days). */
function runNightDeviceChecks(check: Check) {
  const up = { avd: "fleet-explore-1", boot_id: "b007-1d" };
  check("sweep: the night's own boot, owner gone, no job: stop", sweepAction(REC, up, { ownerAlive: false, busy: null }).action === "stop");
  check("sweep: its night still running: keep (the night stops it itself)", sweepAction(REC, up, { ownerAlive: true, busy: null }).action === "keep");
  check("sweep: a brain job on it: keep", sweepAction(REC, up, { ownerAlive: false, busy: "the brain has job x on it" }).action === "keep");
  check("sweep: nothing on the serial: forget, touch nothing", sweepAction(REC, null, { ownerAlive: false, busy: null }).action === "forget");
  check("sweep: same AVD, another boot (someone else started it): forget, never stop",
    sweepAction(REC, { avd: "fleet-explore-1", boot_id: "other" }, { ownerAlive: false, busy: null }).action === "forget");
  check("sweep: another AVD on the serial (CI's): forget, never stop",
    sweepAction(REC, { avd: "ci-ultra-greenfolio-android-2", boot_id: "b007-1d" }, { ownerAlive: false, busy: null }).action === "forget");
  check("sweep: a record without a boot id matches nothing",
    sweepAction({ ...REC, boot_id: "" }, { avd: "fleet-explore-1", boot_id: "" }, { ownerAlive: false, busy: null }).action === "forget");

  check("adopt: an earlier night's boot whose night is gone", adoptable([REC], "emulator-5554", up, () => false)?.owner_pid === 4242);
  check("adopt: not while that night is still running", adoptable([REC], "emulator-5554", up, () => true) === null);
  check("adopt: not an emulator with no record (another session's)", adoptable([], "emulator-5554", up, () => false) === null);
  check("adopt: not a different boot of the same AVD", adoptable([REC], "emulator-5554", { ...up, boot_id: "x" }, () => false) === null);

  check("busy: a current job", deviceBusy({ current_job: "explore-garden-1" })?.includes("explore-garden-1") === true);
  check("busy: a lock", deviceBusy({ current_job: null, lock: { job_id: "x" } }) !== null);
  check("busy: neither", deviceBusy({ current_job: null, lock: null }) === null && deviceBusy(null) === null);

  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-night-state-"));
  const file = path.join(dir, "sub", "booted.json");
  check("no state file: no records", readRecords(file).length === 0);
  writeRecords(file, withRecord([], REC));
  writeRecords(file, withRecord(readRecords(file), { ...REC, boot_id: "newer", owner_pid: 7 }));
  const back = readRecords(file);
  check("one record per serial, the newest kept", back.length === 1 && back[0].boot_id === "newer" && back[0].owner_pid === 7, JSON.stringify(back));
  check("forgetting a serial removes it", withoutSerial(back, "emulator-5554").length === 0);
  writeFileSync(file, "{not json");
  check("a broken state file reads as no records, not a crash", readRecords(file).length === 0);
}

/**
 * `explore-night.ts --sweep` with a fake adb and a fake brain: it stops the
 * night's own orphan with `adb emu kill`, and leaves alone a different boot,
 * a device with a job on it, and anything it has no record of.
 */
async function runSweepCommandChecks(check: Check) {
  if (process.platform === "win32") return; // the fake adb is a shell script; the sweep runs on ultra
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-sweep-"));
  const sdk = path.join(dir, "sdk");
  mkdirSync(path.join(sdk, "platform-tools"), { recursive: true });
  const calls = path.join(dir, "adb-calls");
  const gone = path.join(dir, "killed");
  // emulator-5554 runs fleet-explore-1 (boot b007-1d) until it is sent `emu kill`;
  // emulator-5556 runs CI's AVD and emulator-5558 runs fleet-explore-2 (another boot).
  writeFileSync(path.join(sdk, "platform-tools", "adb"), `#!/bin/bash
echo "$*" >> "${calls}"
if [ "$1" = devices ]; then
  echo "List of devices attached"
  [ -f "${gone}" ] || printf 'emulator-5554\tdevice\n'
  printf 'emulator-5556\tdevice\nemulator-5558\tdevice\n'
  exit 0
fi
s="$2"; shift 2
if [ "$s" = emulator-5554 ] && [ -f "${gone}" ]; then echo "error: device not found" >&2; exit 1; fi
case "$s $*" in
  "emulator-5554 emu avd name") printf 'fleet-explore-1\r\nOK\r\n' ;;
  "emulator-5556 emu avd name") printf 'ci-ultra-greenfolio-android-2\r\nOK\r\n' ;;
  "emulator-5558 emu avd name") printf 'fleet-explore-2\r\nOK\r\n' ;;
  "emulator-5554 shell cat /proc/sys/kernel/random/boot_id") echo b007-1d ;;
  "emulator-5556 shell cat /proc/sys/kernel/random/boot_id") echo c1-boot ;;
  "emulator-5558 shell cat /proc/sys/kernel/random/boot_id") echo started-by-someone-else ;;
  "emulator-5554 emu kill") touch "${gone}"; echo "OK: killing emulator, bye bye" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(path.join(sdk, "platform-tools", "adb"), 0o755);

  let busy: string | null = null;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.startsWith("/api/devices/")) return send(200, { device_id: decodeURIComponent(url.split("/")[3]), current_job: busy, lock: null });
    send(404, { error: "not here" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const state = path.join(dir, "booted.json");
  const sweep = (extra: string[] = []) => new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/explore-night.ts", "--sweep", ...extra], {
      cwd: root, env: { ...process.env, ANDROID_HOME: sdk, FLEET_URL: `http://127.0.0.1:${port}`, FLEET_EXPLORE_STATE: state },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
  const killed = () => existsSync(calls) && readFileSync(calls, "utf8").split("\n").filter((l) => / emu kill$/.test(l));
  // A pid that is certainly not a live explore-night: this test's own parent is not one, and 999999 is unused.
  const dead = 999_999;
  try {
    const r0 = await sweep();
    check("sweep with no records: nothing to do, exit 0", r0.code === 0 && /no emulator booted by a night is on record/.test(r0.out), r0.out);

    writeRecords(state, [
      { ...REC, owner_pid: dead },
      { ...REC, avd: "fleet-explore-2", serial: "emulator-5558", boot_id: "our-old-boot", owner_pid: dead },
    ]);
    busy = "explore-jerv-1";
    const r1 = await sweep();
    check("a brain job on the night's emulator keeps it up", r1.code === 0 && /keep: fleet-explore-1: the brain has job explore-jerv-1/.test(r1.out), r1.out);
    check("and nothing was killed", (killed() || []).length === 0, String(killed()));
    check("a replaced boot is forgotten, not stopped", /forget: emulator-5558 now runs fleet-explore-2/.test(r1.out) && readRecords(state).length === 1, r1.out);

    const dry = await sweep(["--dry-run"]);
    busy = null;
    const r2dry = await sweep(["--dry-run"]);
    check("a dry sweep says it would stop the orphan, and does not", /stop: fleet-explore-1 on emulator-5554/.test(r2dry.out) && (killed() || []).length === 0, `${dry.out}
${r2dry.out}`);

    const r2 = await sweep();
    const kills = killed() || [];
    check("the night's orphan is stopped with adb emu kill on its own serial", kills.length === 1 && kills[0] === "-s emulator-5554 emu kill", String(kills));
    check("and only it: CI's emulator and the other boot were never sent a kill", !kills.some((k) => /5556|5558/.test(k)));
    check("the sweep waits until adb no longer lists it, then forgets it", r2.code === 0 && /fleet-explore-1 \(emulator-5554\) is down/.test(r2.out) && readRecords(state).length === 0, r2.out);
  } finally {
    server.close();
  }
}

/** explore-night.ts against a fake brain: what it posts, and that it never reaches the device. */
async function runNightCommandChecks(check: Check) {
  const posts: { url: string; body: Record<string, any> }[] = [];
  let published = "2026-01-01T00:00:00Z";
  const body = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url === "/api/health") return send(200, { ok: true });
    if (url.startsWith("/api/artifacts?")) {
      return send(200, { artifacts: [{ sha256: "d".repeat(64), build: "develop-0123456789", published_at: published }] });
    }
    if (req.method === "POST" && (url === "/jobs" || url === "/results")) {
      posts.push({ url, body: JSON.parse(await body(req)) });
      return send(url === "/jobs" ? 201 : 200, { ok: true });
    }
    send(404, { error: "not here" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-night-cmd-"));
  const specFile = path.join(dir, "spec.json");
  writeFileSync(specFile, JSON.stringify({
    schema: 1, job_id: "explore-greenfolio-ios", workload: "explore", executor: "host",
    app: { name: "greenfolio-ios", build: "latest", sha256: "latest", platform: "ios" },
    targets: { executor: "ultra", match: "os ~ 'ios'" }, params: { app_id: "com.taylab.greenfolio", minutes: 60 },
  }));
  // If either of these were reached the run would fail: there is no such
  // simulator runtime, and the warm-up exits 3 and is not a memory refusal.
  const deviceAndModel = ["--sim", "fleet-night-test:no.such.runtime:no.such.type", "--warm", "echo warmed-up hold=$SHELF_HOLD_PID >&2; exit 3"];
  const runNight = (extra: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/explore-night.ts", "--spec", specFile, ...deviceAndModel, ...extra], {
      cwd: root, env: { ...process.env, FLEET_URL: `http://127.0.0.1:${port}`, FLEET_EXECUTOR_NAME: "night-test", NIGHT_JOB: "", FLEET_XCODEBUILD: "true", ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    const kill = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("exit", (code) => { clearTimeout(kill); resolve({ code: code ?? -1, out }); });
  });

  const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  // A stop a minute ago is almost a whole day away: room for anything.
  const roomy = ["--until", hm(new Date(Date.now() - 60_000))];
  try {
    // 1. No build for tonight: skipped, before the model or the simulator.
    const r1 = await runNight(["--fresh-build"]);
    const job = posts.find((x) => x.url === "/jobs")?.body;
    const result = posts.find((x) => x.url === "/results")?.body;
    check("no build for tonight: exit 0, because it is not this job's failure", r1.code === 0, r1.out);
    check("it posted the job to the brain, pinned to this executor", job?.targets?.executor === "night-test" && /^explore-greenfolio-ios-\d{4}-\d\d-\d\d-/.test(job?.job_id ?? ""), JSON.stringify(job));
    check("without a build: nothing was tested", job?.app?.sha256 === undefined && job?.app?.name === "greenfolio-ios", JSON.stringify(job?.app));
    check("and closed it as a skip that says why",
      result?.final === true && result?.ok === true && result?.device_id === "host:night-test" &&
        String(result?.error).startsWith("skipped: no greenfolio-ios build for tonight (fleet-explore-builds did not run"),
      JSON.stringify(result));
    check("the night queue's log says so too", /skipped: no greenfolio-ios build for tonight/.test(r1.out), r1.out);
    check("the warm-up never ran and no simulator was booted", !/warmed-up|booting|creating simulator/.test(r1.out), r1.out);

    // 2. A dry run with a build from tonight: says what it would do, posts nothing.
    posts.length = 0;
    published = new Date().toISOString();
    const r2 = await runNight(["--fresh-build", "--dry-run", ...roomy]);
    check("a dry run exits 0", r2.code === 0, r2.out);
    check("and posts nothing to the brain", posts.length === 0, JSON.stringify(posts));
    check("it would run the spec, warm the model and boot the simulator",
      /would run spec\.json/.test(r2.out) && /would warm: echo warmed-up/.test(r2.out) && /would boot fleet-night-test/.test(r2.out), r2.out);
    check("and did none of it", !/warm: warmed-up|booting|creating simulator/.test(r2.out), r2.out);

    // 3. Too little night left: skipped, before the model or the simulator.
    posts.length = 0;
    const soon = new Date(Date.now() + 12 * 60_000);
    const r3 = await runNight(["--until", hm(soon)]);
    const r3result = posts.find((x) => x.url === "/results")?.body;
    check("eleven or so minutes left: exit 0", r3.code === 0, r3.out);
    check("posted as a skip under the minimum",
      r3result?.ok === true && /^skipped: 1\d minutes left before the \d\d:\d\d stop, under the 15-minute minimum/.test(String(r3result?.error)),
      JSON.stringify(r3result));
    check("again without warming or booting", !/warmed-up|booting|creating simulator/.test(r3.out), r3.out);

    // 4. The warm-up fails for a reason that is not memory: a failure, posted as one.
    // The warm command runs under /bin/bash, as it does on ultra; the night
    // command is macOS-only, so Windows has nothing to run it with.
    if (process.platform !== "win32") {
      posts.length = 0;
      const r4 = await runNight(roomy);
      const r4result = posts.find((x) => x.url === "/results")?.body;
      check("a broken warm-up fails the night (exit 1)", r4.code === 1, r4.out);
      check("and the brain is told why", r4result?.ok === false && /^the model did not load: warmed-up/.test(String(r4result?.error)), JSON.stringify(r4result));
      check("the warm-up was told to hold the model for this process (SHELF_HOLD_PID)", /warmed-up hold=\d+/.test(r4.out), r4.out);
      check("the simulator was still not booted", !/booting|creating simulator/.test(r4.out), r4.out);
    }

    // 5. Xcode updated without its first-launch install (ultra, 10-16 and
    // 10-17): a failure that names the fix, found before the model is warmed.
    // The check is xcodebuild's, so only a Mac makes it.
    if (process.platform === "darwin") {
      posts.length = 0;
      const r5 = await runNight(roomy, { FLEET_XCODEBUILD: "false" });
      const r5result = posts.find((x) => x.url === "/results")?.body;
      check("Xcode needing its first launch fails the night (exit 1)", r5.code === 1, r5.out);
      check("and the brain is told the fix",
        r5result?.ok === false && /needs its first-launch install .*sudo xcodebuild -runFirstLaunch/.test(String(r5result?.error)), JSON.stringify(r5result));
      check("before warming the model or booting the simulator", !/warmed-up|booting|creating simulator/.test(r5.out), r5.out);
    }
  } finally {
    server.close();
  }
}
