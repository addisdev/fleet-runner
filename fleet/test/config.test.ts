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
