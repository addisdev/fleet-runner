/**
 * Who is on the other end, when the other end is on the tailnet.
 *
 * ## What this is not
 *
 * It is not authentication for the collector, and turning it on does not make
 * `POST /jobs` safe to expose. The README's threat model is deliberate and
 * still stands: there is no auth, the network IS the access control, and
 * anyone who can reach the collector can enqueue a job.
 *
 * What changed is that the network stopped being one place. `FLEET_BIND`
 * already lets the collector answer on loopback plus its tailnet address, so a
 * laptop that leaves the house can still claim work — and at that point "the
 * network I chose" includes every device on the tailnet, including ones added
 * by a share link, and including a phone somebody was handed at a conference.
 *
 * So this is the honest version of access control for a personal fleet: the
 * network is still the boundary, it is just a network you can enumerate. A
 * tailnet peer must be a node you named; a LAN peer is governed by the posture
 * that was already there.
 *
 * ## The split, stated plainly
 *
 *   loopback / LAN address  -> allowed, exactly as before. Turning this on must
 *                              not break the house, and the README's posture
 *                              already covers everyone who can reach the wire.
 *   tailnet address (CGNAT) -> must resolve to a node in the allowlist.
 *   allowlist unset         -> nothing is checked at all, which is the default
 *                              and the only behaviour that existed before.
 *
 * Opt-in, and off by default, because a fleet that started refusing its own
 * phones after an upgrade would be worse than one with no allowlist.
 *
 * ## Why shelling out to `tailscale whois`
 *
 * The local API on 100.100.100.100 needs a per-host auth token that varies by
 * platform and by how Tailscale was installed. The CLI already holds it, is
 * present wherever the tailnet address it is being asked about is, and answers
 * in JSON. A collector that could not read its own tailnet is a collector that
 * refuses every roaming agent, so the failure mode matters more than the
 * elegance: an unavailable CLI is reported as unknown, and unknown is refused,
 * which is the safe direction.
 */
import { execFile } from "node:child_process";

/**
 * Tailscale's address range: 100.64.0.0/10, the CGNAT block.
 *
 * Matched on the numeric prefix rather than by string, because 100.6.x.x and
 * 100.640.x.x are both outside it and both start with "100.6".
 */
export function isTailnetAddress(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 100 && b >= 64 && b <= 127;
}

/** Loopback, in both families, and the IPv4-mapped form Node hands over. */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || /^127\./.test(ip);
}

/** The address as the request saw it, with Node's IPv4-mapped prefix removed. */
export function normaliseIp(raw: string | undefined): string {
  return (raw ?? "").replace(/^::ffff:/, "");
}

export type TailnetPeer = {
  /** The node's name, e.g. "elsies-macbook.tail1234.ts.net" or its short form. */
  node: string;
  /** Who owns it, e.g. "you@github". Reported so a log line is readable. */
  user: string | null;
};

/**
 * What `tailscale whois --json <ip>` said, or null.
 *
 * Exported and pure over its input because the interesting failure is a shape
 * change in somebody else's tool, and that can only be tested against a
 * recorded response.
 */
export function parseWhois(stdout: string): TailnetPeer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const o = parsed as {
    Node?: { Name?: string; ComputedName?: string };
    UserProfile?: { LoginName?: string; DisplayName?: string };
  };
  // ComputedName is the short name a person recognises ("elsies-macbook");
  // Name is the fully qualified one. Either identifies the node; the short one
  // is preferred because it is what somebody would type into an allowlist.
  const node = o.Node?.ComputedName ?? o.Node?.Name;
  if (typeof node !== "string" || node === "") return null;
  return { node, user: o.UserProfile?.LoginName ?? o.UserProfile?.DisplayName ?? null };
}

/**
 * Does this peer match an allowlist entry?
 *
 * Entries match the short name or the fully qualified one, case-insensitively,
 * and a trailing dot is ignored — so `laptop`, `laptop.tail1234.ts.net` and
 * `LAPTOP.` all name the same node. Anything cleverer (globs, regex) is
 * deliberately absent: an allowlist that can be got wrong quietly is worse
 * than one that has to be typed out.
 */
export function peerAllowed(peer: TailnetPeer, allowlist: string[]): boolean {
  const clean = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
  const entries = allowlist.map(clean).filter(Boolean);
  if (entries.length === 0) return false;
  const node = clean(peer.node);
  if (entries.includes(node)) return true;

  // A fully qualified name matches an entry that is only its first label, AND
  // the reverse. Both directions, because the allowlist is typed by a person
  // who may write either — and shortening only one side is a bug the tests
  // caught: `elsies-macbook` did not match an entry of
  // `elsies-macbook.tail1a2b3.ts.net`, so an allowlist written the careful way
  // silently refused the node it was written for.
  //
  // The theoretical cost is that two nodes with the same first label on
  // different tailnets would both match one entry. A collector only ever sees
  // peers from its own tailnet, where the first label is already unique, so
  // that case cannot arise here — and refusing it would break the more common
  // spelling for a risk this deployment does not have.
  const short = (s: string) => s.split(".")[0];
  return entries.some((e) => short(e) === short(node));
}

const TAILSCALE = process.env.FLEET_TAILSCALE_BIN ?? "tailscale";

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === "number"
        ? (err as { code: number }).code
        : err ? null : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

export async function whois(ip: string): Promise<TailnetPeer | null> {
  const r = await run(TAILSCALE, ["whois", "--json", ip]);
  if (r.code !== 0) return null;
  return parseWhois(r.stdout);
}

export type AdmitDecision =
  | { admit: true; why: string }
  | { admit: false; why: string };

/**
 * Decide, given everything already looked up. Pure, so the policy is testable
 * without a tailnet.
 *
 * `peer` is what whois returned: null means the lookup failed OR the address is
 * not a tailnet peer, and the caller distinguishes those by having already
 * checked the address range. A tailnet address whose identity could not be
 * resolved is REFUSED — the alternative is that an unreachable `tailscale`
 * binary silently disables the allowlist, which is exactly the failure an
 * allowlist exists to prevent.
 */
export function admit(
  ip: string,
  allowlist: string[],
  peer: TailnetPeer | null,
): AdmitDecision {
  if (allowlist.length === 0) return { admit: true, why: "no allowlist configured" };
  if (isLoopback(ip)) return { admit: true, why: "loopback" };
  if (!isTailnetAddress(ip)) {
    // The LAN. Governed by the posture that was already there, and deliberately
    // not by this list: an allowlist that also fenced the house would mean
    // enabling it broke every phone on the shelf.
    return { admit: true, why: "not a tailnet address; LAN posture applies" };
  }
  if (peer === null) {
    return {
      admit: false,
      why: `tailnet address ${ip} could not be identified (is the tailscale CLI available to the collector?)`,
    };
  }
  if (peerAllowed(peer, allowlist)) return { admit: true, why: `tailnet node ${peer.node}` };
  return { admit: false, why: `tailnet node ${peer.node} is not in FLEET_TAILNET_ALLOWLIST` };
}
