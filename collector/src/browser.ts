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
type Playwright = typeof import("playwright");

let cached: Playwright | null = null;

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
  } catch (e) {
    throw new Error(
      "this workload needs Playwright, which is not available on this host " +
        `(${(e as Error).message}). Install it with \`npm install playwright && npx playwright install chromium\` ` +
        "in the collector directory, or run web workloads on a host that has it.",
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
    const browser = await pw.chromium.launch();
    const version = browser.version();
    await browser.close();
    return { ok: true, detail: `chromium ${version}` };
  } catch (e) {
    return {
      ok: false,
      detail: `playwright is installed but no browser launched (${(e as Error).message}); try \`npx playwright install chromium\``,
    };
  }
}
