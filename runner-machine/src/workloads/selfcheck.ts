/**
 * The `self-check` workload: the machine inspects itself and posts what the
 * alert engine needs.
 *
 * Three metrics carry the whole thing — `disk_free_gb`, `clock_offset_ms` and
 * `checks_failed` — because an alert rule that has to parse prose is an alert
 * rule nobody writes. `checks_failed` in particular exists so the rule is
 * `checks_failed > 0` and stays correct when a check is added.
 *
 * The rule for a missing tool is skip, not fail. A Linux box has no
 * `xcodebuild` and a Mac with no Android SDK has no `adb`; failing them would
 * make every machine permanently red and the signal worthless. A tool that IS
 * installed and answers something unparseable is a different thing and does
 * fail: that is a broken install, which is what this workload is for.
 */
import { statfs } from "node:fs/promises";
import os from "node:os";
import type { CollectorClient } from "../collector.js";
import type { Descriptor, JobSpec, Metrics, CheckRow } from "../protocol.js";
import { SCHEMA, compact, intParam, stringParam } from "../protocol.js";
import { out, run, which, orNull } from "../probe.js";
import { ntpOffsetMs } from "../clock.js";
import {
  parseXcodebuildVersion, parseAdbVersion, parseGradleVersion, parseNodeVersion,
  parseLaunchctlList, parseSystemctlIsActive,
} from "../versions.js";

/** The launchd label and systemd unit `deploy/install-agent.sh` installs. */
export const AGENT_LABEL = "com.addisdev.fleet-runner-machine";
export const AGENT_UNIT = "fleet-runner-machine.service";

/** Below this, a build is going to fail on disk space rather than on code. */
export const DEFAULT_MIN_DISK_GB = 10;
/**
 * Two seconds. Not a round number for its own sake: it is well above any
 * plausible NTP round trip on a home network and well below the point at which
 * a skew starts distorting a duration anyone reads, so a machine crossing it
 * has a clock problem rather than a slow link.
 */
export const DEFAULT_MAX_CLOCK_OFFSET_MS = 2000;

/** Counts only outright failures. A skipped check is not evidence of anything. */
export function countFailed(checks: CheckRow[]): number {
  return checks.filter((c) => c.ok === false).length;
}

/** A check whose tool is not installed: recorded, explained, and not counted. */
const skipped = (name: string, detail: string): CheckRow => ({ name, ok: null, detail });

export async function runSelfCheck(
  job: JobSpec,
  client: CollectorClient,
  deviceId: string,
  descriptor: Descriptor,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const checks: CheckRow[] = [];

  // --- disk ---------------------------------------------------------------
  const minDiskGb = intParam(job.params, "min_disk_gb", DEFAULT_MIN_DISK_GB);
  const diskFreeGb = await freeGb(platform);
  checks.push(
    diskFreeGb === null
      ? skipped("disk_free", "statfs did not answer")
      : {
          name: "disk_free", ok: diskFreeGb >= minDiskGb, value: diskFreeGb,
          detail: `${diskFreeGb} GB free, floor ${minDiskGb} GB`,
        },
  );

  // --- tools --------------------------------------------------------------
  checks.push(await toolCheck("xcodebuild", ["-version"], parseXcodebuildVersion, env));
  checks.push(await toolCheck("adb", ["version"], parseAdbVersion, env));
  checks.push(await toolCheck("gradle", ["--version"], parseGradleVersion, env, 60_000));
  checks.push(await toolCheck("node", ["-v"], parseNodeVersion, env));

  // --- clock --------------------------------------------------------------
  const maxOffset = intParam(job.params, "max_clock_offset_ms", DEFAULT_MAX_CLOCK_OFFSET_MS);
  const offset = await ntpOffsetMs(stringParam(job.params, "ntp_host") ?? env.FLEET_NTP_HOST ?? undefined);
  checks.push(
    offset === null
      ? skipped("clock_offset", "no answer from NTP (no network, or UDP 123 is blocked)")
      : {
          name: "clock_offset", ok: Math.abs(offset) <= maxOffset, value: offset,
          detail: `${offset} ms ${offset >= 0 ? "behind" : "ahead of"} NTP, tolerance ±${maxOffset} ms`,
        },
  );

  // --- is the agent this row came from actually the installed one? --------
  checks.push(await agentLoadedCheck(platform, env));

  const failed = countFailed(checks);
  await client.postResult({
    schema: SCHEMA, kind: "result", job_id: job.job_id, device_id: deviceId,
    iter: 0, final: true, ok: failed === 0, device: descriptor,
    metrics: compact<Metrics>({
      disk_free_gb: diskFreeGb ?? undefined,
      clock_offset_ms: offset ?? undefined,
      checks_failed: failed,
    }),
    // The breakdown, so the dashboard can say WHICH check failed. Not in the
    // result schema's `metrics` because these are not numbers to trend; the
    // collector stores the whole payload, so a named list survives.
    checks,
    ...(failed > 0
      ? { error: `${failed} check${failed === 1 ? "" : "s"} failed: ${checks.filter((c) => c.ok === false).map((c) => c.name).join(", ")}` }
      : {}),
  });
}

