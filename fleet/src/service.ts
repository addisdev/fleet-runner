/**
 * `fleet service` -- start at login, and stay up, on three operating systems.
 *
 * This replaces `deploy/install-agent.sh` and the seven plist templates it
 * filled in. Those templates carried `__PLACEHOLDER__` paths and a script
 * substituted them from the machine it ran on, for a reason worth restating
 * because it is the whole design constraint here:
 *
 *   > launchd cannot expand `~`, does not read your login `PATH`, and does not
 *   > complain about a path that does not exist -- an agent with someone else's
 *   > home directory in it fails by quietly doing nothing at all.
 *
 * systemd is the same and Windows is worse. So every path written below is
 * absolute and resolved here, on the machine that will run it, and nothing is
 * installed that still contains a placeholder.
 *
 * ## One unit, not three
 *
 * The old deployment had a plist per component: a collector one, an executor
 * one, an iOS executor one, a tunnel one, an agent one. This installs exactly
 * one, running `fleet up`, and lets the supervisor own the components -- which
 * is the difference between "switch the brain off" being a config edit and
 * being a launchctl invocation somebody has to look up. It also means the
 * crash-loop detection in supervisor.ts actually applies; launchd's `KeepAlive`
 * has no equivalent and will restart a broken collector every ten seconds
 * forever.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { load, type Role } from "./config.js";
import { paths, selfCommand } from "./paths.js";

const exec = promisify(execFile);

const LABEL = "com.addisdev.fleet";
const WINDOWS_TASK = "FleetRunner";

type Flags = Record<string, string | boolean>;

export async function serviceCommand(positional: string[], flags: Flags): Promise<number> {
  const [action] = positional;
  switch (action) {
    case "install":
      return install(flags);
    case "uninstall":
      return uninstall();
    case "start":
      return startStop("start");
    case "stop":
      return startStop("stop");
    case "status":
      return serviceStatus();
    case "logs":
      return logs(positional[1]);
    default:
      console.error("usage: fleet service install|uninstall|start|stop|status|logs");
      return 2;
  }
}

/** The command the service runs: this program, `up`, with the roles pinned. */
function upCommand(roles: string[] | null): { command: string; args: string[] } {
  const self = selfCommand(roles && roles.length ? ["up", "--role", roles.join(",")] : ["up"]);
  return { command: self.command, args: self.args };
}

async function install(flags: Flags): Promise<number> {
  const config = load();
  const roles = typeof flags.role === "string" ? flags.role.split(",").map((s) => s.trim()) : config.roles;
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  const { command, args } = upCommand(roles as Role[]);

  if (process.platform === "darwin") return installLaunchd(command, args, p.logs);
  if (process.platform === "win32") return installWindows(command, args);
  return installSystemd(command, args);
}

// --- macOS -----------------------------------------------------------------

function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
}

async function installLaunchd(command: string, args: string[], logDir: string): Promise<number> {
  const dest = launchdPlistPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const argv = [command, ...args].map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  // PATH is spelled out because launchd gives a process none of your login
  // shell's, and every component shells out to something -- adb, xcodebuild,
  // llama-bench, git. A component that silently declares no capabilities
  // because its PATH was empty is the classic version of this bug.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <!-- Written by \`fleet service install\` on ${new Date().toISOString()}.
       Every path here is absolute because launchd expands nothing and reports
       nothing: a unit pointing at a path that does not exist fails by doing
       nothing at all. Re-run the command to regenerate it. -->
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>

  <!-- The fleet's devices long-poll this machine, so a crash that goes
       unnoticed strands every one of them. \`fleet up\` does its own crash-loop
       detection underneath, so this restarts the supervisor and the supervisor
       decides whether a component is worth restarting again. -->
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(servicePath())}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "fleet.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "fleet.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(dest, plist);
  // A malformed plist loads as nothing and says nothing, so it is checked
  // before it is trusted -- the same reason install-agent.sh ran plutil.
  try {
    await exec("plutil", ["-lint", dest]);
  } catch (e) {
    console.error(`the generated plist is malformed: ${dest}\n${(e as Error).message}`);
    return 1;
  }
  await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`]).catch(() => {});
  try {
    await exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, dest]);
  } catch (e) {
    console.error(`launchctl refused it: ${(e as Error).message}`);
    return 1;
  }
  console.log(`installed and started: ${LABEL}`);
  console.log(`  plist  ${dest}`);
  console.log(`  logs   ${logDir}`);
  console.log("\nThis is a LaunchAgent, so it starts at login rather than at boot. A machine that");
  console.log("reboots unattended needs automatic login, or the same job as a root LaunchDaemon.");
  return 0;
}

// --- Linux -----------------------------------------------------------------

function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config/systemd/user", "fleet.service");
}

