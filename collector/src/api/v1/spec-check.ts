/**
 * The strict job-spec check, on its own so two things can share it.
 *
 * `/api/v1` refuses a spec that does not match `JobSpecInput` (unknown keys
 * included) or whose `params` do not match the workload's manifest. The
 * examples in `examples/jobs/` are what the docs show a reader, so
 * `scripts/check-examples.ts` holds them to the same check, with the same
 * compiled schemas, rather than to the looser `job.schema.json` it used to.
 *
 * No database, no Fastify: a script can import this without opening a
 * collector's data directory.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { catalogEntry, type CatalogEntry } from "../../workloads/catalog.js";
import { SCHEMAS } from "./schemas.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
export const validateSpec = ajv.compile(SCHEMAS.JobSpecInput);
const paramValidators = new Map<string, ValidateFunction | null>();

export function paramsValidator(entry: CatalogEntry | null): ValidateFunction | null {
  if (!entry?.params) return null;
  if (!paramValidators.has(entry.name)) {
    try {
      paramValidators.set(entry.name, ajv.compile(entry.params));
    } catch {
      paramValidators.set(entry.name, null);
    }
  }
  return paramValidators.get(entry.name) ?? null;
}

export type SchemaError = { path: string; message: string };

export const errorsOf = (v: ValidateFunction, prefix = ""): SchemaError[] =>
  (v.errors ?? []).slice(0, 20).map((e) => ({
    path: `${prefix}${e.instancePath}` || "/",
    message: `${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? `: ${String(e.params.additionalProperty)}` : ""}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`,
  }));

/**
 * Every problem `/api/v1` would refuse this spec for at validation, by JSON
 * pointer: the schema first, then the workload's params manifest. Empty when
 * the spec would pass. (Whether anything can run it is a later question.)
 */
export function specProblems(spec: unknown): SchemaError[] {
  if (!validateSpec(spec)) return errorsOf(validateSpec);
  const entry = catalogEntry(String((spec as { workload?: unknown }).workload));
  const pv = paramsValidator(entry);
  if (pv && !pv((spec as { params?: unknown }).params ?? {})) return errorsOf(pv, "/params");
  return [];
}
