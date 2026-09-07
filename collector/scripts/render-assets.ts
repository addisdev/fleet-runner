// Renders every figure in docs/assets/ to docs/img/ at 2×.
//
// A figure is an HTML file whose root element carries class="figure" and
// declares its own CSS size and its own charcoal ground. The rendered PNG is
// exactly that element at twice its CSS size, so a 1280×640 figure becomes a
// 2560×1280 image — the size the README banner and the social card already
// are. Fonts are the ones in docs/assets/fonts/, so the output is the same on
// any machine and in CI, which an SVG with web fonts on GitHub is not.
//
//   npm run assets                 every figure
//   npm run assets -- --only banner   one figure, by file name without .html
//
// Playwright is already a collector dependency (the host executor drives it),
// so this costs nothing new.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ASSETS = path.resolve(import.meta.dirname, "../../docs/assets");
const OUT = path.resolve(import.meta.dirname, "../../docs/img");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
if (onlyAt !== -1 && !only) {
  console.error("--only needs a figure name");
  process.exit(2);
}

const figures = (await readdir(ASSETS))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -".html".length))
  .filter((f) => !only || f === only)
  .sort();

if (figures.length === 0) {
  console.error(only ? `no figure named ${only} in ${ASSETS}` : `no figures in ${ASSETS}`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  for (const name of figures) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(pathToFileURL(path.join(ASSETS, `${name}.html`)).href, { waitUntil: "load" });
    // Fonts are declared with @font-face and load asynchronously; a screenshot
    // before this resolves gets the fallback face.
    await page.evaluate(() => (document as any).fonts.ready);
    const figure = page.locator(".figure").first();
    if ((await figure.count()) === 0) throw new Error(`${name}.html has no .figure element`);
    const box = await figure.boundingBox();
    if (!box) throw new Error(`${name}.html: .figure has no box`);
    const target = path.join(OUT, `${name}.png`);
    await figure.screenshot({ path: target, animations: "disabled" });
    const size = (await stat(target)).size;
    console.log(`${name}.png  ${box.width * 2}×${box.height * 2}  ${(size / 1024).toFixed(0)} KB`);
    await page.close();
  }
} finally {
  await browser.close();
}
