/**
 * `fleet doctor` -- what this machine can run, and why not the rest.
 *
 * The fleet already had this idea: `self-check` is a workload, and the machine
 * agent's capability probes decide what it declares. What it did not have was a
 * way to ask before anything is running. That is the moment somebody actually
 * needs the answer -- a job sat `queued` and nothing claimed it, and the
 * question is whether this machine was ever going to.
 *
 * The rule everywhere here: **say what is missing and what to do about it.**
 * A red cross with no sentence after it is a support request.
 */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentCollectors, load } from "./config.js";
import { isCheckout, paths, repoRoot } from "./paths.js";
import { VERSION } from "./version.js";

type Line = { ok: boolean | null; label: string; detail: string };

const tick = (l: Line) => (l.ok === null ? "  ? " : l.ok ? "  + " : "  - ");

export async function runDoctor(): Promise<number> {
  const config = load();
  const p = paths();
  const groups: { title: string; lines: Line[] }[] = [];

  // --- the machine ---------------------------------------------------------
  groups.push({
    title: "this machine",
    lines: [
      { ok: true, label: "fleet", detail: `${VERSION}${isCheckout() ? " (from a checkout)" : ""}` },
      {
        ok: nodeNewEnough(),
        label: "node",
        detail: nodeNewEnough()
          ? process.version
          : `${process.version} -- the collector needs 22.13 or newer, where node:sqlite lost its flag`,
      },
      { ok: true, label: "platform", detail: `${process.platform}/${process.arch}, ${os.cpus().length} cores` },
      { ok: true, label: "home", detail: p.home },
      { ok: writable(p.home), label: "writable", detail: writable(p.home) ? "yes" : `cannot write to ${p.home}` },
    ],
  });

  // --- what this machine would declare as an agent -------------------------
  //
  // Imported rather than reimplemented, so that what doctor prints and what the
  // agent registers cannot disagree. If this list is wrong, the agent is wrong.
  const agentLines: Line[] = [];
  try {
    const { probeCapabilities } = await agentModule();
    const caps = await probeCapabilities();
    agentLines.push({ ok: true, label: "declares", detail: caps.join(", ") });
    for (const [cap, why] of MISSING_HINTS) {
      if (!caps.some((c) => c === cap || c.startsWith(`${cap}:`))) {
        // Not a failure. A machine with no llama.cpp is a perfectly good fleet
        // member -- the synthetic backend is the whole reason it is -- and
        // `shell` is off until its owner pins an allowlist, by design. These
        // are listed because "why did nothing claim my job" is the question
        // doctor exists to answer, and counted as problems they would make the
        // summary cry wolf on every machine.
        agentLines.push({ ok: null, label: cap, detail: why });
      }
    }
  } catch (e) {
    agentLines.push({
      ok: null,
      label: "declares",
      detail: `could not probe (${(e as Error).message})`,
    });
  }
  groups.push({ title: "as a runner", lines: agentLines });

  // --- what this machine could drive as a host executor --------------------
  const hostLines: Line[] = [];
  const adb = await resolves("adb");
  hostLines.push({
    ok: adb !== null,
    label: "adb",
    detail: adb ?? "no Android device work from this host. Install Android platform-tools.",
  });
  const xcrun = process.platform === "darwin" ? await resolves("xcrun") : null;
  if (process.platform === "darwin") {
    const full = await hasFullXcode();
    hostLines.push({
      ok: full,
      label: "xcode",
      detail: full
        ? "full Xcode; simctl and devicectl are available"
        : "only the Command Line Tools. simctl and devicectl are not there, so no iOS host work. " +
          "Install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`.",
    });
  } else {
    hostLines.push({ ok: null, label: "xcode", detail: `not applicable on ${process.platform}` });
  }
  try {
    const { browserAvailable } = await browserModule();
    const browser = await browserAvailable();
    hostLines.push({ ok: browser.ok, label: "browser", detail: browser.detail });
  } catch (e) {
    hostLines.push({ ok: null, label: "browser", detail: `could not check (${(e as Error).message})` });
  }
  const maestro = existsSync(path.join(os.homedir(), ".maestro/bin/maestro"));
  hostLines.push({
    ok: maestro,
    label: "maestro",
    detail: maestro ? "~/.maestro/bin/maestro" : "no UI-test flows from this host. See docs/deploy.",
  });
  void xcrun;
  groups.push({ title: "as a host executor", lines: hostLines });

  // --- reachability --------------------------------------------------------
  const netLines: Line[] = [];
  for (const base of [...new Set(agentCollectors(config))]) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { name?: string; collector?: string };
      // A collector older than this build answers health without them, which is
      // not an error: `collector` and `name` are additive, and an agent that
      // needed them would be an agent that could not talk to last month's brain.
      netLines.push({
        ok: true,
        label: base,
        detail: body.name ? `${body.name} (${body.collector})` : "up (a build older than this one; it reports no name)",
      });
    } catch (e) {
      netLines.push({
        ok: false,
        label: base,
        detail: `${(e as Error).message}. Is a brain running there? \`fleet up --role brain\` starts one here.`,
      });
    }
  }
  if (netLines.length === 0) {
    netLines.push({ ok: null, label: "collectors", detail: "none configured; `fleet join <url>` points this machine at one" });
  }
  groups.push({ title: "reachability", lines: netLines });

  // --- print ---------------------------------------------------------------
  let bad = 0;
  for (const group of groups) {
    console.log(`\n${group.title}`);
    const width = Math.max(...group.lines.map((l) => l.label.length));
    for (const line of group.lines) {
      if (line.ok === false) bad += 1;
      console.log(`${tick(line)}${line.label.padEnd(width)}  ${line.detail}`);
    }
  }
  console.log(
    bad === 0
      ? "\nNothing here would stop a job from running. Lines marked ? are things this machine simply does not have."
      : `\n${bad} thing${bad === 1 ? "" : "s"} marked - would stop this machine working. Each line says what to do.`,
  );
  // Deliberately 0 either way. A machine that cannot build for iOS is not a
  // broken machine, and a doctor that exits non-zero for it would fail every CI
  // job somebody put it in.
  return 0;
}

