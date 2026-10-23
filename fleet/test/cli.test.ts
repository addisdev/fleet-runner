/**
 * The work commands, run as a person or an agent would: the real binary
 * against a real collector, judged by stdout, stderr and the exit code.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeDevice, FLEET, postFinding, startCollector, tempDir, TSX, type Collector } from "./helpers.js";

let c: Collector;
let device: Awaited<ReturnType<typeof fakeDevice>>;
const home = tempDir("fleet-cli-home-");

before(async () => {
  c = await startCollector();
  device = await fakeDevice(c.base, "cli-phone", {
    answer: (job) => (String(job.job_id).startsWith("cli-skip") ? { ok: true, error: "skipped: no build for this device" } : String(job.job_id).startsWith("cli-fail") ? { ok: false, error: "assertion failed" } : undefined) as Record<string, unknown>,
  });
});
after(async () => {
  await device?.stop();
  await c?.stop();
});

type Run = { code: number | null; stdout: string; stderr: string };
function fleet(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, path.join(FLEET, "src/cli.ts"), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_HOME: home, FLEET_URL: c.base, FLEET_TOKEN: "", FLEET_RUNNER_URL: "", FLEET_RUNNER_TOKEN: "", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(opts.stdin ?? "");
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const json = (r: Run) => JSON.parse(r.stdout);

test("devices --json prints the API's list and nothing else", async () => {
  const r = await fleet(["devices", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(json(r).items.some((d: { device_id: string }) => d.device_id === "cli-phone"));
});

test("run waits and exits 0 on a pass; --json is the summary", async () => {
  const r = await fleet(["run", "benchmark", "--device", "cli-phone", "--timeout", "30", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const s = json(r);
  assert.equal(s.verdict, "passed");
  assert.equal(s.source, "cli");
});

test("a failure exits 1, a skip exits 4 -- nothing ran is not a pass", async () => {
  const failed = await fleet(["run", "benchmark", "--device", "cli-phone", "--id", "cli-fail-1", "--timeout", "30"]);
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stdout, /FAILED/);
  const skipped = await fleet(["run", "benchmark", "--device", "cli-phone", "--id", "cli-skip-1", "--timeout", "30"]);
  assert.equal(skipped.code, 4, skipped.stderr);
  assert.match(skipped.stdout, /SKIPPED \(nothing ran\)/);
});

test("an invalid spec exits 2 and names the field; an unknown workload exits 5", async () => {
  const dir = tempDir("fleet-cli-spec-");
  const file = path.join(dir, "job.json");
  writeFileSync(file, JSON.stringify({ workload: "benchmark", executor: "device", colour: "red" }));
  const bad = await fleet(["run", "--spec", file]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /colour/);

  const unknown = await fleet(["run", "teleport"]);
  assert.equal(unknown.code, 5);
  assert.match(unknown.stderr, /not_found/);

  assert.equal((await fleet(["run"])).code, 2, "no workload is a usage error");
});

test("--validate checks without queueing", async () => {
  const r = await fleet(["run", "benchmark", "--device", "cli-phone", "--validate"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^valid/);
});

test("--no-wait prints the id; wait exits 3 while it is unfinished; cancel ends it", async () => {
  const queued = await fleet(["run", "benchmark", "--device", "nobody-home", "--no-wait"]);
  assert.equal(queued.code, 0, queued.stderr);
  const id = queued.stdout.trim();
  assert.ok(id);
  const waited = await fleet(["wait", id, "--timeout", "1"]);
  assert.equal(waited.code, 3);
  assert.match(waited.stderr, /fleet wait/);
  assert.equal((await fleet(["cancel", id, "--reason", "test"])).code, 0);
  const after = await fleet(["job", id, "--json"]);
  assert.equal(after.code, 1);
  assert.equal(json(after).verdict, "cancelled");
});

test("results and flaky read back what ran", async () => {
  const r = await fleet(["results", "--device", "cli-phone", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(json(r).items.length > 0);
  const f = await fleet(["flaky", "--json"]);
  assert.equal(f.code, 0, f.stderr);
  assert.ok(Array.isArray(json(f).items));
});

test("an unreachable collector exits 5 with a readable error", async () => {
  const r = await fleet(["devices", "--json"], { env: { FLEET_URL: "http://127.0.0.1:9" } });
  assert.equal(r.code, 5);
  assert.equal(json(r).error.code, "unreachable");
});

test("token create writes a hashed record; login saves it 0600; whoami reads it", async () => {
  const tokens = path.join(tempDir("fleet-cli-tokens-"), "tokens.json");
  const created = await fleet(["token", "create", "ci-bot", "--scope", "run", "--tokens-file", tokens, "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const { token } = json(created);
  assert.match(token, /^fr_/);
  const onDisk = readFileSync(tokens, "utf8");
  assert.ok(!onDisk.includes(token), "the file keeps a hash, never the token");

  const login = await fleet(["login", "--url", c.base], { stdin: `${token}\n` });
  assert.equal(login.code, 0, login.stderr);
  const creds = path.join(home, "credentials.json");
  assert.ok(existsSync(creds));
  if (process.platform !== "win32") assert.equal(statSync(creds).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(creds, "utf8")).collectors[c.base].token, token);

  const me = await fleet(["whoami", "--json"]);
  assert.equal(me.code, 0, me.stderr);
  assert.equal(json(me).auth, "off");

  assert.equal((await fleet(["logout", "--url", c.base])).code, 0);
  assert.ok(!JSON.parse(readFileSync(creds, "utf8")).collectors[c.base]);
});

test("skill show prints the skill; install writes it and will not clobber a stranger's file", async () => {
  const shown = await fleet(["skill", "show"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^---\nname: fleet-runner/);

  const dir = tempDir("fleet-cli-skills-");
  const installed = await fleet(["skill", "install", "--target", dir]);
  assert.equal(installed.code, 0, installed.stderr);
  const file = path.join(dir, "fleet-runner", "SKILL.md");
  assert.equal(readFileSync(file, "utf8").trim(), shown.stdout.trim());
  assert.match((await fleet(["skill", "install", "--target", dir])).stdout, /up to date/);

  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const detected = await fleet(["skill", "install"]);
  assert.equal(detected.code, 0, detected.stderr);
  assert.ok(existsSync(path.join(home, ".cursor/skills/fleet-runner/SKILL.md")), "with no --target it installs for each agent found");
  assert.ok(!existsSync(path.join(home, ".claude")), "and only for agents that are there");

  writeFileSync(file, "my own notes\n");
  const refused = await fleet(["skill", "install", "--target", dir]);
  assert.match(refused.stderr, /not overwriting/);
  assert.equal(readFileSync(file, "utf8"), "my own notes\n");
});

test("findings, finding --flow and verdict: the morning brief and a finding becoming a test", async () => {
  const { id, flow } = await postFinding(c.base, "cliapp");
  const brief = await fleet(["findings", "--since", "24h", "--app", "cliapp", "--json"]);
  assert.equal(brief.code, 0, brief.stderr);
  const page = json(brief);
  assert.deepEqual(Object.keys(page).sort(), ["facets", "items", "page", "pages", "per_page", "total"]);
  assert.ok(page.facets.apps.includes("cliapp"));
  assert.equal(page.items[0].id, id);
  assert.equal(page.items[0].verdict, null);

  const human = await fleet(["findings", "--app", "cliapp"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Crashes on Save/);

  const file = path.join(tempDir("fleet-flow-"), "repro.yaml");
  const wrote = await fleet(["finding", String(id), "--flow", file]);
  assert.equal(wrote.code, 0, wrote.stderr);
  assert.equal(readFileSync(file, "utf8"), flow);
  const shown = await fleet(["finding", `#${id}`]);
  assert.match(shown.stdout, /1\. Open the app/);

  const early = await fleet(["verdict", String(id), "fixed"]);
  assert.equal(early.code, 5, "fixed before real is refused");
  assert.match(early.stderr, /conflict/);
  assert.equal((await fleet(["verdict", String(id), "maybe"])).code, 2);
  const real = await fleet(["verdict", String(id), "real", "--note", "seen it"]);
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /candidate/);
  const fixed = await fleet(["verdict", String(id), "fixed", "--json"]);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(json(fixed).finding.regression.state, "active");
  const notABug = await fleet(["verdict", String(id), "not-a-bug"]);
  assert.match(notABug.stdout, /retired/);
});

test("device reserve keeps a phone for one job; devices shows it; unreserve gives it back", async () => {
  const early = await fleet(["device", "reserve", "cli-not-cabled-yet", "growth-ig"]);
  assert.equal(early.code, 0, early.stderr);
  assert.match(early.stderr, /has not registered/);

  const r = await fleet(["device", "reserve", "cli-phone", "growth-ig", "--note", "signed in to the pilot account"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /cli-phone reserved for growth-ig/);

  const list = await fleet(["devices"]);
  assert.match(list.stdout, /RESERVED/);
  assert.match(list.stdout.split("\n").find((l) => l.startsWith("cli-phone")) ?? "", /growth-ig/);
  const listed = json(await fleet(["devices", "--json"])).items.find((d: { device_id: string }) => d.device_id === "cli-phone");
  assert.equal(listed.reserved_for, "growth-ig");

  const clash = await fleet(["device", "reserve", "cli-phone", "someone-else"]);
  assert.equal(clash.code, 5);
  assert.match(clash.stderr, /conflict/);

  // Pinned without the label: the validation step refuses it before anything
  // is queued (exit 2, like any spec the collector would not take), and
  // queueing it anyway is refused with the code.
  const refused = await fleet(["run", "benchmark", "--device", "cli-phone", "--timeout", "30"]);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /reserved for 'growth-ig'/);
  const forced = await fleet(["run", "benchmark", "--device", "cli-phone", "--no-validate", "--no-wait"]);
  assert.equal(forced.code, 5, forced.stderr);
  assert.match(forced.stderr, /device_reserved/);

  // With it: runs on the phone.
  const held = await fleet(["run", "benchmark", "--device", "cli-phone", "--reservation", "growth-ig", "--timeout", "30", "--json"]);
  assert.equal(held.code, 0, held.stderr);
  assert.equal(json(held).verdict, "passed");

  const un = await fleet(["device", "unreserve", "cli-phone"]);
  assert.equal(un.code, 0, un.stderr);
  assert.match(un.stdout, /no longer reserved \(was growth-ig\)/);
  await fleet(["device", "unreserve", "cli-not-cabled-yet"]);

  const usage = await fleet(["device", "reserve", "cli-phone"]);
  assert.equal(usage.code, 2);
});
