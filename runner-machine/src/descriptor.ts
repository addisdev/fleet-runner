/**
 * What this machine is, discovered rather than configured.
 *
 * The first five fields carry the names the collector's match expressions
 * already read, so `os ~ 'macos' && ram_mb >= 16000` works the day this agent
 * registers. The rest — kind, arch, gpu, vram_mb, cpu_cores — are the facts
 * about a computer that no phone descriptor had a place for, and the reason a
 * benchmark row from a laptop can be read at all.
 *
 * Every probe here goes through `orNull`. A machine with no `lspci`, a locked
 * down `wmic`, or a `system_profiler` that changed its JSON keys yields nulls,
 * not an agent that will not start.
 */
import os from "node:os";
import { existsSync } from "node:fs";
import { out, readText, orNull, firstMatch, finite, run } from "./probe.js";
import type { Descriptor } from "./protocol.js";

export const APP_VER = "0.1.0";

const MB = 1024 * 1024;

export async function describe(platform: NodeJS.Platform = process.platform): Promise<Descriptor> {
  const base: Descriptor = {
    model: null,
    soc: null,
    ram_mb: finite(os.totalmem() / MB) === null ? null : Math.round(os.totalmem() / MB),
    os: null,
    app_ver: APP_VER,
    platform: platformName(platform),
    kind: null,
    arch: os.arch(),
    gpu: null,
    vram_mb: null,
    cpu_cores: os.cpus().length || null,
  };
  const specific =
    platform === "darwin" ? await macos()
    : platform === "linux" ? await linux()
    : platform === "win32" ? await windows()
    : {};
  const merged = { ...base, ...specific };
  // A container or a CI runner overrides whatever the chassis probes decided.
  // Those probes answer a question about hardware, and inside a container the
  // hardware belongs to somebody else: a GitHub runner reporting "desktop"
  // would sit on the shelf beside machines that are still there tomorrow.
  const process_kind = processKind();
  if (process_kind !== null) merged.kind = process_kind;
  return merged;
}

/**
 * The OS family, as one word.
 *
 * Node's `process.platform` already knows, so this is a rename rather than a
 * probe: `darwin` is the kernel and `macos` is what a person filtering the
 * shelf types. Anything not in the three is passed through rather than mapped
 * to a guess — a FreeBSD box registering as "freebsd" is more useful than one
 * registering as "linux".
 */
export function platformName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

/**
 * Whether this process is inside a container, and whether it is a CI runner.
 *
 * Both change what the machine IS rather than what it has. A container has no
 * chassis and no battery, so the laptop/desktop probes below answer null and
 * the row would say nothing at all; and a CI runner is ephemeral by
 * construction, which is the fact that decides whether a person should expect
 * to see it again.
 *
 * CI is asked first: a GitHub runner is also a container, and "this will be
 * gone in four minutes" is the more useful of the two answers.
 */
export function processKind(env: NodeJS.ProcessEnv = process.env): "ci" | "container" | null {
  // GITHUB_ACTIONS, GITLAB_CI, CIRCLECI and friends all set CI=true; the
  // generic variable is what every provider agrees on.
  if (env.CI === "true" || env.CI === "1") return "ci";
  if (env.FLEET_KIND === "ci") return "ci";
  if (env.FLEET_KIND === "container") return "container";
  // /.dockerenv is Docker's own marker; the cgroup path catches Podman and
  // Kubernetes. Neither throws here — both are read through orNull upstream.
  if (existsSync("/.dockerenv")) return "container";
  return null;
}

// --- macOS ------------------------------------------------------------------

async function macos(): Promise<Partial<Descriptor>> {
  const hw = await orNull(async () => {
    const json = await out("system_profiler", ["-json", "SPHardwareDataType"], 20000);
    if (!json) return null;
    const parsed = JSON.parse(json) as { SPHardwareDataType?: Record<string, unknown>[] };
    return parsed.SPHardwareDataType?.[0] ?? null;
  });

  const model =
    (typeof hw?.machine_name === "string" ? hw.machine_name : null) ??
    (typeof hw?.machine_model === "string" ? hw.machine_model : null) ??
    (await orNull(() => out("sysctl", ["-n", "hw.model"])));

  // chip_type is "Apple M4 Pro" on Apple silicon; Intel Macs have no such key,
  // so the CPU brand string stands in — which is what "soc" means there anyway.
  const soc =
    (typeof hw?.chip_type === "string" ? hw.chip_type : null) ??
    (typeof hw?.cpu_type === "string" ? hw.cpu_type : null) ??
    (await orNull(() => out("sysctl", ["-n", "machdep.cpu.brand_string"])));

  const memsize = await orNull(() => out("sysctl", ["-n", "hw.memsize"]));
  const ram = finite(memsize);

  const version = await orNull(() => out("sw_vers", ["-productVersion"]));

  const gpuInfo = await orNull(async () => {
    const json = await out("system_profiler", ["-json", "SPDisplaysDataType"], 20000);
    if (!json) return null;
    const parsed = JSON.parse(json) as { SPDisplaysDataType?: Record<string, unknown>[] };
    const card = parsed.SPDisplaysDataType?.[0];
    if (!card) return null;
    const name = typeof card.sppci_model === "string" ? card.sppci_model : null;
    // Apple silicon has unified memory and reports no VRAM. Reporting total RAM
    // as VRAM would be a lie that reads as a 128 GB graphics card, so the field
    // stays null and the descriptor says nothing rather than something false.
    const vramText = typeof card.spdisplays_vram === "string" ? card.spdisplays_vram
      : typeof card.spdisplays_vram_shared === "string" ? card.spdisplays_vram_shared
      : null;
    const vram = vramText ? mbFromSizeString(vramText) : null;
    return { name, vram };
  });

  // An internal battery is what makes a Mac a laptop. `pmset -g batt` names one
  // if it exists and prints only the power source if it does not.
  const batt = await orNull(() => out("pmset", ["-g", "batt"]));
  const kind: Descriptor["kind"] = batt === null ? null : /InternalBattery/.test(batt) ? "laptop" : "desktop";

  return {
    model,
    soc,
    ram_mb: ram === null ? null : Math.round(ram / MB),
    os: version ? `macos-${version}` : null,
    kind,
    gpu: gpuInfo?.name ?? null,
    vram_mb: gpuInfo?.vram ?? null,
  };
}

