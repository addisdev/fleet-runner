/**
 * `fleet` -- one command that starts a brain, a runner, or both.
 *
 * Before this, standing up a fleet meant: clone the repository, `npm install`
 * in two directories, build the dashboard, run a shell script that filled a
 * launchd plist in from a template, and know that the plist invokes
 * `node_modules/tsx/dist/cli.mjs` directly because launchd does not read a
 * login PATH. That is a fine way to run software you wrote. It is not a way to
 * hand it to somebody.
 *
 * The design rule for everything below: **it wraps the three programs, it does
 * not reimplement them.** Each component still reads its own `FLEET_*`
 * variables, still has its own entry point, still runs perfectly well started
 * by hand. This puts a face on them and keeps them alive.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  agentCollectors, childEnv, ensureDirs, getPath, load, save, setPath,
  type FleetConfig, type Role, ROLES,
} from "./config.js";
import { paths, selfCommand, isCheckout, repoRoot } from "./paths.js";
import { supervise, type ChildSpec } from "./supervisor.js";
import { runDoctor } from "./doctor.js";
import { serviceCommand } from "./service.js";
import { VERSION } from "./version.js";

const USAGE = `fleet ${VERSION} -- a device lab you can send work to

  fleet up [--role brain,agent,executor] [--join <url>] [--port N]
                          Run this machine's components, supervised.
  fleet collector         Just the brain.
  fleet agent             Just the runner.
  fleet executor          Just the host executor.
  fleet join <url>        Run a runner pointed at a brain elsewhere.
  fleet join --discover   Find one on this network instead of typing its URL.

  fleet status            What this fleet looks like right now.
  fleet doctor            What this machine can and cannot run, and why.
  fleet dash              Open the dashboard.

  fleet service install [--role ...]   Start at login, and stay up.
  fleet service uninstall|start|stop|status|logs

  fleet config            Print the config file.
  fleet config get <path>
  fleet config set <path> <value>

  fleet version

Every FLEET_* environment variable still works and still wins over the config
file. See ${paths().config}.
`;

type Flags = Record<string, string | boolean>;

/** A tiny flag parser: `--key value`, `--key=value`, `--flag`. */
function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[body] = argv[++i];
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

function rolesFrom(flags: Flags, config: FleetConfig): Role[] {
  const raw = flags.role ?? flags.roles;
  if (typeof raw !== "string") return config.roles;
  const asked = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = asked.filter((r) => !ROLES.includes(r as Role));
  if (bad.length) throw new Error(`unknown role(s): ${bad.join(", ")}. Roles are ${ROLES.join(", ")}.`);
  return asked as Role[];
}

/** What each role's child process is, in checkout and in bundled form. */
function childFor(role: Role, config: FleetConfig): ChildSpec {
  const env = childEnv(role, config);
  if (isCheckout()) {
    // A checkout runs each component from its own directory, so that its own
    // node_modules resolve and its relative defaults (examples/web-specs, the
    // flows directory) point where they always have.
    const root = repoRoot();
    const tsx = path.join(root, "collector/node_modules/tsx/dist/cli.mjs");
    const where = {
      brain: { cwd: path.join(root, "collector"), entry: "src/server.ts" },
      agent: { cwd: path.join(root, "runner-machine"), entry: "src/agent.ts" },
      executor: { cwd: path.join(root, "collector"), entry: "src/executor.ts" },
    }[role];
    return { name: role, command: process.execPath, args: [tsx, where.entry], env, cwd: where.cwd };
  }
  const self = selfCommand([{ brain: "collector", agent: "agent", executor: "executor" }[role]]);
  return { name: role, command: self.command, args: self.args, env };
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const { positional, flags } = parse(rest);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;

    case "up":
      return up(flags);

    case "collector":
    case "agent":
    case "executor":
      return single(command);

    case "join":
      return join(positional[0], flags);

    case "status":
      return status();

    case "doctor":
      return runDoctor();

    case "dash":
      return dash();

    case "service":
      return serviceCommand(positional, flags);

    case "config":
      return configCommand(positional);

    default:
      console.error(`unknown command: ${command}\n`);
      process.stdout.write(USAGE);
      return 2;
  }
}

// --- fleet up --------------------------------------------------------------

