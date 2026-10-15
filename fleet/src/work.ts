/**
 * The work commands: `fleet devices`, `run`, `job`, `wait`, `results`...
 *
 * The same /api/v1 operations the MCP tools call, through the same generated
 * client, for the two users who prefer a shell: a person, and a coding agent
 * that is better at running a command than at holding an MCP session open.
 * The agent case decides the details:
 *
 * - `--json` on every command prints the API's answer and nothing else.
 * - Progress goes to stderr, results to stdout, so a pipe gets only results.
 * - The exit code is the verdict, so `fleet run ... && deploy` means something:
 *     0 passed   1 failed (or mixed, cancelled)   2 usage or invalid spec
 *     3 still running when the wait ran out   4 skipped (nothing ran)   5 refused or unreachable
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FleetClient, JobSpecInput, JobSummary } from "../../collector/src/client/index.js";
import { FleetApiError } from "../../collector/src/client/index.js";
import { childEnv, load } from "./config.js";
import { connect, readCredentials, resolveBrain, writeCredentials } from "./connect.js";
import { assetRoot, repoRoot } from "./paths.js";

export const EXIT = { passed: 0, failed: 1, usage: 2, pending: 3, skipped: 4, error: 5 } as const;

type Args = { positional: string[]; flags: Record<string, string | boolean>; lists: Record<string, string[]> };

/** Flags that take no value, so `--json <id>` does not eat the id. */
const BOOLEAN = new Set(["json", "all", "available", "fanout", "validate", "no-wait", "wait", "failures", "force", "exclusive", "no-validate", "help"]);
/** Flags that may repeat. */
const REPEATED = new Set(["param", "target"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {}, lists: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--") || a === "-") {
      out.positional.push(a);
      continue;
    }
    let key = a.slice(2);
    let value: string | boolean;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (BOOLEAN.has(key)) {
      value = true;
    } else if (i + 1 < argv.length) {
      value = argv[++i];
    } else {
      value = true;
    }
    if (REPEATED.has(key)) (out.lists[key] ??= []).push(String(value));
    else out.flags[key] = value;
  }
  return out;
}

