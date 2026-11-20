/**
 * Where a Maestro flow's screenshots end up, with no device: the 2.x output
 * tree read back into shots and failure shots, the upload names ui-test gives
 * them, and runFlow putting them in the caller's folder against a fake Maestro
 * that writes the layout 2.8.0 wrote on ultra on 2026-11-20.
 *
 * Run from scripts/smoke.ts like the other decision checks. What it cannot
 * show is a real Maestro on a real phone, which only the lab can.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAESTRO_OUTPUT_FLAG, collectFlowShots, runFlow, uploadFlowShots } from "./flows.js";
import type { Target } from "./types.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const FLOW = "CT1: first open of the release build, signed out, no location grant (what a new tester sees)";

/** The tree Maestro 2.8.0 leaves under --test-output-dir for one flow. */
function maestroTree(root: string, opts: { flow?: string; shots?: string[]; failure?: string } = {}) {
  const flowDir = path.join(root, "2026-11-20_112023", opts.flow ?? FLOW);
  for (const d of ["takeScreenshot", "screenshots", "screen-hierarchy", "logs"]) mkdirSync(path.join(flowDir, d), { recursive: true });
  for (const s of opts.shots ?? []) writeFileSync(path.join(flowDir, "takeScreenshot", s), PNG);
  if (opts.failure) {
    writeFileSync(path.join(flowDir, "screenshots", opts.failure), PNG);
    writeFileSync(path.join(flowDir, "screen-hierarchy", opts.failure.replace(/\.png$/, ".json")), "{}");
  }
  // commands.json holds every typed value, the password included.
  writeFileSync(path.join(flowDir, "commands.json"), JSON.stringify([{ inputText: "hunter2" }]));
  writeFileSync(path.join(flowDir, "logs", "maestro.log"), "log");
  writeFileSync(path.join(flowDir, "manifest.json"), "{}");
  writeFileSync(path.join(root, "2026-11-20_112023", "maestro.log"), "log");
}

/**
 * A stand-in for the maestro binary: finds --test-output-dir, writes the 2.8.0
 * tree there, records where it wrote and what it was asked, and exits with
 * FAKE_EXIT. A shell script, so POSIX only.
 */