async function up(flags: Flags): Promise<number> {
  const config = load(process.env, (m) => console.warn(`warning: ${m}`));
  const roles = rolesFrom(flags, config);

  // Flags override the file for this run without writing to it: `--port 9000`
  // is a thing you try, and a thing you try should not silently become a thing
  // you configured.
  if (typeof flags.port === "string") config.collector.port = Number(flags.port);
  if (typeof flags.join === "string") {
    // The desktop case the whole feature exists for: this machine is a brain
    // AND its agent registers with a brain elsewhere. Both, not either.
    config.agent.collectors = [...new Set([...agentCollectors(config), flags.join])];
    if (!config.peers.includes(flags.join)) config.peers.push(flags.join);
  }

  ensureDirs();
  const p = paths();
  if (roles.length === 0) {
    console.error("no roles to run. Try `fleet up --role brain,agent`.");
    return 2;
  }

  console.log(`fleet ${VERSION}`);
  console.log(`  home     ${p.home}`);
  console.log(`  roles    ${roles.join(", ")}`);
  if (roles.includes("brain")) {
    console.log(`  brain    http://127.0.0.1:${config.collector.port}  (bind ${config.collector.bind.join(", ")})`);
  }
  const collectors = agentCollectors(config);
  if (roles.includes("agent")) console.log(`  agent    -> ${collectors.join(", ") || "(no collector configured)"}`);
  console.log();

  const supervisor = supervise(
    roles.map((r) => childFor(r, config)),
    p.logs,
    (e) => {
      const when = new Date().toISOString().slice(11, 19);
      if (e.kind === "gave-up") console.error(`${when}  ${e.child}: GAVE UP -- ${e.detail}`);
      else console.log(`${when}  ${e.child}: ${e.kind} ${e.detail}`);
    },
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nstopping...");
    await supervisor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Resolves only if every child gives up, which is the one case where staying
  // alive would be pretending.
  await supervisor.wait();
  console.error("\nevery component has given up. `fleet doctor` and the logs in " + p.logs + " say why.");
  return 1;
}

// --- one component, in this process ---------------------------------------

/**
 * `fleet collector` and friends: exec the component directly.
 *
 * In a checkout that is a re-exec through tsx, because the sources are
 * TypeScript that Node will not load unaided. In a bundle the component is
 * inside this file already and is imported.
 */
async function single(role: "collector" | "agent" | "executor"): Promise<number> {
  const config = load();
  ensureDirs();
  const roleName: Role = role === "collector" ? "brain" : role;
  Object.assign(process.env, childEnv(roleName, config));

  if (isCheckout()) {
    const spec = childFor(roleName, config);
    const { spawn } = await import("node:child_process");
    const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => child.kill(signal));
    }
    return await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
  }

  // Bundled: the components are in here, so this process IS the component.
  //
  // Each one installs its own SIGTERM handling when it is started as a program,
  // guarded on `import.meta.url === argv[1]` -- which is false here, because
  // argv[1] is the bundle. So the handler is installed explicitly, and it has to
  // be: without it SIGTERM takes the default action and the process dies with
  // sockets open and the database mid-write. That is exactly the ungraceful
  // stop the supervisor exists to avoid, and it would have appeared only in a
  // release.
  let shutdown: () => Promise<void>;
  if (role === "collector") {
    const collector = await import("../../collector/src/server.js");
    await collector.listen();
    shutdown = () => collector.close();
  } else if (role === "agent") {
    const { startAgent } = await import("../../runner-machine/src/agent.js");
    const agent = await startAgent({ collectors: agentCollectors(config) });
    shutdown = async () => agent.stop();
  } else {
    const { startExecutor } = await import("../../collector/src/executor.js");
    const executor = await startExecutor();
    shutdown = async () => executor.stop();
  }

  await new Promise<void>((resolve) => {
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        shutdown()
          .catch(() => {})
          .finally(resolve);
      });
    }
  });
  return 0;
}

// --- fleet join ------------------------------------------------------------

async function join(url: string | undefined, flags: Flags): Promise<number> {
  if (!url && flags.discover) {
    const found = await discover();
    if (found === null) return 1;
    url = found;
  }
  if (!url) {
    console.error("usage: fleet join <collector-url>");
    console.error("   or: fleet join --discover     (look for one on this network)");
    return 2;
  }
  const config = load();
  config.agent.collectors = [url];
  if (!config.roles.includes("agent")) config.roles = [...config.roles, "agent"];
  // Joining a brain elsewhere is a decision, not an experiment, so unlike
  // `up --join` this one is written down.
  if (flags.save !== false) save(config);
  console.log(`joined ${url}; running as an agent. Ctrl-C to stop, or \`fleet service install\` to keep it up.`);
  return up({ role: "agent" });
}

/**
 * Find a brain on this network, or explain why not.
 *
 * Returns the URL, or null when the caller should stop. One result is chosen
 * without asking, because being asked to confirm the only possible answer is
 * not a choice -- and more than one is printed for the person to pick from,
 * since a machine that can see two fleets is a machine whose owner knows which
 * one they meant.
 */