/**
 * A tool check. Absent is skipped; present-but-unparseable is a failure,
 * because that is a broken install and the only way anyone finds out is here.
 */
export async function toolCheck(
  bin: string,
  args: string[],
  parse: (text: string | null) => string | null,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20_000,
): Promise<CheckRow> {
  const resolved = await which(bin, env);
  if (!resolved) return skipped(`tool:${bin}`, `${bin} is not on PATH`);
  const text = await orNull(() => out(resolved, args, timeoutMs));
  const version = parse(text);
  return version === null
    ? { name: `tool:${bin}`, ok: false, detail: `${resolved} is installed but '${bin} ${args.join(" ")}' answered nothing recognisable` }
    : { name: `tool:${bin}`, ok: true, value: version, detail: resolved };
}

/**
 * Is the expected agent actually loaded?
 *
 * The subtlety worth naming: this row is posted BY the agent, so something is
 * obviously running. The question is whether the thing running is the one the
 * service manager is supervising — an operator who ran `npm start` in a
 * terminal to debug something has a fleet member that vanishes when the SSH
 * session ends, and nothing else on the dashboard would ever say so.
 */
export async function agentLoadedCheck(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckRow> {
  const label = env.FLEET_AGENT_LABEL ?? AGENT_LABEL;
  if (platform === "darwin") {
    const text = await orNull(() => out("launchctl", ["list", label], 15_000));
    const state = parseLaunchctlList(text);
    if (!state.loaded) return { name: "agent_loaded", ok: false, detail: `launchd has no ${label} loaded` };
    if (state.lastExit !== null && state.lastExit !== 0 && state.pid === null) {
      return { name: "agent_loaded", ok: false, value: label, detail: `${label} is loaded but not running (last exit ${state.lastExit})` };
    }
    return { name: "agent_loaded", ok: true, value: label, detail: state.pid === null ? `${label} loaded` : `${label} running as pid ${state.pid}` };
  }
  if (platform === "linux") {
    const unit = env.FLEET_AGENT_UNIT ?? AGENT_UNIT;
    if (!(await which("systemctl", env))) return skipped("agent_loaded", "systemctl is not on PATH");
    // is-active exits non-zero for anything but active, so the exit status is
    // not the answer -- the word it prints is, which `run` gives even then.
    const text = await orNull(async () => {
      const r = await run("systemctl", ["--user", "is-active", unit], 15_000);
      return `${r.stdout}${r.stderr}`.trim() || null;
    });
    const state = parseSystemctlIsActive(text);
    return state.loaded
      ? { name: "agent_loaded", ok: true, value: unit, detail: `${unit} is ${state.state}` }
      : { name: "agent_loaded", ok: false, value: unit, detail: `${unit} is ${state.state ?? "not known to systemd"}` };
  }
  return skipped("agent_loaded", `no service-manager probe for ${platform}`);
}

/** Free space where the work happens: the home volume, not necessarily `/`. */
async function freeGb(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  return orNull(async () => {
    const target = platform === "win32" ? process.cwd() : os.homedir();
    const s = await statfs(target);
    const bytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(bytes) ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null;
  });
}
