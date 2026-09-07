/**
 * `~/.fleet/config.json`: what this machine runs, and where it points.
 *
 * ## Why a file at all
 *
 * Everything here was already configurable, through fifteen `FLEET_*`
 * environment variables set in a launchd plist or a systemd unit that a shell
 * script filled in from a template. That works and it is what ships today. What
 * it cannot do is be *read*: a desktop app with a switch labelled "this Mac is
 * a brain" has to know whether it currently is one, and there is nowhere to look
 * but somebody's plist.
 *
 * So the file is the readable, writable copy, and the environment still wins
 * over it. Nothing deployed today changes behaviour: a plist that sets
 * `FLEET_URL` keeps deciding, and `fleet` only fills in what nobody has said.
 * The precedence is stated once, here, and is the same for every value:
 *
 *   command-line flag  >  FLEET_* environment  >  config.json  >  default
 *
 * ## Why roles are a list
 *
 * Because the first ask this whole thing exists for is a desktop machine that
 * is a collector and a runner at once. A boolean "is server" would have made
 * that a special case; a list makes it the ordinary one, and makes "a laptop
 * that is only an agent" and "a Mac mini that is only an executor" the same
 * shape rather than three code paths.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assetRoot, paths } from "./paths.js";

export type Role = "brain" | "agent" | "executor";
export const ROLES: Role[] = ["brain", "agent", "executor"];

export type FleetConfig = {
  /** This machine's display name; also the brain's name when it is one. */
  name?: string;
  roles: Role[];
  collector: {
    port: number;
    bind: string[];
    /** Advertise over mDNS so agents can find this brain without a URL. */
    discovery: boolean;
    tailnetAllowlist: string[];
  };
  agent: {
    /**
     * Which brains to register with. A list, because a device can belong to
     * more than one fleet -- see the claim gate in the machine agent.
     */
    collectors: string[];
    deviceId?: string;
    pools: string[];
    /** Seconds. Set only for agents whose disappearance is normal. */
    ttlS?: number;
  };
  executor: {
    collector?: string;
    name?: string;
  };
  /** Other brains this one knows about, for the dashboard's all-fleets view. */
  peers: string[];
};

export function defaults(): FleetConfig {
  return {
    roles: ["brain", "agent"],
    collector: { port: 8788, bind: ["0.0.0.0"], discovery: false, tailnetAllowlist: [] },
    agent: { collectors: [], pools: ["machines"] },
    executor: {},
    peers: [],
  };
}

/**
 * Read the config, filling in anything absent.
 *
 * A malformed file is a warning and the defaults, never a refusal to start. The
 * fleet's own devices long-poll a collector; a brain that will not come up
 * because somebody put a trailing comma in a JSON file strands every one of
 * them, and the file is hand-editable precisely so that people will hand-edit
 * it.
 */
export function load(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): FleetConfig {
  const file = paths(env).config;
  let onDisk: Partial<FleetConfig> = {};
  try {
    onDisk = JSON.parse(readFileSync(file, "utf8")) as Partial<FleetConfig>;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT") warn(`${file} could not be read (${(e as Error).message}); using defaults`);
  }
  const d = defaults();
  const roles = Array.isArray(onDisk.roles) ? onDisk.roles.filter((r): r is Role => ROLES.includes(r)) : d.roles;
  return {
    name: onDisk.name,
    roles: roles.length > 0 ? roles : d.roles,
    collector: { ...d.collector, ...(onDisk.collector ?? {}) },
    agent: { ...d.agent, ...(onDisk.agent ?? {}) },
    executor: { ...d.executor, ...(onDisk.executor ?? {}) },
    peers: Array.isArray(onDisk.peers) ? onDisk.peers : d.peers,
  };
}

