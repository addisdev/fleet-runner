/**
 * Which collector, with which token: the one decision every work command and
 * the MCP server make before their first request.
 *
 * The URL comes from a flag, then FLEET_RUNNER_URL, then FLEET_URL, then the
 * config (see resolveBrain). The token from a flag, then FLEET_RUNNER_TOKEN,
 * then FLEET_TOKEN, then what `fleet login` saved for that URL. The
 * FLEET_RUNNER_ names exist because other tools also read FLEET_URL and
 * FLEET_TOKEN, and a shell set up for one of them must not send this CLI, or
 * its token, somewhere else. Saved tokens are keyed by URL because a person
 * with a laptop brain and a lab brain holds a different token for each, and
 * sending one collector's token to another is a leak, not a convenience.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FleetClient } from "../../collector/src/client/index.js";
import { agentCollectors, load } from "./config.js";
import { fleetHome } from "./paths.js";

/** Which brain to talk to: a flag, then the environment, then the config. */
export function resolveBrain(flagUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flagUrl) return flagUrl.replace(/\/+$/, "");
  const fromEnv = env.FLEET_RUNNER_URL || env.FLEET_URL;
  if (fromEnv) return fromEnv.split(",")[0].trim().replace(/\/+$/, "");
  const config = load(env);
  const url = config.executor.collector ?? agentCollectors(config)[0] ?? `http://127.0.0.1:${config.collector.port}`;
  return url.replace(/\/+$/, "");
}

type Credentials = { collectors: Record<string, { token: string; name?: string | null; saved_at: string }> };

export const credentialsFile = (env: NodeJS.ProcessEnv = process.env) => path.join(fleetHome(env), "credentials.json");

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(env), "utf8")) as Partial<Credentials>;
    return { collectors: parsed.collectors && typeof parsed.collectors === "object" ? parsed.collectors : {} };
  } catch {
    return { collectors: {} };
  }
}

/** Written 0600, beside and renamed over, like the collector's tokens file. */
export function writeCredentials(data: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch { /* Windows: ACLs, not modes */ }
  return file;
}

export function savedToken(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return readCredentials(env).collectors[url.replace(/\/+$/, "")]?.token ?? null;
}

export function resolveToken(url: string, flagToken: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  return flagToken || env.FLEET_RUNNER_TOKEN?.trim() || env.FLEET_TOKEN?.trim() || savedToken(url, env);
}

/** A client for the resolved collector, saying which front door it is. */
export function connect(
  opts: { url?: string; token?: string; source: string; actor?: string | null; timeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): FleetClient {
  const baseUrl = resolveBrain(opts.url, env);
  return new FleetClient({
    baseUrl,
    token: resolveToken(baseUrl, opts.token, env),
    source: env.FLEET_SOURCE ?? opts.source,
    actor: opts.actor ?? null,
    timeoutMs: opts.timeoutMs,
  });
}