async function discover(): Promise<string | null> {
  const { browse, hasMulticastableInterface } = await discoveryModule();
  process.stdout.write("looking for a brain on this network... ");
  const found = await browse(2_500);
  console.log(found.length === 0 ? "none" : `${found.length}`);

  if (found.length === 0) {
    // These are different problems that look identical from the outside, and
    // the fix for each is nothing like the fix for the other.
    if (!hasMulticastableInterface()) {
      console.error("\nThis machine has no non-loopback network interface, so there is nothing to look on.");
    } else {
      console.error(
        "\nNothing answered. Either no brain is running with discovery on\n" +
          "(`fleet config set collector.discovery true` on the machine that is one),\n" +
          "or this network blocks multicast, which guest wifi and most offices do.\n" +
          "Either way `fleet join <url>` still works and always will.",
      );
    }
    return null;
  }

  if (found.length === 1) {
    const only = found[0];
    console.log(`  ${only.name}  ${only.url}${only.version ? `  (${only.version})` : ""}`);
    return only.url;
  }

  console.log();
  found.forEach((b, i) => console.log(`  ${i + 1}. ${b.name.padEnd(20)} ${b.url}${b.version ? `  ${b.version}` : ""}`));
  console.log("\nMore than one. Pick with: fleet join <url>");
  return null;
}

/** The collector's discovery module: a sibling in a checkout, inlined in a bundle. */
async function discoveryModule(): Promise<typeof import("../../collector/src/discovery.js")> {
  if (isCheckout()) {
    const url = pathToFileURL(path.join(repoRoot(), "collector/src/discovery.ts"));
    return (await import(url.href)) as typeof import("../../collector/src/discovery.js");
  }
  return await import("../../collector/src/discovery.js");
}

// --- fleet status ----------------------------------------------------------

async function status(): Promise<number> {
  const config = load();
  const bases = [...new Set([`http://127.0.0.1:${config.collector.port}`, ...agentCollectors(config), ...config.peers])];
  let any = false;
  for (const base of bases) {
    let health: Record<string, unknown> | null = null;
    try {
      health = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
        r.json(),
      )) as Record<string, unknown>;
    } catch {
      console.log(`${base}\n  not reachable`);
      continue;
    }
    any = true;
    console.log(`${base}`);
    console.log(`  brain    ${String(health.name)} (${String(health.collector)}), up ${health.uptime_s}s`);
    try {
      const overview = (await fetch(`${base}/api/overview`, { signal: AbortSignal.timeout(5_000) }).then((r) =>
        r.json(),
      )) as { devices?: { online?: number; total?: number }; jobs?: Record<string, number> };
      const d = overview.devices ?? {};
      console.log(`  devices  ${d.online ?? 0} online of ${d.total ?? 0}`);
      const jobs = overview.jobs ?? {};
      const parts = Object.entries(jobs)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`);
      console.log(`  jobs     ${parts.length ? parts.join(", ") : "none"}`);
    } catch {
      console.log("  (the read API did not answer; the brain is up but busy or half-started)");
    }
  }
  if (!any) {
    console.log("\nNothing answered. `fleet up` starts this machine's components.");
    return 1;
  }
  return 0;
}

// --- fleet dash ------------------------------------------------------------

async function dash(): Promise<number> {
  const config = load();
  const url = `http://127.0.0.1:${config.collector.port}/dash`;
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const { spawn } = await import("node:child_process");
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    console.log(url);
    return 0;
  } catch {
    console.log(`open this yourself: ${url}`);
    return 0;
  }
}

// --- fleet config ----------------------------------------------------------

async function configCommand(positional: string[]): Promise<number> {
  const [action, dotted, value] = positional;
  const config = load();
  if (!action) {
    console.log(`# ${paths().config}`);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  if (action === "get") {
    if (!dotted) {
      console.error("usage: fleet config get <path>");
      return 2;
    }
    const got = getPath(config, dotted);
    console.log(got === undefined ? "" : typeof got === "object" ? JSON.stringify(got) : String(got));
    return 0;
  }
  if (action === "set") {
    if (!dotted || value === undefined) {
      console.error("usage: fleet config set <path> <value>");
      return 2;
    }
    try {
      const next = setPath(config, dotted, value);
      const file = save(next);
      console.log(`${dotted} = ${JSON.stringify(getPath(next, dotted))}   (${file})`);
      // Said out loud because it is the single most confusing thing about this
      // program: an environment variable set in a service unit beats the file,
      // so an edit that "does nothing" is almost always this.
      const envName = ENV_FOR[dotted];
      if (envName && process.env[envName] !== undefined) {
        console.warn(
          `warning: ${envName} is set in this environment and wins over the file. ` +
            "This setting will not take effect here until it is unset.",
        );
      }
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }
  console.error(`unknown: fleet config ${action}`);
  return 2;
}

/** Only the ones somebody is likely to set both ways. */
const ENV_FOR: Record<string, string> = {
  "collector.port": "FLEET_PORT",
  "collector.bind": "FLEET_BIND",
  "agent.collectors": "FLEET_URL",
  "agent.pools": "FLEET_POOLS",
  "agent.deviceId": "FLEET_DEVICE_ID",
};

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  });
