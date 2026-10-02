// Every environment knob in one place. Both the collector and the dashboard
// API need these paths, and two copies of `path.resolve("artifacts/store")`
// would drift the first time someone changed a default.
//
// ## Why these are `let`
//
// They used to be `const`, read from `process.env` when the module was first
// imported. That is right for a program you start with `npm start` and wrong
// for one that is also a library: `fleet up` decides where a brain's data lives
// from `~/.fleet/config.json`, and a test wants a throwaway directory, and
// neither can set an environment variable after the module has been read.
//
// So they are live bindings that `configure()` reassigns. Every importer sees
// the new value, because that is what an ESM named export of a `let` does --
// the binding is shared, not copied. The one rule is that `configure()` has to
// run before anything *uses* a value it changes, which is why it refuses once
// the collector has started rather than quietly having no effect.
import path from "node:path";
import { hostname } from "node:os";

/** Everything settable, and the shape `fleet up` hands over. */
export type Settings = {
  port: number;
  bind: string[];
  tailnetAllowlist: string[];
  dataDir: string;
  artifactDir: string;
  powerConfigPath: string;
  sweepMs: number;
  schedulerTickMs: number;
  githubStatusArmed: boolean;
  githubToken: string | undefined;
  githubApi: string;
  logFile: string;
  dashDist: string;
  /** Off by default; `fleet up` turns it on. See src/discovery.ts. */
  discovery: boolean;
  /**
   * Other collectors this one knows about, for the dashboard's all-brains view.
   *
   * A list of addresses and nothing more: peers are read, never written to, and
   * never forwarded jobs. See src/api/peers.ts for why that restraint is the
   * design rather than a limitation.
   */
  peers: string[];
  /** This brain's display name. Null means "read it from the data directory". */
  name: string | null;
  /**
   * Where people open this dashboard, for links the collector sends OUT of
   * itself: the night-QA digest on a phone, an issue body on GitHub. The
   * dashboard's own links are relative and never need it.
   */
  dashUrl: string;
  /** Night QA (src/findings.ts): app name -> "owner/repo" an issue would go to. */
  findingsRepos: Record<string, string>;
  /** Why FLEET_FINDINGS_REPOS was ignored, when it was. Said, not swallowed. */
  findingsReposError: string | null;
  /** Filing issues is BUILT BUT OFF, exactly like commit statuses. */
  githubIssuesArmed: boolean;
  /** "HH:MM" local time to send the night-QA digest, or null for never. */
  findingsDigestAt: string | null;
  /** How far back the daily digest looks, in hours. */
  findingsDigestHours: number;
};

/**
 * FLEET_FINDINGS_REPOS, read strictly: a JSON object of app -> "owner/repo".
 *
 * A malformed value is not guessed at. It maps nothing and the reason is kept,
 * because the cost of being lenient here is an issue filed against whichever
 * repository a typo happened to spell.
 */
