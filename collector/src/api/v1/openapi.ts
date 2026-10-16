/**
 * The OpenAPI 3.1 document, built from the route table.
 *
 * Served at /api/v1/openapi.json and committed as collector/openapi.json, which
 * `npm test` regenerates and compares: a change to the API that is not a change
 * to that file fails the build, so a reviewer sees the contract move in the diff.
 *
 * Built by hand rather than by a plugin because the table already holds every
 * fact a plugin would ask for, and OpenAPI 3.1's schema dialect is JSON Schema
 * 2020-12 -- the same dialect the job schema is written in -- so the schemas
 * drop in unchanged.
 */
import { APP_VERSION } from "../../version.js";
import { ROUTES, type Param, type Response, type Route } from "./routes.js";
import { listOf, SCHEMAS } from "./schemas.js";

const DESCRIPTION = `The Fleet Runner control API.

Every list is \`{items, page, per_page, total, pages}\`. Every failure is
\`{error: {code, message, hint?}}\`; branch on \`code\`. Timestamps are ISO 8601 UTC.

The usual sequence for running something: listWorkloads (pick one, copy its
example), validateJob (fix what it says), createJob, waitJob until
\`finished\`, then read \`verdict\`. \`skipped\` means nothing ran; it is not a pass.

Auth is off unless the collector runs with FLEET_AUTH=tokens. Then send
\`Authorization: Bearer <token>\`; scopes are read, run (implies read), admin
(implies run), agent (the runner protocol) and delegate (a gateway naming the
person it acts for in X-Fleet-Actor). Each operation's \`x-fleet-scope\` says
which it needs. Send \`X-Fleet-Source\` (mcp, cli, ci...) so jobs record where
they came from.`;

function schemaRef(name: string): Record<string, unknown> {
  return name.startsWith("list:")
    ? { $ref: `#/components/schemas/${name.slice(5)}List` }
    : { $ref: `#/components/schemas/${name}` };
}

function parameter(p: Param) {
  const schema: Record<string, unknown> = { type: p.type };
  if (p.enum) schema.enum = p.enum;
  if (p.default !== undefined) schema.default = p.default;
  if (p.minimum !== undefined) schema.minimum = p.minimum;
  if (p.maximum !== undefined) schema.maximum = p.maximum;
  return { name: p.name, in: p.in, required: p.in === "path" ? true : !!p.required, description: p.description, schema };
}

function response(r: Response) {
  if (!r.schema && !r.contentType) return { description: r.description };
  if (!r.schema) return { description: r.description, content: { [r.contentType!]: {} } };
  return { description: r.description, content: { [r.contentType ?? "application/json"]: { schema: schemaRef(r.schema) } } };
}

function operation(route: Route) {
  const op: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: [route.tag],
    "x-fleet-scope": route.scope,
  };
  if (route.readOnly) op["x-fleet-read-only"] = true;
  if (route.destructive) op["x-fleet-destructive"] = true;
  if (route.idempotent) op["x-fleet-idempotent"] = true;
  if (route.scope === "public") op.security = [];
  if (route.params?.length) op.parameters = route.params.map(parameter);
  if (route.body) {
    op.requestBody = {
      required: route.body.required,
      description: route.body.description,
      content: { "application/json": { schema: schemaRef(route.body.schema) } },
    };
  }
  op.responses = Object.fromEntries(route.responses.map((r) => [String(r.status), response(r)]));
  return op;
}

/** Every component a route names, plus the list envelope for each `list:X`. */
function components() {
  const schemas: Record<string, unknown> = { ...SCHEMAS };
  for (const r of ROUTES)
    for (const res of r.responses)
      if (res.schema?.startsWith("list:")) schemas[`${res.schema.slice(5)}List`] = listOf(res.schema.slice(5));
  return Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)));
}

export function openapiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  return {
    openapi: "3.1.0",
    info: {
      title: "Fleet Runner",
      version: APP_VERSION,
      description: DESCRIPTION,
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "The collector this document was served by." }],
    security: [{ bearer: [] }, {}],
    tags: [
      { name: "meta", description: "Health, identity, this document." },
      { name: "devices", description: "The shelf." },
      { name: "workloads", description: "What can be run, with example specs." },
      { name: "jobs", description: "Queue, validate, wait for, cancel and retry work." },
      { name: "results", description: "What ran and how it went." },
      { name: "artifacts", description: "Screenshots, logs, reports, builds." },
      { name: "findings", description: "What night QA found, its verdicts, and the regression tests fixed findings became." },
      { name: "fleet", description: "Schedules, alerts, audit." },
      { name: "protocol", description: "What runners speak. Not for composing work." },
    ],
    paths,
    components: {
      schemas: components(),
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A Fleet Runner token (fr_...), or the MCP gateway's delegating token." },
      },
    },
  };
}
