// The dashboard's door into /api/v1: the generated client, with the dashboard's
// own way of carrying a token.
//
// The client and its types are generated from the route table, so a field the
// server renames is a compile error here rather than a blank column. Where the
// dashboard needs something /api/v1 does not offer, the page still calls the
// unversioned /api/* route through api.ts or mutate.ts.
import { FleetApiError, FleetClient } from "../../src/client/index.js";
import type { DeviceList, JobSpecInput } from "../../src/client/index.js";
import { getToken, tokenHeader } from "./token.js";

export type * from "../../src/client/index.js";

/**
 * Same origin, and the token as `X-Fleet-Token` read at call time: that is the
 * header FLEET_DASH_TOKEN's guard checks, and FLEET_AUTH=tokens accepts it as
 * readily as `Authorization: Bearer`. The banner can change the token at any
 * moment, so it is not baked into the client.
 */
export const fleet = new FleetClient({
  baseUrl: location.origin,
  source: "dash",
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined), ...tokenHeader() },
    }),
});

/** Turn a v1 refusal into the sentence a person should read. */
function explain(e: unknown, mutation: boolean): Error {
  if (!(e instanceof FleetApiError)) return e as Error;
  // Naming the missing header is true and useless. Say what to do -- the same
  // words mutate.ts uses for the routes not yet in /api/v1.
  if (mutation && e.status === 401)
    return new FleetApiError(401, e.code, getToken()
      ? "That dashboard token was rejected. Check it on the System screen."
      : "This collector needs a dashboard token — paste it in the banner above, or on the System screen.");
  // A spec the strict schema refuses: say where, not only that.
  const errors = (e.details as { schema_errors?: { path: string; message: string }[] } | undefined)?.schema_errors;
  if (errors?.length)
    return new FleetApiError(e.status, e.code, `${e.message}: ${errors.map((x) => `${x.path || "/"} ${x.message}`).join("; ")}`, e.hint, e.details);
  return e;
}

/** A read through the client, with errors in the dashboard's words. */
export const read = <T>(p: Promise<T>): Promise<T> => p.catch((e) => Promise.reject(explain(e, false)));

/** A change through the client: a 401 says to paste a token, as every other button does. */
export const change = <T>(p: Promise<T>): Promise<T> => p.catch((e) => Promise.reject(explain(e, true)));

/**
 * Every device, however many pages that takes. The shelf is one screen, and
 * the unversioned route it replaced answered with all of them at once.
 */
export async function allDevices(query: Parameters<FleetClient["listDevices"]>[0] = {}): Promise<DeviceList> {
  const first = await fleet.listDevices({ ...query, per_page: 500 });
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) items.push(...(await fleet.listDevices({ ...query, per_page: 500, page })).items);
  return { ...first, items, page: 1, per_page: items.length || first.per_page, pages: 1 };
}

/** The composer's spec is free-form JSON a person typed; the server is what checks it. */
export const asSpec = (spec: Record<string, unknown>) => spec as JobSpecInput;
