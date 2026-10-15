// Regenerate everything derived from the /api/v1 route table:
//
//   openapi.json            the contract, committed so a reviewer sees it move
//   src/client/api.gen.ts   the typed client the CLI, MCP server and dashboard use
//
// `--check` regenerates in memory and fails if either file differs, which is
// what `npm test` runs. Run without it after changing a route or a schema.
//
// The route table imports the database module, which opens nothing until asked
// -- but config reads its environment at import, so this points the data
// directory somewhere harmless before importing anything that reads it.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.FLEET_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "fleet-gen-"));
const { ROUTES, openapiDocument } = await import("../src/api/v1/index.js");
type Route = (typeof ROUTES)[number];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

type Schema = Record<string, any>;

// --- JSON Schema to TypeScript ------------------------------------------------------
//
// Only what the schemas here use. A construct it does not know becomes
// `unknown`, which is honest and still compiles.

const ident = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function doc(s: Schema, indent: string): string {
  const text = [s.description, s.title && !s.description ? s.title : null].filter(Boolean).join(" ");
  if (!text) return "";
  return `${indent}/** ${String(text).replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim()} */\n`;
}

function tsType(s: Schema | undefined, indent = ""): string {
  if (!s || typeof s !== "object") return "unknown";
  if (s.$ref) return String(s.$ref).split("/").pop()!;
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.oneOf || s.anyOf) {
    const parts = [...new Set((s.oneOf ?? s.anyOf).map((x: Schema) => tsType({ ...withoutUnions(s), ...x }, indent)))];
    return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" | ")})`;
  }
  if (s.allOf) return s.allOf.map((x: Schema) => tsType(x, indent)).join(" & ");
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length > 1) return types.map((t) => tsType({ ...s, type: t }, indent)).join(" | ");
  switch (types[0]) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `${wrap(tsType(s.items, indent))}[]`;
    case "object":
    case undefined: {
      if (!s.properties) return types[0] === "object" || s.additionalProperties ? "Record<string, unknown>" : "unknown";
      const req = new Set<string>(s.required ?? []);
      const inner = indent + "  ";
      const lines = Object.entries(s.properties as Record<string, Schema>).map(
        ([k, v]) => `${doc(v, inner)}${inner}${ident(k)}${req.has(k) ? "" : "?"}: ${tsType(v, inner)};`,
      );
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default: return "unknown";
  }
}

const withoutUnions = (s: Schema) => {
  const { oneOf: _o, anyOf: _a, description: _d, ...rest } = s;
  return rest;
};
const wrap = (t: string) => (/[|&\s]/.test(t) && !t.startsWith("{") && !t.startsWith("(") ? `(${t})` : t);

// --- the client ------------------------------------------------------------------------

function responseType(r: Route): string {
  const ok = r.responses.find((x) => x.status >= 200 && x.status < 300);
  if (!ok?.schema) return ok?.contentType && ok.contentType !== "application/json" ? "Response" : "Record<string, unknown>";
  return ok.schema.startsWith("list:") ? `${ok.schema.slice(5)}List` : ok.schema;
}

function queryType(r: Route): string | null {
  const q = (r.params ?? []).filter((p) => p.in === "query");
  if (!q.length) return null;
  const t = (p: (typeof q)[number]) => (p.enum ? p.enum.map((v) => JSON.stringify(v)).join(" | ") : p.type === "integer" ? "number" : p.type);
  return `{ ${q.map((p) => `${ident(p.name)}?: ${t(p)}`).join("; ")} }`;
}

function method(r: Route): string {
  const pathParams = (r.params ?? []).filter((p) => p.in === "path");
  const args: string[] = pathParams.map((p) => `${p.name}: string`);
  if (r.body) args.push(`body${r.body.required ? "" : "?"}: ${r.body.schema}`);
  const q = queryType(r);
  if (q) args.push(`query?: ${q}`);
  args.push("opts?: CallOptions");
  const url = "`" + r.path.replace(/\{(\w+)\}/g, (_m, n) => `\${enc(${n})}`) + "`";
  const ret = responseType(r);
  const extra: string[] = [];
  if (r.body) extra.push("body");
  if (q) extra.push("query");
  if (ret === "Response") extra.push("raw: true");
  if (r.operationId === "waitJob") extra.push("timeoutMs: (opts?.timeoutMs ?? 30_000) + 1000 * Number(query?.timeout_s ?? 30)");
  const call = `this.request<${ret}>("${r.method}", ${url}, { ...opts${extra.length ? `, ${extra.join(", ")}` : ""} })`;
  const lines = [`  /**`, `   * ${r.summary}`];
  if (r.description) lines.push(`   *`, ...r.description.match(/.{1,100}(\s|$)/g)!.map((l) => `   * ${l.trim()}`));
  lines.push(`   *`, `   * \`${r.method} ${r.path}\` · scope: ${r.scope}`, `   */`);
  lines.push(`  ${r.operationId}(${args.join(", ")}): Promise<${ret}> {`, `    return ${call};`, `  }`);
  return lines.join("\n");
}

function client(spec: ReturnType<typeof openapiDocument>): string {
  const schemas = spec.components.schemas as Record<string, Schema>;
  const types = Object.entries(schemas).map(([name, s]) => `${doc(s, "")}export type ${name} = ${tsType(s)};`);
  const methods = ROUTES.filter((r) => !r.documentOnly).map(method);
  return `// GENERATED by scripts/gen-api.ts from the /api/v1 route table. Do not edit;
// change src/api/v1/{routes,schemas}.ts and run \`npx tsx scripts/gen-api.ts\`.
/* eslint-disable */
import { Transport, enc, type RequestOptions } from "./transport.js";

export type CallOptions = Pick<RequestOptions, "timeoutMs" | "signal">;

${types.join("\n\n")}

/** Every /api/v1 operation, one method each, named by operationId. */
export class FleetClient extends Transport {
${methods.join("\n\n")}
}
`;
}

// --- write or compare ----------------------------------------------------------------------

const spec = openapiDocument();
const outputs: [string, string][] = [
  [path.join(ROOT, "openapi.json"), `${JSON.stringify(spec, null, 2)}\n`],
  [path.join(ROOT, "src/client/api.gen.ts"), client(spec)],
];

let stale = 0;
for (const [file, content] of outputs) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch { /* missing is stale */ }
  if (current === content) {
    console.log(`  ok    ${path.relative(ROOT, file)}`);
    continue;
  }
  if (CHECK) {
    stale++;
    console.error(`  STALE ${path.relative(ROOT, file)} -- run \`npx tsx scripts/gen-api.ts\` and commit the result`);
  } else {
    writeFileSync(file, content);
    console.log(`  wrote ${path.relative(ROOT, file)}`);
  }
}
process.exit(stale ? 1 : 0);
