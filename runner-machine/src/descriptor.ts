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
  // A platform probe that found nothing must not erase what Node already knows.
  //
  // `ram_mb` is the one field where the base is a real reading rather than a
  // null placeholder — `os.totalmem()` answers on every platform Node runs on —
  // and a plain spread let a probe's null win, so Windows reported no memory
  // for a machine whose size was sitting in `base` the whole time. The probe
  // still wins when it answers: `hw.memsize`, `MemTotal` and
  // `TotalPhysicalMemory` are the readings the rest of the descriptor is built
  // from, and staying consistent with them matters more than the last MB. A
  // miss now falls back instead of clobbering.
  merged.ram_mb = merged.ram_mb ?? base.ram_mb;
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
//
// Two query surfaces, in the order they are likely to answer.
//
// `wmic` used to be the whole Windows path here, chosen because it needs no
// PowerShell execution policy. The platform matrix then ran the descriptor on
// windows-latest and every Windows field came back null: `wmic` is a REMOVED
// feature on current Windows, not a deprecated one, so the probes were asking
// a question of a binary that is no longer installed. The agent registered —
// the nulls are the contract working — but `os` and `ram_mb` being null means
// no `targets.match` expression can select a Windows machine by its OS or its
// memory, which leaves `device_id`, `platform` and `arch` as the only handles
// on it.
//
// So `Get-CimInstance` leads and `wmic` is the fallback for the older Windows
// installs that still have it. Both are wrapped: a machine where neither
// answers reports nulls rather than failing to register.

/** The Windows facts, before they are shaped into descriptor fields. */
type WinFacts = {
  model: string | null;
  soc: string | null;
  ramBytes: number | null;
  version: string | null;
  gpu: string | null;
  vramBytes: number | null;
  /** Win32_SystemEnclosure ChassisTypes, comma-joined: "3", or "10,32". */
  chassis: string | null;
  /** Whether the machine reported any battery at all. */
  battery: boolean | null;
};

async function windows(): Promise<Partial<Descriptor>> {
  // wmic only runs when CIM found nothing at all. A machine that answered the
  // CIM queries has WMI working, and asking a removed binary the same six
  // questions afterwards costs six process spawns to learn nothing.
  const facts = (await cimFacts()) ?? (await wmicFacts());

  const portable = chassisIsPortable(facts.chassis);
  const kind: Descriptor["kind"] =
    portable !== null ? (portable ? "laptop" : "desktop")
    : facts.battery === null ? null
    : facts.battery ? "laptop" : "desktop";

  return {
    model: facts.model,
    soc: facts.soc,
    ram_mb: facts.ramBytes === null ? null : Math.round(facts.ramBytes / MB),
    os: facts.version ? `windows-${facts.version}` : null,
    kind,
    gpu: facts.gpu,
    vram_mb: vramMbFromAdapterRam(facts.vramBytes),
  };
}

/**
 * One PowerShell process, six CIM queries, one JSON object.
 *
 * Combined rather than one shell-out per field because PowerShell startup is
 * the expensive part and this runs on the path to registration. Each query
 * stands alone under `SilentlyContinue`: a class that is unavailable leaves
 * its own fields null instead of taking the other five down with it.
 */
const CIM_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  // Windows PowerShell writes redirected stdout in the console codepage, which
  // turns an OEM model name with an accent in it into mojibake. The try is
  // because setting it is not possible in every host, and losing the whole
  // descriptor over an encoding preference would be the worse trade.
  "try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}",
  "$cs=Get-CimInstance -ClassName Win32_ComputerSystem",
  "$cpu=@(Get-CimInstance -ClassName Win32_Processor)[0]",
  "$osi=Get-CimInstance -ClassName Win32_OperatingSystem",
  // The first adapter that has a name: a machine with a disabled or
  // placeholder entry alongside a real card should report the real card.
  "$vc=@(Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name })[0]",
  "$se=@(Get-CimInstance -ClassName Win32_SystemEnclosure)",
  "$bat=@(Get-CimInstance -ClassName Win32_Battery)",
  // uint64 values go out as strings; JSON numbers would round TotalPhysicalMemory.
  "[pscustomobject]@{" +
    "model=$cs.Model;" +
    "soc=$cpu.Name;" +
    "ram=[string]$cs.TotalPhysicalMemory;" +
    "os=$osi.Version;" +
    "gpu=$vc.Name;" +
    "vram=[string]$vc.AdapterRAM;" +
    "chassis=(($se.ChassisTypes|ForEach-Object{[string]$_})-join ',');" +
    "battery=($bat.Count -gt 0)" +
  "} | ConvertTo-Json -Compress",
].join("; ");