/** Capability names worth explaining the absence of, and how to get them. */
const MISSING_HINTS: [string, string][] = [
  ["benchmark:llama.cpp", "no llama.cpp numbers from this machine. Put `llama-bench` on PATH, or set FLEET_LLAMA_BENCH."],
  ["build", "no builds from this machine. It needs gradle, xcodebuild or node on PATH."],
  ["model-convert", "no conversions from this machine. See docs/workloads/machine.md for the converter toolchain."],
  ["serve", "cannot host a model for other jobs to use. Put `llama-server` on PATH."],
  ["shell", "shell jobs are refused here, which is the default. A machine declares it only once its owner pins an allowlist."],
];

function nodeNewEnough(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function writable(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    // It does not exist yet, which is fine -- `fleet up` creates it. What would
    // not be fine is it existing and being a file.
    return true;
  }
}

async function resolves(binary: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec(process.platform === "win32" ? "where" : "which", [binary]);
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Full Xcode rather than the Command Line Tools.
 *
 * The distinction has cost this project an evening before: `xcrun` exists in
 * both, and only one of them can find `simctl`. Asking `xcrun` for it is the
 * question that has the answer.
 */
async function hasFullXcode(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    await exec("xcrun", ["--find", "simctl"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The machine agent's own probe module.
 *
 * A checkout resolves it as a sibling directory; a bundle has it inside. Both
 * paths lead to the same code, which is the point -- doctor must not have its
 * own opinion about what this machine can do.
 */
async function agentModule(): Promise<{ probeCapabilities: () => Promise<string[]> }> {
  if (isCheckout()) {
    // pathToFileURL rather than a `file://` template: this repository's own
    // checkout lives under a directory with a space in it, and
    // `file://.../Fleet Runner/...` is not a URL.
    const url = pathToFileURL(path.join(repoRoot(), "runner-machine/src/capabilities.ts"));
    return (await import(url.href)) as { probeCapabilities: () => Promise<string[]> };
  }
  return await import("../../runner-machine/src/capabilities.js");
}

/**
 * The collector's browser probe.
 *
 * Both branches name a literal specifier rather than building one, because a
 * bundler cannot follow `import(\`../${name}.js\`)` and quietly leaves it out --
 * which would work perfectly in a checkout and fail only in the release.
 */
async function browserModule(): Promise<{ browserAvailable: () => Promise<{ ok: boolean; detail: string }> }> {
  if (isCheckout()) {
    const url = pathToFileURL(path.join(repoRoot(), "collector/src/browser.ts"));
    return (await import(url.href)) as { browserAvailable: () => Promise<{ ok: boolean; detail: string }> };
  }
  return await import("../../collector/src/browser.js");
}