/** Write it back, atomically, creating `~/.fleet` if this is the first time. */
export function save(config: FleetConfig, env: NodeJS.ProcessEnv = process.env): string {
  const p = paths(env);
  mkdirSync(p.home, { recursive: true });
  const tmp = `${p.config}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, p.config);
  return p.config;
}

/** Every directory a running fleet writes to. */
export function ensureDirs(env: NodeJS.ProcessEnv = process.env): void {
  const p = paths(env);
  for (const dir of [p.home, p.data, p.artifacts, p.cache, p.logs]) mkdirSync(dir, { recursive: true });
}

/**
 * The environment a child component gets.
 *
 * This is the whole bridge between the config file and the three programs:
 * they read `FLEET_*` exactly as they always have, and this is what sets them.
 * Anything already in the parent's environment is left alone, which is what
 * makes the precedence above true rather than merely documented -- a plist that
 * sets `FLEET_URL` still wins, because its value arrives here as inherited
 * environment and nothing below overwrites it.
 */
export function childEnv(
  role: Role,
  config: FleetConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const p = paths(env);
  const out: NodeJS.ProcessEnv = { ...env };
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined && out[key] === undefined) out[key] = value;
  };

  set("FLEET_CACHE_DIR", p.cache);

  if (role === "brain") {
    set("FLEET_PORT", String(config.collector.port));
    set("FLEET_BIND", config.collector.bind.join(","));
    set("FLEET_DATA_DIR", p.data);
    set("FLEET_ARTIFACT_DIR", p.artifacts);
    set("FLEET_LOG_FILE", path.join(p.logs, "collector.log"));
    // The dashboard's own default is `path.resolve("dash/dist")`, which is
    // relative to a working directory. A checkout has the right one; a release
    // has whichever directory the user happened to be in, so `fleet` -- which
    // knows where it put things -- says so explicitly.
    const assets = assetRoot();
    if (assets) set("FLEET_DASH_DIST", path.join(assets, "dash/dist"));
    set("FLEET_DISCOVERY", config.collector.discovery ? "1" : "0");
    if (config.collector.tailnetAllowlist.length > 0) {
      set("FLEET_TAILNET_ALLOWLIST", config.collector.tailnetAllowlist.join(","));
    }
    if (config.name) set("FLEET_NAME", config.name);
    if (config.peers.length > 0) set("FLEET_PEERS", config.peers.join(","));
  }

  if (role === "agent") {
    set("FLEET_URL", agentCollectors(config)[0]);
    set("FLEET_POOLS", config.agent.pools.join(","));
    if (config.agent.deviceId) set("FLEET_DEVICE_ID", config.agent.deviceId);
    if (config.agent.ttlS !== undefined) set("FLEET_DEVICE_TTL_S", String(config.agent.ttlS));
  }

  if (role === "executor") {
    set("FLEET_URL", config.executor.collector ?? agentCollectors(config)[0]);
    if (config.executor.name) set("FLEET_EXECUTOR_NAME", config.executor.name);
  }

  return out;
}

/**
 * Which brains the agent should register with.
 *
 * Empty means "the one on this machine", which is the answer for the
 * overwhelmingly common case: somebody ran `fleet up` and expects their laptop
 * to appear on its own dashboard. Writing `http://127.0.0.1:8788` into the file
 * to say that would be a lie the moment they changed the port.
 */
export function agentCollectors(config: FleetConfig): string[] {
  if (config.agent.collectors.length > 0) return config.agent.collectors;
  if (config.roles.includes("brain")) return [`http://127.0.0.1:${config.collector.port}`];
  return [];
}

/** `fleet config set collector.port 9000` -- a dotted path into the object. */
export function setPath(config: FleetConfig, dotted: string, raw: string): FleetConfig {
  const next = JSON.parse(JSON.stringify(config)) as FleetConfig;
  const parts = dotted.split(".");
  let node = next as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const child = node[part];
    if (typeof child !== "object" || child === null) throw new Error(`no such setting: ${dotted}`);
    node = child as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in node)) throw new Error(`no such setting: ${dotted}`);
  node[leaf] = coerce(node[leaf], raw, dotted);
  return next;
}

/**
 * Parse a value the way the existing one looks.
 *
 * A setting that is a list stays a list, a number stays a number. Guessing from
 * the string alone would turn `pools` into the string "machines,ci" and leave a
 * fleet whose devices are all in a pool with a comma in its name.
 */
function coerce(existing: unknown, raw: string, dotted: string): unknown {
  if (Array.isArray(existing)) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (typeof existing === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${dotted} is a number, and ${JSON.stringify(raw)} is not one`);
    return n;
  }
  if (typeof existing === "boolean") {
    if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(raw.toLowerCase())) return false;
    throw new Error(`${dotted} is true or false, and ${JSON.stringify(raw)} is neither`);
  }
  return raw;
}

/** `fleet config get collector.port`. Undefined values read as empty. */
export function getPath(config: FleetConfig, dotted: string): unknown {
  let node: unknown = config;
  for (const part of dotted.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