const str = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
const num = (a: Args, k: string, d: number) => {
  const v = str(a, k);
  const n = v === undefined ? d : Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${k} must be a number`);
  return n;
};

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const printJson = (v: unknown) => out(JSON.stringify(v, null, 2));

function table(rows: (string | number | null | undefined)[][], header?: string[]) {
  const all = header ? [header, ...rows] : rows;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length))) ?? [];
  for (const r of all) out(r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd());
}

const ago = (iso: string | null | undefined) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

function verdictExit(s: JobSummary): number {
  if (!s.finished) return EXIT.pending;
  if (s.verdict === "passed") return EXIT.passed;
  if (s.verdict === "skipped") return EXIT.skipped;
  return EXIT.failed;
}

function printSummary(s: JobSummary) {
  const words: Record<string, string> = { passed: "PASSED", failed: "FAILED", mixed: "MIXED", skipped: "SKIPPED (nothing ran)", cancelled: "CANCELLED" };
  const word = words[s.verdict] ?? s.verdict;
  out(`${s.job_id}  ${word}  ${s.counts.devices} device${s.counts.devices === 1 ? "" : "s"}${s.duration_s != null ? `, ${s.duration_s}s` : ""}`);
  for (const d of s.devices) {
    const state = d.skipped ? "skipped" : d.ok === true ? "passed" : d.ok === false ? "FAILED" : d.status;
    const metrics = d.metrics ? Object.entries(d.metrics).filter(([, v]) => typeof v !== "object").slice(0, 4).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const tests = d.test ? `tests ${d.test.passed ?? "?"} passed, ${d.test.failed ?? "?"} failed` : "";
    out(`  ${d.device_id.padEnd(24)} ${state.padEnd(8)} ${[tests, metrics].filter(Boolean).join("  ")}`.trimEnd());
    if (d.failing_step) out(`    failing step: ${d.failing_step}`);
    if (d.error && !d.ok) out(`    ${d.error.split("\n")[0].slice(0, 300)}`);
  }
  if (s.artifacts.length) {
    out("artifacts");
    for (const a of s.artifacts.slice(0, 20)) out(`  ${(a.name ?? "").padEnd(28)} ${(a.media_type ?? "").padEnd(18)} ${a.sha256}`);
    if (s.artifacts.length > 20) out(`  ... ${s.artifacts.length - 20} more (--json lists them all)`);
  }
  if (!s.finished) err(`still ${s.verdict}. Follow it: fleet wait ${s.job_id}`);
}

async function waitFor(client: FleetClient, id: string, timeoutS: number, quiet: boolean): Promise<JobSummary> {
  const deadline = Date.now() + timeoutS * 1000;
  let s = await client.getJobSummary(id);
  let last = "";
  while (!s.finished && Date.now() < deadline) {
    const state = `${s.verdict} ${s.counts.running}/${s.counts.devices}`;
    if (!quiet && state !== last) err(`  ${new Date().toISOString().slice(11, 19)}  ${s.verdict}${s.counts.devices > 1 ? ` (${s.counts.running} of ${s.counts.devices} unfinished)` : ""}`);
    last = state;
    const left = Math.ceil((deadline - Date.now()) / 1000);
    try {
      s = await client.waitJob(id, { timeout_s: Math.max(1, Math.min(60, left)) });
    } catch (e) {
      if (e instanceof FleetApiError && e.code === "unreachable") {
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      throw e;
    }
  }
  return s;
}

/** `key=value`, with dotted keys for nesting and JSON values where they parse. */
function setParam(target: Record<string, unknown>, pair: string) {
  const eq = pair.indexOf("=");
  if (eq < 1) throw new UsageError(`--param wants key=value, got ${pair}`);
  const keys = pair.slice(0, eq).split(".");
  const raw = pair.slice(eq + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch { /* a plain string */ }
  let node = target;
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
}

function readSpecFile(file: string): Record<string, unknown> {
  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(`${file}: not a JSON job spec (${(e as Error).message})`);
  }
}

async function buildSpec(client: FleetClient, a: Args): Promise<JobSpecInput> {
  const spec: Record<string, unknown> = str(a, "spec") ? readSpecFile(str(a, "spec")!) : {};
  const workload = a.positional[0] ?? (spec.workload as string | undefined);
  if (!workload) throw new UsageError("which workload? `fleet workloads` lists them; or pass --spec FILE");
  spec.workload = workload;
  if (!spec.executor) spec.executor = (await client.getWorkload(workload)).executor;
  const targets = { ...((spec.targets as Record<string, unknown>) ?? {}) };
  if (str(a, "device")) targets.device_id = str(a, "device");
  if (str(a, "pool")) targets.pool = str(a, "pool");
  if (str(a, "match")) targets.match = str(a, "match");
  if (a.flags.exclusive === true) targets.exclusive = true;
  for (const t of a.lists.target ?? []) setParam(targets, t);
  if (Object.keys(targets).length) spec.targets = targets;
  if (str(a, "app")) {
    spec.app = {
      ...((spec.app as object) ?? {}),
      name: str(a, "app"),
      build: str(a, "build") ?? "latest",
      sha256: str(a, "sha256") ?? "latest",
      ...(str(a, "platform") ? { platform: str(a, "platform") } : {}),
    };
  }
  if (str(a, "backend")) spec.backend = str(a, "backend");
  if (str(a, "priority")) spec.priority = num(a, "priority", 0);
  if (str(a, "id")) spec.job_id = str(a, "id");
  if (a.flags.fanout === true) spec.fanout = true;
  if (a.lists.param?.length) {
    const params = { ...((spec.params as Record<string, unknown>) ?? {}) };
    for (const p of a.lists.param) setParam(params, p);
    spec.params = params;
  }
  return spec as JobSpecInput;
}

// --- commands ----------------------------------------------------------------------------

async function devices(client: FleetClient, a: Args) {
  const page = await client.listDevices({
    status: a.flags.all ? undefined : "online",
    platform: str(a, "platform"),
    pool: str(a, "pool"),
    q: a.positional[0],
    per_page: 500,
  });
  if (a.flags.json) return printJson(page), EXIT.passed;
  if (!page.items.length) {
    err(a.flags.all ? "no devices" : "no devices online (--all shows the rest of the shelf)");
    return EXIT.passed;
  }
  table(
    page.items.map((d) => {
      const ds = d.descriptor as Record<string, unknown>;
      return [d.device_id, d.status, d.platform, String(ds.model ?? ""), String(ds.os ?? ""), d.pools.join(","), d.current_job ?? "", ago(d.last_seen)];
    }),
    ["DEVICE", "STATUS", "PLATFORM", "MODEL", "OS", "POOLS", "RUNNING", "SEEN"],
  );
  return EXIT.passed;
}

async function workloads(client: FleetClient, a: Args) {
  if (a.positional[0]) {
    const w = await client.getWorkload(a.positional[0]);
    if (a.flags.json) return printJson(w), EXIT.passed;
    out(`${w.name}  (${w.executor}, ${w.status}${w.dangerous ? ", dangerous" : ""})  ${w.available ? `${w.agents} live` : "nothing live can run it"}`);
    out(`  ${w.summary}`);
    if (w.docs) out(`  ${w.docs}`);
    if (w.params) out(`params schema:\n${JSON.stringify(w.params, null, 2)}`);
    if (w.example) out(`example spec (fleet run --spec FILE):\n${JSON.stringify(w.example, null, 2)}`);
    return EXIT.passed;
  }
  const page = await client.listWorkloads(a.flags.available ? { available: true } : undefined);
  if (a.flags.json) return printJson(page), EXIT.passed;
  table(page.items.map((w) => [w.name, w.executor, w.available ? `${w.agents} live` : "-", w.status === "shipped" ? "" : w.status, w.summary.slice(0, 70)]), ["WORKLOAD", "EXECUTOR", "LIVE", "", "SUMMARY"]);
  return EXIT.passed;
}

async function run(client: FleetClient, a: Args) {
  const spec = await buildSpec(client, a);
  if (a.flags["no-validate"] !== true) {
    const v = await client.validateJob(spec);
    if (!v.valid || a.flags.validate) {
      if (a.flags.json) printJson(v);
      else if (!v.valid) {
        err(`invalid: ${v.error?.message ?? "the spec was refused"}${v.error?.hint ? `\n  hint: ${v.error.hint}` : ""}`);
        for (const e of v.schema_errors ?? []) err(`  ${e.path}  ${e.message}`);
      } else {
        out(`valid. would be ${v.status}${v.fanout ? `, fanned out to ${v.fanout.length}` : ""}`);
        if (v.candidates?.length) out(`devices: ${v.candidates.map((c) => c.device_id).join(", ")}`);
        for (const w of v.warnings ?? []) out(`warning: ${w}`);
        out(JSON.stringify(v.spec, null, 2));
      }
      return v.valid ? EXIT.passed : EXIT.usage;
    }
    for (const w of v.warnings ?? []) err(`warning: ${w}`);
  }
  const created = await client.createJob(spec);
  if (a.flags["no-wait"] === true) {
    if (a.flags.json) printJson(created);
    else out(created.job_id);
    return EXIT.passed;
  }
  err(`queued ${created.job_id}${created.fanout ? ` across ${created.fanout.length} devices` : ""}`);
  const s = await waitFor(client, created.job_id, num(a, "timeout", 1800), !!a.flags.json);
  if (a.flags.json) printJson(s);
  else printSummary(s);
  return verdictExit(s);
}

async function job(client: FleetClient, a: Args, wait: boolean) {
  const id = a.positional[0];
  if (!id) throw new UsageError(`usage: fleet ${wait ? "wait" : "job"} <job_id>`);
  const s = wait ? await waitFor(client, id, num(a, "timeout", 1800), !!a.flags.json) : await client.getJobSummary(id);
  if (a.flags.json) printJson(s);
  else printSummary(s);
  return verdictExit(s);
}

async function results(client: FleetClient, a: Args) {
  const page = await client.listResults({
    device: str(a, "device"), workload: str(a, "workload"), job: str(a, "job") ?? a.positional[0],
    final: str(a, "job") || a.positional[0] ? undefined : true,
    ok: a.flags.failures ? false : undefined,
    per_page: num(a, "limit", 20),
  });
  if (a.flags.json) return printJson(page), EXIT.passed;
  table(page.items.map((r) => [ago(r.created_at), r.job_id, r.device_id, r.workload, r.skipped ? "skipped" : r.ok ? "ok" : "FAILED", (r.error ?? "").split("\n")[0].slice(0, 60)]), ["WHEN", "JOB", "DEVICE", "WORKLOAD", "", "ERROR"]);
  return EXIT.passed;
}

async function flaky(client: FleetClient, a: Args) {
  const page = await client.listFlaky({ device: str(a, "device"), app: str(a, "app") });
  if (a.flags.json) return printJson(page), EXIT.passed;
  if (!page.items.length) {
    err("nothing flaky: no build has both passed and failed on the same device");
    return EXIT.passed;
  }
  table(page.items.map((f) => [f.build, f.device_id, `${f.passes}/${f.runs}`, f.latest.ok ? "ok" : "FAILED", f.latest.job_id]), ["BUILD", "DEVICE", "PASSED", "LATEST", "JOB"]);
  return EXIT.passed;
}

async function artifact(client: FleetClient, a: Args) {
  const sha = a.positional[0];
  if (!sha) throw new UsageError("usage: fleet artifact <sha256> [--out FILE|-]");
  const meta = await client.getArtifact(sha);
  const dest = str(a, "out");
  if (!dest) {
    if (a.flags.json) printJson(meta);
    else table([["name", meta.name], ["size", meta.size], ["media type", meta.media_type], ["app", [meta.app, meta.build].filter(Boolean).join(" ")], ["created", meta.created_at], ["in store", String(meta.in_store)]]);
    return EXIT.passed;
  }
  const res = await client.getArtifactContent(sha, undefined, { timeoutMs: 600_000 });
  if (!res.body) throw new Error("empty response");
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (dest === "-") await pipeline(body, process.stdout);
  else {
    const file = existsSync(dest) && !path.extname(dest) ? path.join(dest, meta.name ?? sha) : dest;
    await pipeline(body, createWriteStream(file));
    err(`wrote ${file} (${meta.size} bytes)`);
  }
  return EXIT.passed;
}

async function whoami(client: FleetClient, a: Args) {
  const [me, health] = await Promise.all([client.whoami(), client.getHealth()]);
  if (a.flags.json) return printJson({ ...me, url: client.baseUrl, version: health.version }), EXIT.passed;
  out(`${client.baseUrl}  ${health.name} ${health.version}`);
  out(`auth     ${me.auth}${me.auth === "tokens" ? ` (runner protocol ${me.protocol})` : ""}`);
  out(`you      ${me.actor ?? "(anonymous)"}${me.verified ? "" : me.actor ? " (unverified)" : ""}`);
  out(`scopes   ${me.scopes.join(", ") || "none"}`);
  return EXIT.passed;
}

async function login(a: Args) {
  const url = resolveBrain(str(a, "url"));
  let token = str(a, "token");
  if (!token) {
    if (process.stdin.isTTY) process.stderr.write(`token for ${url}: `);
    token = readFileSync(0, "utf8").trim().split("\n")[0]?.trim();
  }
  if (!token) throw new UsageError("no token given (--token, or on stdin)");
  const client = connect({ url, token, source: "cli" });
  const me = await client.whoami();
  if (me.auth === "tokens" && me.scopes.length === 0) {
    err(`${url} did not accept that token.`);
    return EXIT.error;
  }
  const creds = readCredentials();
  creds.collectors[url] = { token, name: me.token?.name ?? null, saved_at: new Date().toISOString() };
  const file = writeCredentials(creds);
  out(`saved for ${url} in ${file}${me.auth === "off" ? " (note: this collector has auth off, so the token is not needed yet)" : `; you are ${me.actor} with ${me.scopes.join(", ")}`}`);
  return EXIT.passed;
}

function logout(a: Args) {
  const url = resolveBrain(str(a, "url"));
  const creds = readCredentials();
  if (!creds.collectors[url]) {
    err(`no saved token for ${url}`);
    return EXIT.passed;
  }
  delete creds.collectors[url];
  writeCredentials(creds);
  out(`forgot the token for ${url}`);
  return EXIT.passed;
}

/** The tokens file the brain on this machine reads. */
function tokensFile(a: Args): string {
  if (str(a, "tokens-file")) return str(a, "tokens-file")!;
  const env = childEnv("brain", load());
  return env.FLEET_TOKENS_FILE ?? path.join(env.FLEET_DATA_DIR ?? path.resolve("data"), "tokens.json");
}

async function token(a: Args) {
  const { createToken, readTokenFile, revokeToken, SCOPES } = await import("../../collector/src/auth.js");
  const [action, name] = a.positional;
  const file = tokensFile(a);
  if (action === "create") {
    if (!name || !str(a, "scope")) throw new UsageError(`usage: fleet token create <name> --scope ${SCOPES.join(",")} [--expires-days N]`);
    const { token: secret, record } = createToken(
      { name, scopes: str(a, "scope")!.split(",").map((s) => s.trim()).filter(Boolean), expiresDays: str(a, "expires-days") ? num(a, "expires-days", 0) : undefined },
      file,
    );
    if (a.flags.json) printJson({ token: secret, ...record, hash: undefined, file });
    else {
      out(secret);
      err(`created ${record.name} (${record.scopes.join(", ")}) in ${file}. This is the only time the token is shown.`);
      err("The collector picks it up within a second; it needs FLEET_AUTH=tokens to require it.");
    }
    return EXIT.passed;
  }
  if (action === "list" || action === undefined) {
    const { tokens } = readTokenFile(file);
    if (a.flags.json) return printJson(tokens.map(({ hash: _h, ...t }) => t)), EXIT.passed;
    if (!tokens.length) err(`no tokens in ${file}`);
    else table(tokens.map((t) => [t.id, t.name, t.scopes.join(","), t.created_at.slice(0, 10), t.revoked_at ? `revoked ${t.revoked_at.slice(0, 10)}` : t.expires_at ? `expires ${t.expires_at.slice(0, 10)}` : ""]), ["ID", "NAME", "SCOPES", "CREATED", ""]);
    return EXIT.passed;
  }
  if (action === "revoke") {
    if (!name) throw new UsageError("usage: fleet token revoke <id|name>");
    const n = revokeToken(name, file);
    if (!n) {
      err(`no live token ${name} in ${file}`);
      return EXIT.error;
    }
    out(`revoked ${n} token${n === 1 ? "" : "s"}; the collector stops accepting it within a second`);
    return EXIT.passed;
  }
  throw new UsageError("usage: fleet token create|list|revoke");
}

export function skillText(): string {
  const file = path.join(assetRoot() ?? repoRoot(), "skills/fleet-runner/SKILL.md");
  return readFileSync(file, "utf8");
}

/** Where each coding agent looks for user-level skills. */
const SKILL_HOMES: Record<string, string> = {
  cursor: path.join(homedir(), ".cursor", "skills"),
  claude: path.join(homedir(), ".claude", "skills"),
  codex: path.join(homedir(), ".codex", "skills"),
};

function skill(a: Args) {
  const [action] = a.positional;
  if (action === "show" || action === undefined) {
    out(skillText());
    return EXIT.passed;
  }
  if (action !== "install") throw new UsageError("usage: fleet skill show|install [--target cursor,claude,codex|DIR]");
  // --target is a repeated flag (for `run`), so it arrives as a list here too.
  const targets = (a.lists.target ?? []).flatMap((t) => t.split(",")).map((s) => s.trim()).filter(Boolean);
  const wanted = targets.length ? targets : Object.keys(SKILL_HOMES).filter((k) => existsSync(path.dirname(SKILL_HOMES[k])));
  if (!wanted.length) throw new UsageError("no coding agent found (~/.cursor, ~/.claude, ~/.codex); pass --target DIR");
  const text = skillText();
  for (const t of wanted) {
    const dir = path.join(SKILL_HOMES[t] ?? path.resolve(t), "fleet-runner");
    const file = path.join(dir, "SKILL.md");
    if (existsSync(file) && readFileSync(file, "utf8") === text) {
      out(`up to date  ${file}`);
      continue;
    }
    if (existsSync(file) && a.flags.force !== true && !readFileSync(file, "utf8").includes("<!-- fleet-runner skill")) {
      err(`not overwriting ${file}: it was not written by fleet (use --force)`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    out(`installed   ${file}`);
  }
  return EXIT.passed;
}

export const WORK_USAGE = `
  fleet devices [--all] [--platform P] [--pool P]     What is on the shelf.
  fleet workloads [NAME] [--available]                What it can run; NAME prints an example spec.
  fleet run WORKLOAD [--device ID|--pool P|--match EXPR] [--app NAME] [--param k=v]...
            [--spec FILE|-] [--fanout] [--validate] [--no-wait] [--timeout S]
                          Validate, queue, wait, print the verdict. Exit code is the verdict.
  fleet job ID | fleet wait ID [--timeout S]          A job's verdict, now or when it finishes.
  fleet cancel ID [--reason R] | fleet retry ID [--device ID] [--pool P]
  fleet results [--device ID] [--workload W] [--job ID] [--failures] [--limit N]
  fleet flaky [--device ID] [--app NAME]               UI tests that pass and fail on the same build.
  fleet artifact SHA [--out FILE|-]                    Describe or download an artifact.
  fleet login [--url U] [--token T] | fleet logout | fleet whoami
  fleet token create NAME --scope read,run,admin,agent,delegate | list | revoke ID|NAME
  fleet skill show | fleet skill install [--target cursor,claude,codex|DIR]

  Every work command takes --url, --token and --json.
  Exit codes: 0 passed, 1 failed, 2 usage/invalid spec, 3 still running, 4 skipped (nothing ran), 5 refused/unreachable.
`;

export const WORK_COMMANDS = new Set(["devices", "workloads", "run", "job", "wait", "cancel", "retry", "results", "flaky", "artifact", "login", "logout", "whoami", "token", "skill"]);

export async function workCommand(command: string, argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  try {
    if (command === "login") return await login(a);
    if (command === "logout") return logout(a);
    if (command === "token") return await token(a);
    if (command === "skill") return skill(a);
    const client = connect({ url: str(a, "url"), token: str(a, "token"), source: "cli" });
    switch (command) {
      case "devices": return await devices(client, a);
      case "workloads": return await workloads(client, a);
      case "run": return await run(client, a);
      case "job": return await job(client, a, false);
      case "wait": return await job(client, a, true);
      case "results": return await results(client, a);
      case "flaky": return await flaky(client, a);
      case "artifact": return await artifact(client, a);
      case "whoami": return await whoami(client, a);
      case "cancel": {
        if (!a.positional[0]) throw new UsageError("usage: fleet cancel <job_id> [--reason R]");
        const r = await client.cancelJob(a.positional[0], str(a, "reason") ? { reason: str(a, "reason") } : undefined);
        if (a.flags.json) printJson(r);
        else out(`cancelled ${r.cancelled.join(", ") || "nothing"}${r.cascaded.length ? `; also failed (waiting on it): ${r.cascaded.join(", ")}` : ""}\n${r.note}`);
        return EXIT.passed;
      }
      case "retry": {
        if (!a.positional[0]) throw new UsageError("usage: fleet retry <job_id> [--device ID] [--pool P] [--wait]");
        const body: Record<string, string> = {};
        if (str(a, "device")) body.device_id = str(a, "device")!;
        if (str(a, "pool")) body.pool = str(a, "pool")!;
        const r = await client.retryJob(a.positional[0], body);
        if (!a.flags.wait) {
          if (a.flags.json) printJson(r);
          else out(r.job_id);
          return EXIT.passed;
        }
        const s = await waitFor(client, r.job_id, num(a, "timeout", 1800), !!a.flags.json);
        if (a.flags.json) printJson(s);
        else printSummary(s);
        return verdictExit(s);
      }
    }
    throw new UsageError(`unknown command ${command}`);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      return EXIT.usage;
    }
    if (e instanceof FleetApiError) {
      if (a.flags.json) printJson({ error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.details ? { details: e.details } : {}) } });
      else {
        err(`${e.code}: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ""}`);
        const se = (e.details as { schema_errors?: { path: string; message: string }[] } | undefined)?.schema_errors;
        for (const x of se ?? []) err(`  ${x.path}  ${x.message}`);
        if (e.code === "unauthorized") err("  `fleet login` saves a token for this collector.");
      }
      return e.code === "invalid_spec" || e.code === "bad_request" ? EXIT.usage : EXIT.error;
    }
    throw e;
  }
}