function fakeMaestro(dir: string, opts: { exit: number; shots: string[]; failure?: string }): string {
  const bin = path.join(dir, "maestro");
  const flowDir = `"$out/2026-11-20_112023/${FLOW}"`;
  writeFileSync(bin, [
    "#!/bin/sh",
    `echo "$@" > "${path.join(dir, "args.txt")}"`,
    'out=""; while [ $# -gt 0 ]; do if [ "$1" = "--test-output-dir" ]; then out="$2"; fi; shift; done',
    `[ -n "$out" ] || { echo "no output dir" >&2; exit 64; }`,
    `echo "$out" > "${path.join(dir, "out.txt")}"`,
    `mkdir -p ${flowDir}/takeScreenshot ${flowDir}/screenshots ${flowDir}/logs`,
    ...opts.shots.map((s) => `printf 'png' > ${flowDir}/takeScreenshot/${s}`),
    ...(opts.failure ? [`printf 'png' > ${flowDir}/screenshots/${opts.failure}`] : []),
    `printf '[{"inputText":"hunter2"}]' > ${flowDir}/commands.json`,
    opts.exit ? `echo "Assertion is false" ; exit ${opts.exit}` : "exit 0",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

const target: Target = { id: "ce12345678", platform: "android", kind: "device" };
const pngsAt = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : [];

export async function runFlowChecks(check: Check) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fleet-flows-test-"));
  try {
    // --- reading the tree ------------------------------------------------
    {
      const root = path.join(tmp, "tree");
      maestroTree(root, { shots: ["ct1-02-map.png", "ct1-01-first-screen.png"], failure: "step-010-assertCondition-Allow_location.png" });
      const found = collectFlowShots(root);
      check("flows: the flow's takeScreenshot images are its shots, in name order",
        JSON.stringify(found.shots.map((s) => s.name)) === JSON.stringify(["ct1-01-first-screen.png", "ct1-02-map.png"]),
        JSON.stringify(found.shots));
      check("flows: a failing step's shot is found under screenshots/",
        JSON.stringify(found.failures.map((s) => s.name)) === JSON.stringify(["screenshots/step-010-assertCondition-Allow_location.png"]),
        JSON.stringify(found.failures));
      check("flows: the shots point at real files", [...found.shots, ...found.failures].every((s) => existsSync(s.file)));
      check("flows: logs, hierarchy dumps and commands.json are never collected",
        [...found.shots, ...found.failures].every((s) => s.file.endsWith(".png")));
    }
    {
      const root = path.join(tmp, "legacy");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "home.png"), PNG);
      const found = collectFlowShots(root);
      check("flows: a PNG at the top is Maestro 1.x's layout and still counts",
        found.shots.length === 1 && found.shots[0].name === "home.png" && found.failures.length === 0);
    }
    {
      const root = path.join(tmp, "two-flows");
      maestroTree(root, { flow: "a", shots: ["home.png"] });
      maestroTree(root, { flow: "b", shots: ["home.png"] });
      const names = collectFlowShots(root).shots.map((s) => s.name);
      check("flows: two flows' home.png both survive, the second as home-2.png",
        JSON.stringify(names) === JSON.stringify(["home-2.png", "home.png"]), JSON.stringify(names));
    }
    check("flows: a folder that does not exist has no shots",
      collectFlowShots(path.join(tmp, "nope")).shots.length === 0);

    // --- what ui-test uploads ----------------------------------------------
    {
      const root = path.join(tmp, "upload");
      maestroTree(root, { shots: ["ct1-01-first-screen.png", "ct1-02-map.png"], failure: "step-010-assertCondition-Allow_location.png" });
      const names: string[] = [];
      const lines: string[] = [];
      const up = await uploadFlowShots(root, "job-1-ce12345678", async (file, name) => {
        if (name.endsWith("ct1-02-map.png")) throw new Error("artifact upload -> 507");
        if (!file.endsWith(".png")) throw new Error(`uploaded a non-PNG ${file}`);
        names.push(name);
        return `sha-${names.length}`;
      }, (l) => lines.push(l));
      check("flows: ui-test names each shot job-serial-<file>, the failure shot under screenshots/",
        JSON.stringify(names) === JSON.stringify([
          "job-1-ce12345678-ct1-01-first-screen.png",
          "job-1-ce12345678-screenshots/step-010-assertCondition-Allow_location.png",
        ]), JSON.stringify(names));
      check("flows: a shot that will not upload is logged and the rest still go",
        up.shas.length === 2 && up.shots === 2 && up.failures === 1 && lines.some((l) => l.includes("ct1-02-map.png") && l.includes("507")),
        JSON.stringify({ up, lines }));
    }

    // --- runFlow against a fake Maestro ---------------------------------------
    if (process.platform === "win32") {
      console.log("  (skipped on Windows: the fake Maestro is a shell script)");
    } else {
      {
        const dir = path.join(tmp, "fake-pass");
        mkdirSync(dir, { recursive: true });
        const bin = fakeMaestro(dir, { exit: 0, shots: ["ct1-01-first-screen.png", "ct1-02-map.png"] });
        const cwd = path.join(tmp, "locale", "en-US", "ce12345678");
        const err = await runFlow(target, "/flows/ct1.yaml", cwd, { APP_ID: "com.taylab.jerv", LOCALE: "en-US" }, 30_000, bin);
        const args = readFileSync(path.join(dir, "args.txt"), "utf8");
        check("flows: runFlow passes --test-output-dir", args.includes(MAESTRO_OUTPUT_FLAG), args);
        check("flows: a passing flow returns null", err === null, String(err));
        check("flows: runFlow puts takeScreenshot images in the caller's folder (the en-US case that reported none)",
          JSON.stringify(pngsAt(cwd)) === JSON.stringify(["ct1-01-first-screen.png", "ct1-02-map.png"]), JSON.stringify(pngsAt(cwd)));
        const out = readFileSync(path.join(dir, "out.txt"), "utf8").trim();
        check("flows: Maestro's own output folder is gone afterwards (commands.json holds typed values)",
          out.length > 0 && !existsSync(out), out);
        check("flows: nothing but the shots lands in the caller's folder",
          readdirSync(cwd).every((f) => f.endsWith(".png")), readdirSync(cwd).join(","));
      }
      {
        const dir = path.join(tmp, "fake-fail");
        mkdirSync(dir, { recursive: true });
        const bin = fakeMaestro(dir, { exit: 1, shots: ["ct1-01-first-screen.png"], failure: "step-010-assertCondition-Allow_location.png" });
        const cwd = path.join(tmp, "fail-cwd");
        const err = await runFlow(target, "/flows/ct1.yaml", cwd, {}, 30_000, bin);
        check("flows: a failing flow returns its failure text", !!err && err.includes("Assertion is false"), String(err));
        check("flows: the shots taken before the failure still land at the top",
          JSON.stringify(pngsAt(cwd)) === JSON.stringify(["ct1-01-first-screen.png"]), JSON.stringify(pngsAt(cwd)));
        check("flows: the failing step's shot lands under screenshots/, out of a locale's shot count",
          JSON.stringify(pngsAt(path.join(cwd, "screenshots"))) === JSON.stringify(["step-010-assertCondition-Allow_location.png"]));
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
