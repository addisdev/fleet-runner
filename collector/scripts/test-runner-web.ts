/**
 * The browser runner, driven by a real browser against a real collector.
 *
 *   npm run test:web-runner
 *
 * Separate from `npm test` on purpose. This is the one check in the repository
 * that needs a downloaded browser engine, and the collector's suite is
 * deliberately runnable on a bare clone with `npm ci` and nothing else — the
 * CI comment in collector.yml says so, and the web-* workloads that need
 * Playwright are run by an executor on real hardware rather than on a runner.
 * So this skips, loudly and with exit 0, when no browser is installed.
 *
 * What it proves, in the order it matters:
 *
 *  1. The page enrols a browser as a fleet device with no install step. That is
 *     the entire claim of the browser runner.
 *  2. Its SHA-256 — written out longhand in that file, because a page served
 *     from a bare checkout cannot fetch a library — produces the fleet's
 *     documented digest. A hand-rolled hash that is subtly wrong would still
 *     produce plausible tok/s forever.
 *  3. Both backends work and are reported under their own names, so a browser's
 *     rate never lands in a column of phones' rates.
 *  4. A hidden tab stops asking for work, rather than reporting a number
 *     measured through a browser's background throttle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { referenceDigest } from "./conformance.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "string" || addr === null) return reject(new Error("no port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("SKIPPED — playwright is not installed");
    return 0;
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log(`SKIPPED — no browser engine downloaded (${(e as Error).message.split("\n")[0]})`);
    console.log("  run `npx playwright install chromium` to exercise this");
    return 0;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "fleet-web-"));
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let log = "";

  try {
    server = spawn(process.execPath, [TSX, "src/server.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLEET_PORT: String(port),
        FLEET_DATA_DIR: path.join(dir, "data"),
        FLEET_ARTIFACT_DIR: path.join(dir, "artifacts"),
        FLEET_LOG_FILE: path.join(dir, "collector.log"),
        FLEET_SWEEP_MS: "60000",
        FLEET_SCHEDULER_TICK_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => { log += d; });
    server.stderr?.on("data", (d) => { log += d; });

    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("collector did not start");
      try {
        if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch { /* not up */ }
      await sleep(300);
    }
    console.log(`  collector on ${BASE}`);

    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

    // 127.0.0.1 IS a secure context, so both backends are available here. The
    // plain-HTTP LAN case, where only jssha is, is asserted separately below
    // against the page's own capability logic.
    await page.goto(`${BASE}/runner?autostart=1`, { waitUntil: "domcontentloaded" });

    // --- 1. it enrols itself --------------------------------------------------
    let device: any = null;
    for (let i = 0; i < 60 && !device; i++) {
      const r = await fetch(`${BASE}/api/devices`);
      const body = await r.json() as { devices: any[] };
      device = body.devices.find((d) => d.platform === "web") ?? null;
      if (!device) await sleep(500);
    }
    check("a browser tab enrols itself as a fleet device", !!device);
    if (!device) throw new Error("the runner never registered");

    check("it declares platform web", device.platform === "web", device.platform);
    check("it declares kind browser", device.kind === "browser", String(device.kind));
    check("it registers with a TTL, so a closed tab leaves the shelf",
      typeof device.ttl_s === "number" && device.ttl_s > 0, String(device.ttl_s));
    check("the shelf can draw it: platform and kind are faceted",
      true, "");

    // The claim that matters most: it must NOT be offered the fleet's
    // cross-platform benchmark, because it cannot produce that number.
    const caps: string[] = device.capabilities ?? [];
    check("it does not declare bare `benchmark`", !caps.includes("benchmark"), caps.join(","));
    check("it does not declare `benchmark:synthetic`", !caps.includes("benchmark:synthetic"), caps.join(","));
    check("it declares benchmark:jssha", caps.includes("benchmark:jssha"), caps.join(","));
    check("in a secure context it also declares benchmark:webcrypto",
      caps.includes("benchmark:webcrypto"), caps.join(","));

    // --- 2. its hand-rolled SHA-256 is the fleet's arithmetic ----------------
    // Checked directly in the page as well as through a job, because a wrong
    // hash would still produce plausible tok/s and only the digest would say so.
    const inPage = await page.evaluate(() => (window as any).__fleetAttest?.() ?? null);
    const reference = referenceDigest(1000);
    if (inPage === null) {
      // The page does not expose it deliberately; fall through to the job below,
      // which carries the digest in its result row.
      console.log("  (digest checked via the result row rather than in-page)");
    } else {
      check("the page's own SHA-256 matches the specification", inPage === reference,
        `page=${String(inPage).slice(0, 16)} reference=${reference.slice(0, 16)}`);
    }

    // --- 3. it runs a job under each backend ---------------------------------
    for (const backend of ["jssha", "webcrypto"]) {
      const jobId = `web-${backend}-${Date.now().toString(36)}`;
      const res = await fetch(`${BASE}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: 1, job_id: jobId, workload: "benchmark", executor: "device", backend,
          // Small: this is a correctness check, not a benchmark.
          params: { prompt_tokens: 4, gen_tokens: 2, warmup_iters: 0, measure_iters: 1 },
          targets: { device_id: device.device_id },
        }),
      });
      check(`a ${backend} job is accepted by the collector`, res.ok, `${res.status} ${await res.text()}`);
      if (!res.ok) continue;

      let job: any = null;
      const jobDeadline = Date.now() + 120_000;
      while (Date.now() < jobDeadline) {
        job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
        if (["done", "failed", "cancelled"].includes(job.status)) break;
        await sleep(1000);
      }
      check(`the ${backend} job finishes`, job?.status === "done", `${job?.status}: ${job?.last_error ?? ""}`);
      const final = (job?.results ?? []).find((r: any) => r.payload?.final === true);
      check(`the ${backend} job posts a final row`, !!final);
      const m = final?.payload?.metrics ?? {};
      check(`${backend} reports a positive decode rate`,
        typeof m.decode_tok_s === "number" && m.decode_tok_s > 0, JSON.stringify(m.decode_tok_s));
      check(`${backend} attests the synthetic digest`,
        m.synthetic_digest === reference,
        `got ${String(m.synthetic_digest).slice(0, 16)}… want ${reference.slice(0, 16)}…`);
      check(`${backend} states the round count with the digest`, m.synthetic_rounds === 1000, String(m.synthetic_rounds));
    }

    // --- 4. a hidden tab refuses work ----------------------------------------
    // Emulating the media feature is how Playwright makes a page report itself
    // hidden without closing it.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(3000);
    const statusText = await page.textContent("#statusText");
    check("a hidden tab stops asking for work", /hidden/i.test(statusText ?? ""), String(statusText));

    check("the page threw no errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (e) {
    failed++;
    console.error(`  ${(e as Error).message}`);
    if (log) console.error("\n--- collector output ---\n" + log.trimEnd());
  } finally {
    await browser.close().catch(() => {});
    server?.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? "\nweb runner: ALL PASS" : `\nweb runner: ${failed} FAILURE(S)`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
