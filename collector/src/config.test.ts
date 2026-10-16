/**
 * The environment knobs that used to go through a bare `Number()`.
 *
 * Every case is a value somebody could plausibly type. The failure being
 * guarded against is quiet: `FLEET_SWEEP_MS=15` (seconds, meant) was a sweep
 * every 15 ms, and `15s` was NaN, which `setInterval` treats as 1 ms.
 */
import { intervalMs, intervalWarnings, MIN_INTERVAL_MS, parsePeerTokens, peerKey } from "./config.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

export function runConfigChecks(check: Check) {
  const read = (v: string | undefined) => intervalMs({ X: v }, "X", 15_000);

  check("an unset interval is the default, with no warning", read(undefined).ms === 15_000 && read(undefined).warning === null);
  check("an empty interval is the default, with no warning", read("").ms === 15_000 && read("").warning === null);
  check("a sensible interval is used", read("60000").ms === 60_000 && read("60000").warning === null);
  check("the floor itself is allowed", read(String(MIN_INTERVAL_MS)).ms === MIN_INTERVAL_MS);
  for (const bad of ["15", "0", "-5000", "15s", "abc", "1500.5", "Infinity"]) {
    const r = read(bad);
    check(`${JSON.stringify(bad)} falls back to the default and says why`, r.ms === 15_000 && !!r.warning?.includes("X="), JSON.stringify(r));
  }
  const w = intervalWarnings({ FLEET_SWEEP_MS: "15", FLEET_SCHEDULER_TICK_MS: "20000", FLEET_ALERT_TICK_MS: "1m" });
  check("startup warns about each bad interval and only those",
    w.length === 2 && w.some((x) => x.startsWith("FLEET_SWEEP_MS=15")) && w.some((x) => x.startsWith("FLEET_ALERT_TICK_MS=1m")), JSON.stringify(w));
  check("no warnings for an environment that sets none", intervalWarnings({}).length === 0);

  // FLEET_PEER_TOKENS: one token per peer, keyed the way FLEET_PEERS spells it.
  const ok = parsePeerTokens('{"http://fleet-host:8788/": "fr_abc", "http://work:8788": "fr_def"}');
  check("peer tokens are keyed by URL without a trailing slash",
    ok.error === null && ok.tokens["http://fleet-host:8788"] === "fr_abc" && ok.tokens[peerKey("http://work:8788/")] === "fr_def", JSON.stringify(ok));
  check("no peer tokens is no error", parsePeerTokens(undefined).error === null && Object.keys(parsePeerTokens("").tokens).length === 0);
  const notJson = parsePeerTokens("fr_abc");
  check("a bare token is refused, not sent to every peer", Object.keys(notJson.tokens).length === 0 && !!notJson.error, JSON.stringify(notJson));
  const arr = parsePeerTokens('["fr_abc"]');
  check("an array is refused", Object.keys(arr.tokens).length === 0 && !!arr.error);
  const partial = parsePeerTokens('{"http://a:8788": "fr_a", "http://b:8788": 42, "http://c:8788": "has space"}');
  check("unusable entries are named and the rest kept",
    partial.tokens["http://a:8788"] === "fr_a" && !partial.tokens["http://b:8788"] && !partial.tokens["http://c:8788"] &&
      !!partial.error?.includes("http://b:8788") && !!partial.error?.includes("http://c:8788"), JSON.stringify(partial));
}
