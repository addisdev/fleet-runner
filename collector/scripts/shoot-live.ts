// The two dashboard screenshots a throwaway collector cannot honestly produce,
// captured read-only from a running brain.
//
//   npm run shoot:live -- --url http://127.0.0.1:18788
//
// shoot-dash.ts starts a fresh collector with one machine agent, so its Devices
// screen is a single laptop and its Findings screen is empty: the device
// drawings need a shelf of real devices, and findings need a real explore night
// with a real model. Seeding either would be inventing data. This script only
// opens two pages on a brain that already has both, and writes nothing to it.
//
// Both views are filtered, and the filter is visible in the picture:
//   devices.png   status=online, so the shelf shows what is plugged in now
//   findings.png  app=bug-garden, the fixture app whose defects are planted on
//                 purpose; findings against a real product stay out of the docs
import path from "node:path";
import { chromium } from "playwright";

const at = process.argv.indexOf("--url");
const BASE = (at === -1 ? process.env.FLEET_URL : process.argv[at + 1])?.replace(/\/$/, "");
if (!BASE) {
  console.error("usage: npm run shoot:live -- --url http://brain:8788");
  process.exit(2);
}
const OUT = path.resolve(import.meta.dirname, "../../docs/img");

const SHOTS: [route: string, name: string][] = [
  ["/dash/devices?status=online", "devices"],
  ["/dash/findings?app=bug-garden", "findings"],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ colorScheme: "dark" });
  for (const [route, name] of SHOTS) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    // The dashboard renders from its own fetches, not from the document.
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`wrote ${name}.png from ${BASE}${route}`);
  }
} finally {
  await browser.close();
}