async function installSystemd(command: string, args: string[]): Promise<number> {
  const dest = systemdUnitPath();
  mkdirSync(path.dirname(dest), { recursive: true });
  const unit = `[Unit]
Description=Fleet Runner
# Written by \`fleet service install\` on ${new Date().toISOString()}.
Documentation=https://addisdev.github.io/fleet-runner/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[command, ...args].map(shellQuote).join(" ")}
Environment=PATH=${servicePath()}
Restart=always
RestartSec=10
# journald already timestamps and rotates, so the supervisor's own files are the
# per-component detail and this is the summary.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  writeFileSync(dest, unit);
  try {
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", "fleet.service"]);
  } catch (e) {
    console.error(`systemctl refused it: ${(e as Error).message}`);
    return 1;
  }
  console.log("installed and started: fleet.service");
  console.log(`  unit   ${dest}`);
  // Without lingering a user unit stops at logout, which on a headless box is
  // the moment the SSH session that installed it ends.
  try {
    const { stdout } = await exec("loginctl", ["show-user", os.userInfo().username, "-p", "Linger"]);
    if (!stdout.includes("Linger=yes")) {
      console.log(`\nRun this, or it stops when you log out:\n  sudo loginctl enable-linger ${os.userInfo().username}`);
    }
  } catch {
    /* loginctl is not everywhere; the unit is installed either way */
  }
  return 0;
}

// --- Windows ---------------------------------------------------------------

/**
 * A scheduled task at logon, rather than a service.
 *
 * A real Windows service needs a service wrapper and an install that runs as
 * administrator; a logon task needs neither and does the same job for a machine
 * somebody logs into. The trade is that it starts at logon rather than at boot,
 * which is exactly the trade a macOS LaunchAgent already makes -- so the
 * behaviour is at least the same on both.
 */
async function installWindows(command: string, args: string[]): Promise<number> {
  const p = paths();
  // schtasks takes one command string, so the whole thing is quoted here rather
  // than passed as an argv -- and a path with a space in it is the normal case
  // on Windows, not the exception.
  const tr = [command, ...args].map((a) => `\\"${a}\\"`).join(" ");
  try {
    await exec("schtasks", [
      "/Create",
      "/F",
      "/SC", "ONLOGON",
      "/TN", WINDOWS_TASK,
      "/TR", tr,
      "/RL", "LIMITED",
    ]);
    await exec("schtasks", ["/Run", "/TN", WINDOWS_TASK]).catch(() => {});
  } catch (e) {
    console.error(`schtasks refused it: ${(e as Error).message}`);
    return 1;
  }
  console.log(`installed and started: scheduled task ${WINDOWS_TASK}`);
  console.log(`  logs   ${p.logs}`);
  console.log("\nIt runs at logon rather than at boot, which is the same trade a macOS LaunchAgent makes.");
  return 0;
}

// --- the rest --------------------------------------------------------------

async function uninstall(): Promise<number> {
  if (process.platform === "darwin") {
    await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`]).catch(() => {});
    const dest = launchdPlistPath();
    if (existsSync(dest)) unlinkSync(dest);
    console.log(`removed ${LABEL}`);
    return 0;
  }
  if (process.platform === "win32") {
    await exec("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK]).catch(() => {});
    console.log(`removed scheduled task ${WINDOWS_TASK}`);
    return 0;
  }
  await exec("systemctl", ["--user", "disable", "--now", "fleet.service"]).catch(() => {});
  const dest = systemdUnitPath();
  if (existsSync(dest)) unlinkSync(dest);
  await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  console.log("removed fleet.service");
  return 0;
}

async function startStop(which: "start" | "stop"): Promise<number> {
  try {
    if (process.platform === "darwin") {
      const uid = process.getuid?.() ?? 0;
      if (which === "start") await exec("launchctl", ["bootstrap", `gui/${uid}`, launchdPlistPath()]);
      else await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    } else if (process.platform === "win32") {
      await exec("schtasks", [which === "start" ? "/Run" : "/End", "/TN", WINDOWS_TASK]);
    } else {
      await exec("systemctl", ["--user", which, "fleet.service"]);
    }
    console.log(`${which}ed`);
    return 0;
  } catch (e) {
    console.error(`${which} failed: ${(e as Error).message}`);
    console.error("Is it installed? `fleet service install`.");
    return 1;
  }
}

async function serviceStatus(): Promise<number> {
  try {
    if (process.platform === "darwin") {
      const installed = existsSync(launchdPlistPath());
      if (!installed) {
        console.log("not installed. `fleet service install`");
        return 1;
      }
      const { stdout } = await exec("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
      const pid = /\bpid = (\d+)/.exec(stdout)?.[1];
      // Loaded and crash-looping is not the same as running, and the pid is
      // what tells them apart -- the same distinction the self-check workload
      // makes for exactly this reason.
      console.log(pid ? `running, pid ${pid}` : "loaded but not running (it may be crash-looping; see the logs)");
      return pid ? 0 : 1;
    }
    if (process.platform === "win32") {
      const { stdout } = await exec("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/FO", "LIST"]);
      console.log(stdout.trim());
      return /Running/i.test(stdout) ? 0 : 1;
    }
    const { stdout } = await exec("systemctl", ["--user", "is-active", "fleet.service"]);
    console.log(stdout.trim());
    return stdout.trim() === "active" ? 0 : 1;
  } catch {
    console.log("not installed, or not running. `fleet service install`");
    return 1;
  }
}

async function logs(which: string | undefined): Promise<number> {
  const p = paths();
  const name = which ?? "fleet";
  const file = path.join(p.logs, `${name}.log`);
  if (!existsSync(file)) {
    console.error(`no log at ${file}`);
    console.error(`Try one of: ${["fleet", "brain", "agent", "executor"].join(", ")}`);
    return 1;
  }
  // The last 200 lines, which is what somebody wants after "it is not working".
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  process.stdout.write(lines.slice(Math.max(0, lines.length - 200)).join("\n"));
  return 0;
}

/**
 * A PATH for a service, since neither launchd nor systemd gives one.
 *
 * The current process's PATH plus the usual places, because whoever ran
 * `fleet service install` did so from a shell whose PATH found `fleet`, and
 * that is the best available evidence of where this machine keeps things.
 */
function servicePath(): string {
  const extra = [
    path.dirname(process.execPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const seen = new Set<string>();
  const parts = [...(process.env.PATH ?? "").split(path.delimiter), ...extra];
  return parts.filter((x) => x && !seen.has(x) && seen.add(x)).join(path.delimiter);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** systemd's ExecStart is not a shell, but it does split on spaces. */
const shellQuote = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
