/**
 * Playwright, asked for rather than assumed.
 *
 * Four host workloads drive a real browser: `web-test`, `web-shots`,
 * `web-audit` and `web-unfurl`. They were reached through a top-level
 * `import { chromium } from "playwright"`, which means the executor could not
 * *start* without the package -- and a browser is 400 MB that a brain running
 * on a Raspberry Pi, in a container, or from a shipped binary has no reason to
 * carry.
 *
 * A top-level import also fails in the least useful way. The module throws
 * while the executor is still loading, so what the operator sees is a stack
 * trace about a missing package rather than "this executor cannot run web
 * workloads", and every other workload on that host stops working too.
 *
 * So the import is deferred and the failure is a sentence. This is the same
 * rule the machine agent applies to `llama-bench` and the same one
 * `docs/writing-a-runner.md` states: declare what you can honour, and when you
 * cannot measure the thing asked for, fail with a message naming what is
 * missing.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Playwright = typeof import("playwright");

let cached: Playwright | null = null;

/**
 * The directory that owns this host's Playwright: its package, its
 * `playwright.config.ts`, and the specs that config points at.
 *
 * Web workloads assumed the executor was started inside a collector checkout.
 * `npx playwright test` ran with no `cwd`, so it found the config and the
 * `@playwright/test` binary by inheriting the executor's working directory,
 * and `import("playwright")` resolved against the executor's own module.
 * Both are true in a checkout and both are false under the released bundle:
 * the executor is `~/.fleet/bin/fleet.mjs`, started by launchd from `/`, with
 * no Playwright anywhere near it. The web path had simply never been run from
 * a release.
 *
 * `FLEET_PLAYWRIGHT_DIR` names that directory once, and every web path uses
 * it. Unset, it is the working directory, so a checkout behaves exactly as it
 * always has.
 */
export function playwrightDir(): string {
  return process.env.FLEET_PLAYWRIGHT_DIR?.trim() || process.cwd();
}

/**
 * How to launch the Chromium engine on this host.
 *
 * `FLEET_CHROMIUM_CHANNEL=chrome` drives the Google Chrome already installed
 * rather than a browser Playwright downloaded. It exists because of a machine
 * that cannot have the downloaded one: Playwright 1.62 refuses outright to
 * install Chromium or Firefox on macOS 12 (`does not support chromium on
 * mac12`), and a Mac on 12 is a real fleet brain. An installed Chrome is kept
 * current by its own updater, runs there fine, and Playwright drives it over
 * the same protocol.
 *
 * Only the Chromium engine has a channel. Firefox and WebKit are Playwright's
 * own builds or nothing, which is why a host that needs this can run the
 * `chromium` and `mobile-chrome` projects and not the other three.
 */
export function chromiumLaunchOptions(): { channel?: string } {
  const channel = process.env.FLEET_CHROMIUM_CHANNEL?.trim();
  return channel ? { channel } : {};
}

/**
 * Import Playwright from the Playwright directory rather than from beside this
 * module.
 *
 * `createRequire(...).resolve` finds the package by Node's own rules, then the
 * import goes through a file URL -- an absolute path handed to `import()` is
 * `Received protocol 'd:'` on Windows. Playwright ships CommonJS, so what comes
 * back may be the exports object itself or a namespace wrapping it; both are
 * accepted rather than guessing which this Node version produces.
 */
export async function importFrom(dir: string): Promise<Playwright> {
  const require = createRequire(path.join(dir, "package.json"));
  const mod = (await import(pathToFileURL(require.resolve("playwright")).href)) as
    Playwright & { default?: Playwright };
  return mod.chromium ? mod : (mod.default as Playwright);
}

/**
 * The Playwright module, or a thrown error a person can act on.
 *
 * Cached after the first success only. A failure is not cached, because the
 * fix for it -- installing the package, running `playwright install` -- is
 * something somebody may well do while the executor is still running, and a
 * cached "no" would keep failing afterwards for no reason.
 */
export async function playwright(): Promise<Playwright> {
  if (cached) return cached;
  try {
    cached = await import("playwright");
    return cached;
  } catch (beside) {
    // Not beside this module, which under a release is the normal case. Try
    // the directory this host said owns its Playwright.
    const dir = process.env.FLEET_PLAYWRIGHT_DIR?.trim();
    if (dir) {
      try {
        cached = await importFrom(dir);
        return cached;
      } catch (there) {
        throw new Error(
          `this workload needs Playwright, and FLEET_PLAYWRIGHT_DIR=${dir} does not have it ` +
            `(${(there as Error).message}). Run \`npm install playwright\` there.`,
        );
      }
    }
    throw new Error(
      "this workload needs Playwright, which is not available on this host " +
        `(${(beside as Error).message}). Install it with \`npm install playwright && npx playwright install chromium\` ` +
        "in a collector checkout and point FLEET_PLAYWRIGHT_DIR at it, or run web workloads on a host that has it.",
    );
  }
}

/**
 * Whether a browser is usable here, without throwing.
 *
 * `fleet doctor` prints this, and it is deliberately a launch rather than a
 * resolve: the package being installed and a browser binary being downloaded
 * are two different facts, and the second is the one that actually fails --
 * `npm install playwright` on a fresh machine leaves you with the library and
 * no Chromium, which resolves perfectly and cannot open a page.
 */
export async function browserAvailable(): Promise<{ ok: boolean; detail: string }> {
  let pw: Playwright;
  try {
    pw = await playwright();
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  try {
    const opts = chromiumLaunchOptions();
    const browser = await pw.chromium.launch(opts);
    const version = browser.version();
    await browser.close();
    return { ok: true, detail: `chromium ${version}${opts.channel ? ` (installed ${opts.channel})` : ""}` };
  } catch (e) {
    return {
      ok: false,
      detail: `playwright is installed but no browser launched (${(e as Error).message}); try \`npx playwright install chromium\``,
    };
  }
}
