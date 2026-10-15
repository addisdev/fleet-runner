/**
 * `fleet mcp` -- the device lab as tools, over stdio, for a coding agent on
 * this machine.
 *
 * Nobody opened the dashboard for a week while the fleet ran fifty jobs, and
 * that is not a dashboard problem: the work on these apps is done by coding
 * agents, and an agent does not open a dashboard. It calls a tool.
 *
 * Local means trusted: every tool is offered, the collector URL is in the
 * instructions, and the token is whatever `fleet login` saved (or FLEET_TOKEN).
 * The remote gateway (http.ts) is the same tools with the trust taken out.
 *
 * Everything goes to stdout as protocol and to stderr as log, never the other
 * way: a stray console.log on stdout is a malformed message to the client.
 */
import { createInterface } from "node:readline";
import { connect } from "../connect.js";
import { VERSION } from "../version.js";
import { handle, type Request, type Session } from "./protocol.js";

export function localSession(opts: { url?: string; token?: string } = {}): Session {
  const client = connect({ url: opts.url, token: opts.token, source: "mcp" });
  return { ctx: { client, remote: false }, allowed: () => true, where: client.baseUrl };
}

/** Serve over stdio until stdin closes. */
export async function serveMcp(opts: { url?: string; token?: string } = {}): Promise<number> {
  const session = localSession(opts);
  process.stderr.write(`fleet mcp ${VERSION}: collector ${session.where}${session.ctx.client.token ? " (with a token)" : ""}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set<Promise<void>>();
  const write = (out: unknown) => process.stdout.write(`${JSON.stringify(out)}\n`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Request | Request[];
    try {
      msg = JSON.parse(line) as Request | Request[];
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Calls run concurrently: fleet_run waits up to fifteen minutes, and a
    // client that sends `ping` meanwhile must still get an answer.
    const p = (Array.isArray(msg)
      ? Promise.all(msg.map((m) => handle(session, m))).then((outs) => {
          const replies = outs.filter((o) => o !== null);
          if (replies.length) write(replies);
        })
      : handle(session, msg).then((out) => {
          if (out) write(out);
        })
    ).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.all(inflight);
  return 0;
}
