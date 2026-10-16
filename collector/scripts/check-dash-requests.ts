// The dashboard makes no request the deprecation headers mark.
//
// The dashboard reads devices and jobs through the generated /api/v1 client.
// Nothing stops a new screen from reaching for `useApi("/api/jobs")` again, and
// it would work -- the old routes keep answering -- so the only place it would
// show is a Deprecation header nobody reads. This reads the dashboard's source
// and holds every request it can see against the same table that sets those
// headers (src/api/v1/deprecations.ts).
//
// Text, not a type check: a request is a string literal handed to useApi,
// fetch or mutate, and template holes (`${id}`) stand for one path segment.
// Usage: tsx scripts/check-dash-requests.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUCCESSORS } from "../src/api/v1/deprecations.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH = path.join(ROOT, "dash/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/**
 * A literal as the request path it becomes. A hole after a slash is one
 * segment (`/api/jobs/${id}`); a hole glued to a segment is a query string
 * being appended (`/api/jobs${qs}`), so it goes, as does a literal query.
 */
const asPath = (lit: string) => lit.replace(/(\/)?\$\{[^}]*\}/g, (_m, slash) => (slash ? "/x" : "")).split("?")[0];

type Request = { file: string; line: number; method: string; path: string };
const requests: Request[] = [];

for (const file of sources(DASH)) {
  const src = readFileSync(file, "utf8");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const seen = new Set<number>();
  const add = (i: number, method: string, lit: string) => {
    seen.add(i);
    requests.push({ file: path.relative(ROOT, file), line: lineOf(i), method, path: asPath(lit) });
  };
  // mutate("POST", "/api/...") says its method.
  for (const m of src.matchAll(/mutate(?:<[^>]*>)?\(\s*"(POST|PATCH|DELETE)"\s*,\s*(["'`])(.*?)\2/g))
    add(m.index! + m[0].lastIndexOf(m[3]) - 1, m[1], m[3]);
  // fetch("...") without a method is a GET; with one, take it.
  for (const m of src.matchAll(/fetch\(\s*(["'`])(.*?)\1\s*(,\s*\{[^}]*?method:\s*"(\w+)")?/g))
    add(m.index! + m[0].indexOf(m[2]) - 1, m[4] ?? "GET", m[2]);
  // Anything else that names an unversioned API path is read: useApi, an
  // <img src>, the EventSource.
  for (const m of src.matchAll(/(["'`])(\/api\/(?!v1\/)(?:[^"'`\s$]|\$\{[^}]*\})*)/g)) if (!seen.has(m.index!)) add(m.index!, "GET", m[2]);
}

let failures = 0;
for (const r of requests) {
  const hit = SUCCESSORS.find(([method, re]) => method === r.method && re.test(r.path));
  if (!hit) continue;
  failures++;
  const m = hit[1].exec(r.path)!;
  console.error(`  FAIL  ${r.file}:${r.line} ${r.method} ${r.path} is deprecated -- use ${hit[2](m)} through dash/src/client.ts`);
}

// A scan that finds nothing is a scan that stopped working, not a clean bill.
if (requests.length < 20) {
  failures++;
  console.error(`  FAIL  found only ${requests.length} requests in dash/src -- this check needs updating`);
}
console.log(failures ? `\n${failures} FAILED` : `  ok — ${requests.length} requests in dash/src, none deprecated`);
process.exit(failures ? 1 : 0);
