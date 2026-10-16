/**
 * Reading a JUnit report: how many passed, how many failed, and what failed.
 *
 * Maestro writes one `<testcase>` per flow with a `<failure>` inside naming the
 * step that broke (`Assertion is false: "Fleet Runner" is visible`). The counts
 * were always read; the failure was not, so a failing ui-test posted
 * `failed: 1` and no reason while the reason sat in the report it uploaded.
 *
 * Regexes, not an XML parser: the reports come from a handful of known tools,
 * the same pragmatism the counts have always had, and a dependency for one
 * element would be a poor trade.
 */

export type JunitFailure = { name: string; message: string };
export type JunitSummary = { passed: number; failed: number; failures: JunitFailure[] };

const ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(quot|apos|lt|gt|amp);/g, (_m, e: string) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : null;
};

/**
 * Counts and failures. A report with no recognisable counts is one failure:
 * a run that produced garbage did not pass. Counts come from the first
 * `tests`/`failures` pair (Maestro's `<testsuite>`); `errors` count as
 * failures, because an errored flow did not pass either.
 */
export function parseJunit(xml: string): JunitSummary {
  const failures: JunitFailure[] = [];
  for (const tc of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = tc[2] ?? "";
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!f) continue;
    const text = decode((f[3] ?? "").trim());
    const message = (text || attr(f[2], "message") || attr(f[2], "type") || f[1]).trim();
    failures.push({ name: attr(tc[1], "name") ?? attr(tc[1], "id") ?? "test", message });
  }

  const suite = /<testsuite\b[^>]*>/.exec(xml)?.[0] ?? /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? "";
  const tests = Number(attr(suite, "tests"));
  if (!suite || !Number.isFinite(tests)) {
    return failures.length ? { passed: 0, failed: failures.length, failures } : { passed: 0, failed: 1, failures };
  }
  const failed = Number(attr(suite, "failures") ?? 0) + Number(attr(suite, "errors") ?? 0);
  return { passed: Math.max(0, tests - failed), failed: Math.max(failed, failures.length), failures };
}

/**
 * One line for the result's `error`: the first failing test and its step, and
 * how many more there were. Null when nothing failed.
 */
export function junitFailureReason(s: JunitSummary, max = 300): string | null {
  if (s.failed === 0) return null;
  const first = s.failures[0];
  let line: string;
  if (!first) line = `${s.failed} of ${s.passed + s.failed} failed; the report names no failing step`;
  else {
    const msg = first.message.split("\n").map((l) => l.trim()).find(Boolean) ?? "failed";
    line = `${first.name}: ${msg}`;
    if (s.failed > 1) line += ` (and ${s.failed - 1} more failing)`;
  }
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
