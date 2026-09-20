/**
 * The config file, and the precedence it is subject to.
 *
 * The precedence is the part with teeth. `fleet` introduces a config file to a
 * project that has fifteen environment variables and a deployment made of
 * launchd plists that set them -- so the single most likely bug is a file that
 * silently overrides a plist somebody wrote deliberately, or a file that
 * silently does nothing because a plist is winning and nothing says so.
 *
 * Every case below is one of those two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentCollectors, childEnv, defaults, getPath, load, save, setPath } from "../src/config.js";
import { paths } from "../src/paths.js";

function inHome<T>(fn: (env: NodeJS.ProcessEnv, home: string) => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "fleet-config-test-"));
  try {
    return fn({ FLEET_HOME: home }, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("FLEET_HOME decides where everything lives", () => {
  inHome((env, home) => {
    const p = paths(env);
    assert.equal(p.home, home);
    assert.equal(p.config, path.join(home, "config.json"));
    assert.equal(p.data, path.join(home, "data"));
  });
});

test("a missing config file is the defaults, not an error", () => {
  inHome((env) => {
    const c = load(env);
    assert.deepEqual(c.roles, ["brain", "agent"]);
    assert.equal(c.collector.port, 8788);
  });
});

test("a malformed config file warns and still starts", () => {
  inHome((env, home) => {
    writeFileSync(path.join(home, "config.json"), "{ not json,,,");
    const warnings: string[] = [];
    const c = load(env, (m) => warnings.push(m));
    // The fleet's devices long-poll this machine. A brain that refuses to come
    // up because somebody left a trailing comma in a hand-edited file strands
    // every one of them, and the file is hand-editable on purpose.
    assert.equal(c.collector.port, 8788, "defaults are used");
    assert.equal(warnings.length, 1, "and the operator is told, rather than left guessing");
    assert.match(warnings[0], /config\.json/);
  });
});

test("an unknown role in the file is dropped rather than trusted", () => {
  inHome((env, home) => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ roles: ["brain", "toaster"] }));
    assert.deepEqual(load(env).roles, ["brain"]);
  });
});

test("a file with no valid roles at all falls back rather than running nothing", () => {
  inHome((env, home) => {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ roles: ["toaster"] }));
    assert.deepEqual(load(env).roles, ["brain", "agent"]);
  });
});

test("what is saved is what is read back", () => {
  inHome((env) => {
    const c = defaults();
    c.collector.port = 9001;
    c.agent.pools = ["machines", "ci"];
    save(c, env);
    const back = load(env);
    assert.equal(back.collector.port, 9001);
    assert.deepEqual(back.agent.pools, ["machines", "ci"]);
  });
});

// --- precedence ------------------------------------------------------------

test("the environment wins over the file, always", () => {
  inHome((env) => {
    const c = defaults();
    c.collector.port = 9001;
    // A plist or a systemd unit that sets this was written deliberately, and a
    // config file appearing later must not quietly override it.
    const withEnv = childEnv("brain", c, { ...env, FLEET_PORT: "7777" });
    assert.equal(withEnv.FLEET_PORT, "7777");
    const withoutEnv = childEnv("brain", c, env);
    assert.equal(withoutEnv.FLEET_PORT, "9001");
  });
});

test("a brain's child gets the paths under FLEET_HOME", () => {
  inHome((env, home) => {
    const e = childEnv("brain", defaults(), env);
    assert.equal(e.FLEET_DATA_DIR, path.join(home, "data"));
    assert.equal(e.FLEET_ARTIFACT_DIR, path.join(home, "artifacts"));
    assert.equal(e.FLEET_LOG_FILE, path.join(home, "logs/collector.log"));
  });
});

test("an agent with no collectors configured points at this machine's brain", () => {
  inHome((env) => {
    const c = defaults();
    c.collector.port = 9100;
    // The overwhelmingly common case: somebody ran `fleet up` and expects their
    // own laptop on their own dashboard. Writing the loopback URL into the file
    // to express that would be a lie the moment they changed the port.
    assert.deepEqual(agentCollectors(c), ["http://127.0.0.1:9100"]);
    assert.equal(childEnv("agent", c, env).FLEET_URL, "http://127.0.0.1:9100");
  });
});

test("an agent-only machine with no collector has nowhere to point, and says nothing", () => {
  inHome((env) => {
    const c = defaults();
    c.roles = ["agent"];
    assert.deepEqual(agentCollectors(c), []);
    // Not the loopback default: there is no brain here, and pointing an agent
    // at one that does not exist produces a device that never registers and a
    // log full of connection refusals rather than the one line that says why.
    assert.equal(childEnv("agent", c, env).FLEET_URL, undefined);
  });
});

test("discovery is off unless the file turns it on", () => {
  inHome((env) => {
    assert.equal(childEnv("brain", defaults(), env).FLEET_DISCOVERY, "0");
    const c = defaults();
    c.collector.discovery = true;
    assert.equal(childEnv("brain", c, env).FLEET_DISCOVERY, "1");
  });
});

// --- fleet config set ------------------------------------------------------

test("a setting keeps the type it had", () => {
  const c = defaults();
  assert.equal(getPath(setPath(c, "collector.port", "9000"), "collector.port"), 9000);
  assert.equal(getPath(setPath(c, "collector.discovery", "yes"), "collector.discovery"), true);
  assert.equal(getPath(setPath(c, "collector.discovery", "off"), "collector.discovery"), false);
  // A list stays a list. Left as a string, `pools` would become one pool with a
  // comma in its name and every device would quietly leave the pool it was in.
  assert.deepEqual(getPath(setPath(c, "agent.pools", "machines, ci"), "agent.pools"), ["machines", "ci"]);
});

test("a value of the wrong shape is refused rather than coerced", () => {
  const c = defaults();
  assert.throws(() => setPath(c, "collector.port", "eight thousand"), /number/);
  assert.throws(() => setPath(c, "collector.discovery", "maybe"), /true or false/);
});

test("an unknown setting is an error, not a new key", () => {
  const c = defaults();
  // Silently creating it would mean a typo looks like it worked and changes
  // nothing, which is the worst of the three possible behaviours.
  assert.throws(() => setPath(c, "collector.prot", "9000"), /no such setting/);
  assert.throws(() => setPath(c, "nonsense.deeper", "x"), /no such setting/);
});

test("setting one thing does not disturb the rest", () => {
  const c = defaults();
  c.agent.pools = ["a", "b"];
  const next = setPath(c, "collector.port", "9000");
  assert.deepEqual(next.agent.pools, ["a", "b"]);
  assert.equal(c.collector.port, 8788, "and the original is not mutated");
});

// --- env passthrough --------------------------------------------------------
//
// The config file names six of the twenty-odd FLEET_* variables the three
// programs read. The rest are per-deployment facts — where this host's Maestro
// flows live, which Xcode project the generic iOS bundle builds from, where
// alerts go — and before `env` there was nowhere to put them. That was fine
// while every component had a hand-written plist and is not fine now that
// `fleet service install` writes one unit carrying only a PATH: migrating to it
// dropped every one of them silently, and a ui-test whose flows directory
// defaulted to the wrong place fails with "no such flow".

test("config env reaches every component", () => {
  const c = defaults();
  c.env = { FLEET_FLOWS_DIR: "/srv/flows", FLEET_WEB: "1" };
  for (const role of ["brain", "agent", "executor"] as const) {
    const e = childEnv(role, c, {});
    assert.equal(e.FLEET_FLOWS_DIR, "/srv/flows", `${role} lost FLEET_FLOWS_DIR`);
    assert.equal(e.FLEET_WEB, "1", `${role} lost FLEET_WEB`);
  }
});

test("the real environment still beats config env", () => {
  // The precedence the README states is flag > FLEET_* env > config > default,
  // and a deployed plist that sets a variable has to keep deciding.
  const c = defaults();
  c.env = { FLEET_FLOWS_DIR: "/from/config" };
  const e = childEnv("executor", c, { FLEET_FLOWS_DIR: "/from/the/plist" });
  assert.equal(e.FLEET_FLOWS_DIR, "/from/the/plist");
});

test("config env beats a computed default", () => {
  // Pointing a release at a database that predates it is the migration case,
  // and it only works if an explicit value outranks paths().
  inHome((env) => {
    const c = defaults();
    c.env = { FLEET_DATA_DIR: "/an/older/collector/data" };
    assert.equal(childEnv("brain", c, env).FLEET_DATA_DIR, "/an/older/collector/data");
    // Untouched keys still get theirs.
    assert.equal(childEnv("brain", defaults(), env).FLEET_DATA_DIR, paths(env).data);
  });
});

test("env survives a save and load round trip", () => {
  inHome((env) => {
    const c = defaults();
    c.env = { FLEET_IOS_PROJECT: "/Users/someone/app.xcodeproj" };
    save(c, env);
    assert.deepEqual(load(env).env, { FLEET_IOS_PROJECT: "/Users/someone/app.xcodeproj" });
  });
});

test("an unusable env entry is dropped with a warning, not carried", () => {
  inHome((env, home) => {
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ env: { FLEET_OK: "yes", "not a name": "x", FLEET_NUM: 3, FLEET_NULL: null } }),
    );
    const warnings: string[] = [];
    const c = load(env, (m) => warnings.push(m));
    assert.deepEqual(c.env, { FLEET_OK: "yes", FLEET_NUM: "3" }, "a number is usable, a null is not");
    assert.equal(warnings.length, 2, warnings.join(" | "));
    assert.ok(warnings.some((w) => w.includes("not a name")), warnings.join(" | "));
  });
});

test("env is an open map, so setting a key that is not there yet works", () => {
  // Every other setting refuses an unknown key, because there a new key is a
  // typo. Here it is the normal case.
  const next = setPath(defaults(), "env.FLEET_FLOWS_DIR", "/srv/flows");
  assert.deepEqual(next.env, { FLEET_FLOWS_DIR: "/srv/flows" });
  assert.deepEqual(defaults().env, {}, "and the original is not mutated");
});

test("but a name the loader would drop is refused at the point of setting it", () => {
  // Otherwise the file says one thing and the fleet does another.
  assert.throws(() => setPath(defaults(), "env.flows_dir", "/srv/flows"), /usable variable name/);
  assert.throws(() => setPath(defaults(), "env.2FAST", "x"), /usable variable name/);
});

// --- optional settings ------------------------------------------------------
//
// `setPath` refuses a key that is not already in the object, because for a
// fixed schema a new key is a typo. An optional setting is absent for a
// different reason — nobody has set it yet — and refusing those made all five
// of them unsettable, including `fleet config set executor.name`, which the
// README documents and which an executor deployment cannot proceed without.

test("an optional setting can be set before it exists", () => {
  const c = setPath(defaults(), "executor.name", "mac-xcode");
  assert.equal(c.executor.name, "mac-xcode");
  assert.equal(childEnv("executor", c, {}).FLEET_EXECUTOR_NAME, "mac-xcode");
});

test("every optional setting is reachable", () => {
  // Enumerated rather than spot-checked: the bug was that the whole category
  // was unreachable, and a test for one of them would not have caught it.
  const c = defaults();
  assert.equal(setPath(c, "name", "fleet-host").name, "fleet-host");
  assert.equal(setPath(c, "agent.deviceId", "shelf-01").agent.deviceId, "shelf-01");
  assert.equal(setPath(c, "agent.ttlS", "600").agent.ttlS, 600);
  assert.equal(setPath(c, "executor.collector", "http://brain:8788").executor.collector, "http://brain:8788");
  assert.equal(setPath(c, "executor.name", "mac-xcode").executor.name, "mac-xcode");
});

test("an optional setting is coerced to its declared type, not to a string", () => {
  // There is no existing value to read the type from, so a guess would write
  // "600" — which survives a save, a load and a `config get`, and only shows up
  // when something compares it to a number.
  const c = setPath(defaults(), "agent.ttlS", "600");
  assert.equal(typeof c.agent.ttlS, "number");
  assert.throws(() => setPath(defaults(), "agent.ttlS", "ten minutes"), /number/);
});

test("being optional does not make every neighbouring typo settable", () => {
  assert.throws(() => setPath(defaults(), "executor.nmae", "x"), /no such setting/);
  assert.throws(() => setPath(defaults(), "agent.ttl", "600"), /no such setting/);
});

test("an optional setting survives a save and load round trip", () => {
  inHome((env) => {
    save(setPath(defaults(), "executor.name", "mac-xcode"), env);
    assert.equal(load(env).executor.name, "mac-xcode");
  });
});