export function parseFindingsRepos(raw: string | undefined): { repos: Record<string, string>; error: string | null } {
  if (!raw || !raw.trim()) return { repos: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { repos: {}, error: `FLEET_FINDINGS_REPOS is not JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { repos: {}, error: 'FLEET_FINDINGS_REPOS must be a JSON object of app -> "owner/repo"' };
  const repos: Record<string, string> = {};
  const bad: string[] = [];
  for (const [app, repo] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo)) repos[app] = repo;
    else bad.push(app);
  }
  return { repos, error: bad.length ? `FLEET_FINDINGS_REPOS: not "owner/repo" for ${bad.join(", ")}` : null };
}

const list = (raw: string | undefined, fallback = "") =>
  (raw ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** The defaults, as read from an environment. Exported for `fleet doctor`. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    port: Number(env.FLEET_PORT ?? 8788),
    /**
     * Which addresses the collector answers on. Comma-separated; the default is
     * every interface, which is what it has always done and what a LAN-only
     * fleet wants.
     *
     * It is a list because the useful posture has two entries and no wildcard:
     * a loopback address so the dashboard and the local executor keep working,
     * and the host's own tailnet address so roaming agents can reach it --
     * without the LAN, the guest network, or a hotel's wifi being able to. The
     * README's "no auth, LAN only" threat model stops being true the moment an
     * agent claims work from outside the house, and this is the knob that makes
     * it true again.
     *
     *   FLEET_BIND=127.0.0.1,100.x.y.z
     */
    bind: list(env.FLEET_BIND, "0.0.0.0"),
    /**
     * Tailnet nodes allowed to register as devices. Comma-separated; empty (the
     * default) checks nothing at all, which is the behaviour that existed
     * before.
     *
     * This fences the tailnet, not the house. A LAN peer is still governed by
     * the posture the README describes -- an allowlist that also fenced the
     * house would mean enabling it broke every phone on the shelf. See
     * src/tailnet.ts.
     *
     *   FLEET_TAILNET_ALLOWLIST=my-macbook,pixel-4a,fleet-host
     */
    tailnetAllowlist: list(env.FLEET_TAILNET_ALLOWLIST),
    dataDir: env.FLEET_DATA_DIR ?? path.resolve("data"),
    artifactDir: env.FLEET_ARTIFACT_DIR ?? path.resolve("artifacts/store"),
    powerConfigPath: env.FLEET_POWER_CONFIG ?? path.resolve("power.json"),
    sweepMs: Number(env.FLEET_SWEEP_MS ?? 15_000),
    schedulerTickMs: Number(env.FLEET_SCHEDULER_TICK_MS ?? 20_000),
    // CI integration is BUILT BUT OFF. Statuses are recorded (posted=0) unless
    // both are set: FLEET_GITHUB_STATUS=1 arms posting, FLEET_GITHUB_TOKEN
    // authenticates it.
    githubStatusArmed: env.FLEET_GITHUB_STATUS === "1",
    githubToken: env.FLEET_GITHUB_TOKEN,
    githubApi: env.FLEET_GITHUB_API ?? "https://api.github.com",
    // launchd sends both streams here and does not rotate it; the dashboard's
    // system page reports its size so it cannot quietly eat the disk. `fleet
    // service` overrides it with a path under ~/.fleet/logs that it does rotate.
    logFile: env.FLEET_LOG_FILE ?? path.join(env.HOME ?? "", "Library/Logs/fleet-collector.log"),
    // Built dashboard assets. Absent on a fresh checkout -- the collector serves
    // a build-me placeholder rather than failing to start.
    dashDist: env.FLEET_DASH_DIST ?? path.resolve("dash/dist"),
    // Advertising over mDNS is opt-in: a collector on a shared network should
    // not announce itself because somebody upgraded.
    discovery: env.FLEET_DISCOVERY === "1",
    peers: list(env.FLEET_PEERS),
    name: env.FLEET_NAME ?? null,
    // The host's own name rather than an address: it is what a phone on the
    // same network can usually resolve, and a link with a raw 192.168 address
    // in it is wrong the day DHCP hands out a different one.
    dashUrl: (env.FLEET_DASH_URL ?? `http://${hostname()}:${Number(env.FLEET_PORT ?? 8788)}`).replace(/\/+$/, ""),
    findingsRepos: parseFindingsRepos(env.FLEET_FINDINGS_REPOS).repos,
    findingsReposError: parseFindingsRepos(env.FLEET_FINDINGS_REPOS).error,
    // Fleet Runner stays disconnected from the app repositories until the owner
    // says otherwise. Issues are composed and recorded (dry_run) unless BOTH
    // are set: FLEET_GITHUB_ISSUES=1 arms filing, FLEET_GITHUB_TOKEN
    // authenticates it. Arming commit statuses does not arm this, nor the
    // reverse: they are separate decisions about separate kinds of noise.
    githubIssuesArmed: env.FLEET_GITHUB_ISSUES === "1",
    // Anything that is not a plain 24-hour HH:MM is off rather than guessed at:
    // "7:00" or "7am" sending at a surprising hour is worse than not sending.
    findingsDigestAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(env.FLEET_FINDINGS_DIGEST_AT ?? "")
      ? (env.FLEET_FINDINGS_DIGEST_AT as string)
      : null,
    // A day, so a daily send covers every finding exactly once.
    findingsDigestHours: Math.min(168, Math.max(1, Number(env.FLEET_FINDINGS_DIGEST_HOURS ?? 24) || 24)),
  };
}

let settings = fromEnv();
let frozen = false;

/**
 * Override settings before the collector starts.
 *
 * Refuses afterwards rather than quietly doing nothing: half the values here
 * are read once (the data directory, the bind list) and half on every request,
 * so a late `configure()` would apply to some and not others -- which is worse
 * than either.
 */
export function configure(overrides: Partial<Settings>): void {
  if (frozen) throw new Error("configure() must be called before the collector starts");
  settings = { ...settings, ...overrides };
  apply();
}

/** Called by `listen()`. After this, `configure()` throws. */
export function freezeConfig(): void {
  frozen = true;
}

/** Everything, as one object. `GET /api/system` reports parts of it. */
export function allSettings(): Readonly<Settings> {
  return settings;
}

// The live bindings. Declared here and assigned by apply(), so there is exactly
// one place that maps a Settings field to the name the rest of the code uses.
export let PORT: number;
export let BIND: string[];
export let TAILNET_ALLOWLIST: string[];
export let DATA_DIR: string;
export let ARTIFACT_DIR: string;
export let POWER_CONFIG_PATH: string;
export let SWEEP_MS: number;
export let SCHEDULER_TICK_MS: number;
export let GITHUB_STATUS_ARMED: boolean;
export let GITHUB_TOKEN: string | undefined;
export let GITHUB_API: string;
export let LOG_FILE: string;
export let DASH_DIST: string;
export let DISCOVERY: boolean;
export let PEERS: string[];
export let NAME: string | null;
export let DASH_URL: string;
export let FINDINGS_REPOS: Record<string, string>;
export let FINDINGS_REPOS_ERROR: string | null;
export let GITHUB_ISSUES_ARMED: boolean;
export let FINDINGS_DIGEST_AT: string | null;
export let FINDINGS_DIGEST_HOURS: number;

function apply(): void {
  PORT = settings.port;
  BIND = settings.bind;
  TAILNET_ALLOWLIST = settings.tailnetAllowlist;
  DATA_DIR = settings.dataDir;
  ARTIFACT_DIR = settings.artifactDir;
  POWER_CONFIG_PATH = settings.powerConfigPath;
  SWEEP_MS = settings.sweepMs;
  SCHEDULER_TICK_MS = settings.schedulerTickMs;
  GITHUB_STATUS_ARMED = settings.githubStatusArmed;
  GITHUB_TOKEN = settings.githubToken;
  GITHUB_API = settings.githubApi;
  LOG_FILE = settings.logFile;
  DASH_DIST = settings.dashDist;
  DISCOVERY = settings.discovery;
  PEERS = settings.peers;
  NAME = settings.name;
  DASH_URL = settings.dashUrl;
  FINDINGS_REPOS = settings.findingsRepos;
  FINDINGS_REPOS_ERROR = settings.findingsReposError;
  GITHUB_ISSUES_ARMED = settings.githubIssuesArmed;
  FINDINGS_DIGEST_AT = settings.findingsDigestAt;
  FINDINGS_DIGEST_HOURS = settings.findingsDigestHours;
}

apply();
