/**
 * Where a fleet keeps its things, and how this program finds itself.
 *
 * One directory on every platform, because the alternative is three: macOS
 * wants `~/Library/Application Support`, Linux wants `$XDG_DATA_HOME`, Windows
 * wants `%APPDATA%`, and a project whose whole deployment story is "copy this
 * somewhere and run it" is better served by one path a person can type than by
 * three a person has to look up. `FLEET_HOME` moves it.
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** `~/.fleet`, or wherever `FLEET_HOME` says. */
export function fleetHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLEET_HOME ?? path.join(homedir(), ".fleet");
}

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const home = fleetHome(env);
  return {
    home,
    config: path.join(home, "config.json"),
    data: path.join(home, "data"),
    artifacts: path.join(home, "artifacts"),
    cache: path.join(home, "cache"),
    logs: path.join(home, "logs"),
    /** A private Node, when the install script put one here. */
    runtime: path.join(home, "runtime"),
  };
}

/**
 * How to re-run this program with different arguments.
 *
 * `fleet up` supervises `fleet collector`, `fleet agent` and `fleet executor`
 * as child processes rather than running them in its own -- so that one of them
 * crashing does not take the other two with it, and so a role can be switched
 * off without restarting the rest. That means it has to be able to spawn
 * itself, and how you spawn this program depends on what it currently is.
 *
 * Two answers, and the file extension tells them apart:
 *
 * - **A checkout.** This module is `.ts`, so it needs tsx -- Node's own
 *   type stripping will not do, because the sources import `./db.js` and mean
 *   `./db.ts`, and Node deliberately does not rewrite specifiers.
 * - **A release.** This module is the bundled `.mjs`, which node runs directly.
 *
 * Detected rather than configured, because a flag for it is a flag somebody
 * gets wrong once and then cannot start the fleet.
 */
export function selfCommand(args: string[]): { command: string; args: string[] } {
  const self = fileURLToPath(import.meta.url);
  // In a bundle this module IS the entry file, so re-running the program means
  // re-running this exact path. In a checkout it is a sibling of cli.ts.
  const cli = path.extname(self) === ".ts" ? path.join(path.dirname(self), "cli.ts") : self;
  if (path.extname(self) === ".ts") {
    // node_modules/tsx lives beside the checkout's packages, not beside this
    // file, so it is resolved from the repository root rather than assumed.
    const root = path.resolve(path.dirname(self), "../..");
    for (const candidate of ["fleet", "collector", "runner-machine"]) {
      const tsx = path.join(root, candidate, "node_modules/tsx/dist/cli.mjs");
      if (existsSync(tsx)) return { command: process.execPath, args: [tsx, cli, ...args] };
    }
    throw new Error(
      "running from a checkout but tsx is not installed; run `npm install` in collector/ or fleet/",
    );
  }
  return { command: process.execPath, args: [cli, ...args] };
}

/** True when this is a source checkout rather than a shipped bundle. */
export function isCheckout(): boolean {
  return path.extname(fileURLToPath(import.meta.url)) === ".ts";
}

/**
 * The directory the shipped assets sit in, or null in a checkout.
 *
 * The release keeps the checkout's relative layout on purpose -- `bin/` beside
 * `runner-web/` beside `dash/dist/` -- so that the collector's own
 * `../runner-web/index.html` resolves without the source having to know it is
 * bundled. The dashboard is the one exception, because its default is resolved
 * against the working directory rather than against a module, and a bundle has
 * no working directory it can rely on.
 */
export function assetRoot(): string | null {
  if (isCheckout()) return null;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The repository root, when this is a checkout.
 *
 * Only the checkout path needs it: a bundle carries the collector and the agent
 * inside itself and has nothing to resolve.
 */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}