/** "8 GB" / "1536 MB" as reported by system_profiler, in MB. */
export function mbFromSizeString(s: string): number | null {
  const m = /([\d.]+)\s*(GB|MB)/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2].toUpperCase() === "GB" ? n * 1024 : n);
}

// --- Linux ------------------------------------------------------------------

async function linux(): Promise<Partial<Descriptor>> {
  const model =
    (await orNull(async () => (await readText("/sys/devices/virtual/dmi/id/product_name"))?.trim() || null)) ??
    (await orNull(async () => (await readText("/sys/firmware/devicetree/base/model"))?.replace(/\0/g, "").trim() || null));

  const cpuinfo = await readText("/proc/cpuinfo");
  const soc =
    firstMatch(cpuinfo, /^model name\s*:\s*(.+)$/m) ??
    firstMatch(cpuinfo, /^Model\s*:\s*(.+)$/m) ??
    firstMatch(cpuinfo, /^Hardware\s*:\s*(.+)$/m);

  // MemTotal is in kB, whatever the unit column says.
  const memKb = finite(firstMatch(await readText("/proc/meminfo"), /^MemTotal:\s*(\d+)\s*kB/m));

  const release = await readText("/etc/os-release");
  const id = firstMatch(release, /^ID=\"?([^\"\n]+)\"?/m);
  const ver = firstMatch(release, /^VERSION_ID=\"?([^\"\n]+)\"?/m);
  const osName = id ? `linux-${id}${ver ? `-${ver}` : ""}` : `linux-${os.release()}`;

  // Chassis type 8/9/10/11/14/30/31/32 are the portable enclosures in the DMI
  // spec; a battery directory is the fallback for machines with no DMI at all.
  const chassis = finite((await readText("/sys/devices/virtual/dmi/id/chassis_type"))?.trim());
  const hasBattery = await orNull(async () => {
    const r = await run("sh", ["-c", "ls -d /sys/class/power_supply/BAT* 2>/dev/null | head -1"]);
    return r.stdout.trim() !== "";
  });
  const kind: Descriptor["kind"] =
    chassis !== null ? ([8, 9, 10, 11, 14, 30, 31, 32].includes(chassis) ? "laptop" : "desktop")
    : hasBattery === null ? null
    : hasBattery ? "laptop" : "desktop";

  const gpu = await orNull(async () => {
    const lspci = await out("lspci", []);
    if (!lspci) return null;
    const line = /^\S+\s+(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/m.exec(lspci);
    return line?.[1]?.trim() ?? null;
  });

  // lspci does not report VRAM. nvidia-smi does, when it is there; everything
  // else reports null rather than a number scraped out of a BAR size.
  const vram = await orNull(async () => {
    const smi = await out("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    return finite(smi?.split("\n")[0]?.trim());
  });

  return {
    model,
    soc,
    ram_mb: memKb === null ? null : Math.round(memKb / 1024),
    os: osName,
    kind,
    gpu,
    vram_mb: vram,
  };
}

// --- Windows ----------------------------------------------------------------

async function windows(): Promise<Partial<Descriptor>> {
  // wmic is deprecated but still the one query surface that needs no PowerShell
  // execution policy. Every call is wrapped, so a machine where it has finally
  // been removed reports nulls instead of failing to register.
  const wmic = async (args: string[]) => orNull(() => out("wmic", args, 15000));

  const model = wmicValue(await wmic(["computersystem", "get", "model", "/value"]), "Model");
  const soc = wmicValue(await wmic(["cpu", "get", "name", "/value"]), "Name");
  const ramBytes = finite(wmicValue(await wmic(["computersystem", "get", "TotalPhysicalMemory", "/value"]), "TotalPhysicalMemory"));
  const caption = wmicValue(await wmic(["os", "get", "Version", "/value"]), "Version");
  const gpuRaw = await wmic(["path", "win32_VideoController", "get", "Name,AdapterRAM", "/value"]);
  const gpu = wmicValue(gpuRaw, "Name");
  const vramBytes = finite(wmicValue(gpuRaw, "AdapterRAM"));
  const chassis = wmicValue(await wmic(["systemenclosure", "get", "ChassisTypes", "/value"]), "ChassisTypes");
  const battery = await wmic(["path", "Win32_Battery", "get", "Name", "/value"]);

  const portable = chassis ? /\b(8|9|10|11|12|14|30|31|32)\b/.test(chassis) : null;
  const kind: Descriptor["kind"] =
    portable !== null ? (portable ? "laptop" : "desktop")
    : battery === null ? null
    : /Name=\S/.test(battery) ? "laptop" : "desktop";

  return {
    model,
    soc,
    ram_mb: ramBytes === null ? null : Math.round(ramBytes / MB),
    os: caption ? `windows-${caption}` : null,
    kind,
    gpu,
    vram_mb: vramBytes === null ? null : Math.round(vramBytes / MB),
  };
}

/** Pulls `Key=value` out of wmic's /value output. */
export function wmicValue(text: string | null, key: string): string | null {
  if (!text) return null;
  const m = new RegExp(`^${key}=(.*)$`, "mi").exec(text);
  const v = m?.[1]?.trim();
  return v ? v : null;
}
