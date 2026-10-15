/**
 * The Fleet Runner client: `new FleetClient({ baseUrl, token, source })`.
 *
 * One method per /api/v1 operation, generated from the route table, so a
 * renamed parameter is a compile error in every caller rather than a 400 at
 * runtime in one of them.
 */
export * from "./api.gen.js";
export { FleetApiError, Transport, type ClientOptions, type RequestOptions } from "./transport.js";
