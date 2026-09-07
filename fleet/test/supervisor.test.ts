/**
 * The supervisor, tested on the behaviour it exists for.
 *
 * Restarting a crashed process is the easy part and launchd already does it.
 * The reason this module exists is the part launchd cannot express: knowing the
 * difference between a component that died and one that was never going to
 * start, and stopping rather than looping forever on the second.
 *
 * So the tests are about the boundaries -- it does restart, it does eventually
 * stop, a long-lived process that dies is not treated as a loop, and a stop
 * actually stops.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { supervise, type ChildSpec, type Timings } from "../src/supervisor.js";

/**
 * The same policy, in milliseconds instead of seconds.
 *
 * The production backoff adds up to about a minute before it gives up, which is
 * right for a component somebody is depending on and impossible to test against.
 * What is under test is the SHAPE -- it retries, it stops, a long-lived process
 * resets the count -- and that is identical at either scale.
 */
const FAST: Timings = { backoffMs: [10, 20, 30], giveUpAfter: 3, healthyAfterMs: 400 };

type Event = { child: string; kind: string; detail: string };

/**
 * A temp directory that outlives the test.
 *
 * `await`ed rather than merely returned: a synchronous `finally` around a
 * returned promise removes the directory the instant the callback yields, so
 * every child here would be writing its log into a directory that no longer
 * exists. Which is what happened.
 */
async function inTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-sup-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A child that does what the test needs, written to disk as a script. */
function scriptChild(dir: string, name: string, body: string): ChildSpec {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return { name, command: process.execPath, args: [file], env: { ...process.env } };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a child that exits immediately is restarted, then given up on", async () => {
  await inTemp(async (dir) => {
    const events: Event[] = [];
    // Exits at once, every time. There is no configuration that makes this
    // work, which is precisely the case launchd would retry until the heat
    // death of the universe.
    const spec = scriptChild(dir, "doomed", 'process.stderr.write("nope\\n"); process.exit(3);');
    const sup = supervise([spec], dir, (e) => events.push(e), FAST);
    await sup.wait();
    await sup.stop();

    const starts = events.filter((e) => e.kind === "start").length;
    const gaveUp = events.filter((e) => e.kind === "gave-up");
    assert.ok(starts >= 2, `it retried (${starts} starts)`);
    assert.equal(gaveUp.length, 1, "and stopped exactly once");
    // The message has to say where to look. A component that is down and
    // reported gets fixed in five minutes; one that is quietly looping gets
    // found in a fortnight.
    assert.match(gaveUp[0].detail, /doomed\.log/);
  });
});

test("what the child printed is in its log, which is what the message points at", async () => {
  await inTemp(async (dir) => {
    const spec = scriptChild(dir, "noisy", 'console.log("the reason it failed"); process.exit(1);');
    const sup = supervise([spec], dir, () => {}, FAST);
    await sup.wait();
    await sup.stop();
    const log = readFileSync(path.join(dir, "noisy.log"), "utf8");
    assert.match(log, /the reason it failed/);
  });
});

test("a child that keeps running is not restarted", async () => {
  await inTemp(async (dir) => {
    const events: Event[] = [];
    const spec = scriptChild(dir, "steady", "setInterval(() => {}, 1000);");
    const sup = supervise([spec], dir, (e) => events.push(e), FAST);
    await settle(800);
    assert.equal(events.filter((e) => e.kind === "start").length, 1);
    assert.equal(events.filter((e) => e.kind === "exit").length, 0);
    await sup.stop();
  });
});

test("stop() ends a healthy child, and the promise waits for it", async () => {
  await inTemp(async (dir) => {
    const events: Event[] = [];
    const spec = scriptChild(dir, "polite", "setInterval(() => {}, 1000);");
    const sup = supervise([spec], dir, (e) => events.push(e), FAST);
    await settle(600);
    await sup.stop();
    // Resolved means gone, not signalled: a `fleet up` that returned while its
    // collector still held the port would make the next `fleet up` fail with
    // EADDRINUSE, intermittently, on somebody else's machine.
    assert.equal(sup.children.get("polite")?.process, null);
    assert.equal(events.filter((e) => e.kind === "gave-up").length, 0, "a deliberate stop is not a failure");
  });
});

test("a child that ignores SIGTERM is still stopped", async () => {
  await inTemp(async (dir) => {
    const spec = scriptChild(
      dir,
      "stubborn",
      'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000);',
    );
    const sup = supervise([spec], dir, () => {}, FAST);
    await settle(600);
    const started = Date.now();
    await sup.stop();
    // The grace period is generous on purpose -- every component handles
    // SIGTERM by finishing the job it is running -- so this asserts only that
    // the hard stop exists, not how long it waited.
    assert.equal(sup.children.get("stubborn")?.process, null);
    assert.ok(Date.now() - started < 20_000);
  });
});

test("each child gets its own log file", async () => {
  await inTemp(async (dir) => {
    const specs = [
      scriptChild(dir, "one", 'console.log("from one"); setInterval(() => {}, 1000);'),
      scriptChild(dir, "two", 'console.log("from two"); setInterval(() => {}, 1000);'),
    ];
    const sup = supervise(specs, dir, () => {}, FAST);
    await settle(800);
    await sup.stop();
    const logs = readdirSync(dir).filter((f) => f.endsWith(".log"));
    assert.deepEqual(logs.sort(), ["one.log", "two.log"]);
    assert.match(readFileSync(path.join(dir, "one.log"), "utf8"), /from one/);
    assert.match(readFileSync(path.join(dir, "two.log"), "utf8"), /from two/);
  });
});

test("one child giving up does not stop the others", async () => {
  await inTemp(async (dir) => {
    const events: Event[] = [];
    const specs = [
      scriptChild(dir, "doomed", "process.exit(1);"),
      scriptChild(dir, "fine", "setInterval(() => {}, 1000);"),
    ];
    const sup = supervise(specs, dir, (e) => events.push(e), FAST);
    // Long enough for the doomed one to exhaust its backoff.
    await settle(1_500);
    assert.ok(events.some((e) => e.child === "doomed" && e.kind === "gave-up"));
    assert.ok(sup.children.get("fine")?.process !== null, "the healthy child is untouched");
    // And `wait()` has NOT resolved, because a fleet with a working brain and a
    // broken executor is still a fleet.
    let resolved = false;
    void sup.wait().then(() => {
      resolved = true;
    });
    await settle(100);
    assert.equal(resolved, false);
    await sup.stop();
  });
});

test("a child that ran for a while and then died is not treated as a loop", async () => {
  await inTemp(async (dir) => {
    const events: Event[] = [];
    // Up for longer than healthyAfterMs, then gone. This is a component that
    // hit something, not one that cannot start -- and the difference matters,
    // because a machine that has been up for a month should not give up on its
    // fifth ever restart.
    const spec = scriptChild(dir, "flaky", "setTimeout(() => process.exit(1), 600);");
    const sup = supervise([spec], dir, (e) => events.push(e), FAST);
    await settle(2_500);
    await sup.stop();
    assert.equal(
      events.filter((e) => e.kind === "gave-up").length,
      0,
      "each run outlived healthyAfterMs, so the restart count reset every time",
    );
    assert.ok(events.filter((e) => e.kind === "start").length >= 3, "and it kept being restarted");
  });
});
