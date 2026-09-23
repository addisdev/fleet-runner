/**
 * Where a host's Playwright lives, and which Chromium it drives.
 *
 * Both came out of moving the web workloads onto a fleet brain that runs the
 * released bundle on macOS 12. The web path had never run from a release: it
 * found Playwright by being started inside a collector checkout, and under
 * launchd the executor is `~/.fleet/bin/fleet.mjs` started from `/`. And
 * Playwright 1.62 refuses to install Chromium or Firefox on macOS 12 at all,
 * so on that machine the installed Google Chrome is the only Chromium there is.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumLaunchOptions, importFrom, playwrightDir } from "./browser.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

/** Run `fn` with some environment variables set, and restore them after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function runBrowserChecks(check: Check) {
  // --- where Playwright lives ---------------------------------------------
  await withEnv({ FLEET_PLAYWRIGHT_DIR: undefined }, () => {
    check("unset, the Playwright directory is the working directory", playwrightDir() === process.cwd(),
      "a checkout must behave exactly as it always has");
  });
  await withEnv({ FLEET_PLAYWRIGHT_DIR: "  /srv/fleet-collector  " }, () => {
    check("set, it is used, trimmed", playwrightDir() === "/srv/fleet-collector", playwrightDir());
  });
  await withEnv({ FLEET_PLAYWRIGHT_DIR: "   " }, () => {
    check("a blank value is treated as unset", playwrightDir() === process.cwd());
  });

  // --- which Chromium -----------------------------------------------------
  await withEnv({ FLEET_CHROMIUM_CHANNEL: undefined }, () => {
    const o = chromiumLaunchOptions();
    check("no channel by default, so Playwright's own build is used", !("channel" in o), JSON.stringify(o));
  });
  await withEnv({ FLEET_CHROMIUM_CHANNEL: " chrome " }, () => {
    const o = chromiumLaunchOptions();
    check("a channel names the installed browser", o.channel === "chrome", JSON.stringify(o));
  });

  // --- importing Playwright from a directory, not from beside this module --
  // This is the path a released executor takes. Playwright ships CommonJS, so
  // `import()` of it can hand back the exports object or a namespace wrapping
  // it depending on the Node version; what matters is that `.chromium` is
  // there either way.
  const collectorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const pw = await importFrom(collectorDir);
    check("Playwright imports from a named directory", typeof pw?.chromium?.launch === "function",
      `got keys ${Object.keys(pw ?? {}).slice(0, 8).join(", ")}`);
    check("and exposes the device profiles the projects use", !!pw.devices?.["Pixel 7"]);
  } catch (e) {
    check("Playwright imports from a named directory", false, (e as Error).message);
  }
  try {
    await importFrom(path.join(collectorDir, "definitely-not-a-directory-with-playwright"));
    // A sibling directory walks up and finds the collector's node_modules, so
    // this may legitimately succeed; the case that must fail is somewhere with
    // no node_modules on the way up at all.
  } catch {
    /* either outcome is fine here */
  }
  try {
    await importFrom("/");
    check("a directory with no Playwright above it fails rather than pretending", false,
      "importFrom('/') returned a module");
  } catch (e) {
    check("a directory with no Playwright above it fails rather than pretending", true, (e as Error).message);
  }
}
