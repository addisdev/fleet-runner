// Screenshot capture for the `web-shots` workload.
//
// This spec is a GENERATOR: it defines one test per page listed in the
// manifest named by SHOTS_MANIFEST, writing each screenshot to SHOTS_OUT.
// Running capture as a Playwright test — rather than via the library API —
// is what keeps the profile list honest: `--project=mobile-safari` here means
// exactly what it means for web-test, because both read the same project
// definitions from playwright.config.ts. A hand-rolled launcher would carry
// its own copy of the device presets, and a copy is where the emulated
// viewport and the tested viewport quietly stop being the same thing.
//
// With SHOTS_MANIFEST unset this file defines no tests at all, so a plain
// web-test run over the whole specs dir (`suite.flows: "."`) never captures
// screenshots by accident.
//
// Determinism, because a diff pipeline sits downstream (Phase 3): reduced
// motion is emulated, animations/transitions/caret are killed both by
// Playwright's screenshot option and by injected CSS, fonts are awaited, and
// the manifest may pin Date via freeze_time. Dynamic regions that remain are
// the manifest's job to mask.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";

type ShotPage = {
  name: string;
  path: string;
  waitFor?: string;
  mask?: string[];
  fullPage?: boolean;
  // Extra wait after waitFor, for a page that keeps drawing after its last
  // element appears (a canvas filling in, map tiles arriving).
  settle_ms?: number;
  // With a signin block, every page is captured signed in unless it says
  // false here: the signed-out view of an owner-only page is a shot too.
  signedIn?: boolean;
};
// How to sign in, as selectors. The account and password are never here:
// the job names the account in suite.credentials and the executor reads the
// password from its own Keychain, handing both over as env.
type Signin = { path: string; email: string; password: string; submit: string; waitFor: string };
type Manifest = { pages?: ShotPage[]; freeze_time?: string; signin?: Signin };

const manifestPath = process.env.SHOTS_MANIFEST;
const outDir = process.env.SHOTS_OUT;
const manifest: Manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

/**
 * Sign in through the site's own form, then leave the page.
 *
 * about:blank between the form and the shot, so the page under test is a
 * full load with the session already stored -- the way a signed-in visitor
 * opens a link -- and not whatever the form's success handler left on screen.
 * A path differing only by its #hash would otherwise be a same-document
 * navigation that never runs the page's boot code again.
 */
async function signIn(page: Page, s: Signin) {
  const email = process.env.SHOTS_SIGNIN_EMAIL;
  const password = process.env.SHOTS_SIGNIN_PASSWORD;
  if (!email || !password) {
    throw new Error("shots.json signs in, but SHOTS_SIGNIN_EMAIL/SHOTS_SIGNIN_PASSWORD are unset (the job named no suite.credentials)");
  }
  await page.goto(s.path, { waitUntil: "load" });
  await page.locator(s.email).first().fill(email);
  await page.locator(s.password).first().fill(password);
  await page.locator(s.submit).first().click();
  await page.locator(s.waitFor).first().waitFor({ timeout: 30_000 });
  await page.goto("about:blank");
}

for (const p of manifest.pages ?? []) {
  test(`shot: ${p.name}`, async ({ page }) => {
    if (!outDir) throw new Error("SHOTS_OUT is not set");
    // Before navigation, so the page never sees the real clock. setFixedTime
    // rather than clock.install: install takes over timers too, and a page
    // waiting on a setTimeout to render would wait forever. It covers the
    // sign-in too, so a frozen date far from today can fail a token check.
    if (manifest.freeze_time) await page.clock.setFixedTime(new Date(manifest.freeze_time));
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Each test is a fresh context, so a page that opts out is signed out.
    if (manifest.signin && p.signedIn !== false) await signIn(page, manifest.signin);
    await page.goto(p.path, { waitUntil: "load" });
    if (p.waitFor) await page.locator(p.waitFor).first().waitFor({ timeout: 30_000 });
    if (p.settle_ms) await page.waitForTimeout(Math.min(p.settle_ms, 30_000));
    await page.addStyleTag({
      content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
    });
    // A shot taken mid font-swap diffs against itself forever.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({
      path: path.join(outDir, `${p.name}.png`),
      fullPage: p.fullPage ?? true,
      animations: "disabled",
      mask: (p.mask ?? []).map((s) => page.locator(s)),
    });
  });
}