async function cimFacts(): Promise<WinFacts | null> {
  // Windows PowerShell 5.1 ships with every supported Windows and is the one
  // that is always there; pwsh is tried second for a machine that has only
  // PowerShell 7. `-Command` is not subject to execution policy — that governs
  // script files — and -NoProfile keeps a user's profile out of the output.
  for (const shell of ["powershell", "pwsh"]) {
    const json = await orNull(() =>
      out(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CIM_SCRIPT], 30000),
    );
    const facts = winFactsFromCimJson(json);
    if (facts) return facts;
  }
  return null;
}

/**
 * The CIM script's JSON, as facts — or null when it answered nothing.
 *
 * "Nothing" is the important case: PowerShell exists on plenty of machines
 * where WMI does not answer, and on macOS and Linux `pwsh` runs the script
 * happily and finds no `Get-CimInstance` at all. An object of nulls is not an
 * answer, so it reads as a miss and lets wmic have its turn.
 */
export function winFactsFromCimJson(json: string | null): WinFacts | null {
  if (!json) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  const facts: WinFacts = {
    model: str(parsed.model),
    soc: str(parsed.soc),
    ramBytes: finite(str(parsed.ram)),
    version: str(parsed.os),
    gpu: str(parsed.gpu),
    vramBytes: finite(str(parsed.vram)),
    chassis: str(parsed.chassis),
    // `false` is a real answer here — a desktop reports no battery — so the
    // boolean is only null when the script did not produce one.
    battery: typeof parsed.battery === "boolean" ? parsed.battery : null,
  };
  const answered =
    facts.model !== null || facts.soc !== null || facts.ramBytes !== null ||
    facts.version !== null || facts.gpu !== null || facts.chassis !== null;
  return answered ? facts : null;
}

/**
 * The old surface, for Windows installs that still have it.
 *
 * Unlike the CIM probe this always returns facts rather than a miss: it is the
 * last thing asked, so an all-null result is the answer.
 */
async function wmicFacts(): Promise<WinFacts> {
  const wmic = async (args: string[]) => orNull(() => out("wmic", args, 15000));

  const gpuRaw = await wmic(["path", "win32_VideoController", "get", "Name,AdapterRAM", "/value"]);
  const battery = await wmic(["path", "Win32_Battery", "get", "Name", "/value"]);

  return {
    model: wmicValue(await wmic(["computersystem", "get", "model", "/value"]), "Model"),
    soc: wmicValue(await wmic(["cpu", "get", "name", "/value"]), "Name"),
    ramBytes: finite(wmicValue(await wmic(["computersystem", "get", "TotalPhysicalMemory", "/value"]), "TotalPhysicalMemory")),
    version: wmicValue(await wmic(["os", "get", "Version", "/value"]), "Version"),
    gpu: wmicValue(gpuRaw, "Name"),
    vramBytes: finite(wmicValue(gpuRaw, "AdapterRAM")),
    chassis: wmicValue(await wmic(["systemenclosure", "get", "ChassisTypes", "/value"]), "ChassisTypes"),
    // wmic prints the header and nothing else when there is no battery, so an
    // empty result and a failed call look alike; only a named instance counts
    // as "laptop", and a call that did not run at all stays null.
    battery: battery === null ? null : /Name=\S/.test(battery),
  };
}

/**
 * Chassis type 8/9/10/11/12/14/30/31/32 are the portable enclosures in the
 * SMBIOS spec. Null when nothing said.
 */
export function chassisIsPortable(chassis: string | null): boolean | null {
  if (!chassis) return null;
  return /\b(8|9|10|11|12|14|30|31|32)\b/.test(chassis);
}

/**
 * Win32_VideoController.AdapterRAM in MB, or null when it cannot be believed.
 *
 * AdapterRAM is a uint32, so every card with 4 GB or more reports the same
 * saturated ceiling — 4293918720, which is 4095 MB. Passing that through would
 * put "4095" in the vram_mb column for a 24 GB card and let a match expression
 * asking for 16000 skip the one machine that could have run the job. Same
 * discipline as Apple silicon reporting no VRAM: the field says nothing rather
 * than something false.
 */
export function vramMbFromAdapterRam(bytes: number | null): number | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes >= 4293918720) return null;
  return Math.round(bytes / MB);
}

/** Pulls `Key=value` out of wmic's /value output. */
export function wmicValue(text: string | null, key: string): string | null {
  if (!text) return null;
  const m = new RegExp(`^${key}=(.*)$`, "mi").exec(text);
  const v = m?.[1]?.trim();
  return v ? v : null;
}
