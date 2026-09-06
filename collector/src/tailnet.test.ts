/**
 * The tailnet admission policy, checked without a tailnet.
 *
 * Every case here is a way the gate could fail OPEN — quietly admitting a node
 * it was configured to keep out — because that is the only failure mode that
 * matters for a boundary. A gate that wrongly refuses is noticed within a
 * minute by whoever's laptop stopped working; a gate that wrongly admits is
 * noticed never.
 */
import { admit, isTailnetAddress, isTailscaleV6, isLoopback, normaliseIp, parseWhois, peerAllowed } from "./tailnet.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

// A real `tailscale whois --json` response, trimmed to the fields read.
const WHOIS = JSON.stringify({
  Node: {
    ID: 12345,
    Name: "elsies-macbook.tail1a2b3.ts.net.",
    ComputedName: "elsies-macbook",
    Addresses: ["100.101.102.103/32"],
  },
  UserProfile: { LoginName: "someone@example.com", DisplayName: "Someone" },
});

export function runTailnetChecks(check: Check) {
  // --- the address range -----------------------------------------------------
  check("100.64.0.0/10 is the tailnet", isTailnetAddress("100.101.102.103"));
  check("the bottom of the range is in", isTailnetAddress("100.64.0.1"));
  check("the top of the range is in", isTailnetAddress("100.127.255.254"));
  // The reason this is arithmetic and not a string prefix: both of these start
  // with "100.6" and neither is a tailnet address.
  check("100.6.x.x is NOT the tailnet", !isTailnetAddress("100.6.1.1"), "a string prefix would admit this");
  check("100.63.x.x is below the range", !isTailnetAddress("100.63.255.255"));
  check("100.128.x.x is above the range", !isTailnetAddress("100.128.0.1"));
  check("a LAN address is not the tailnet", !isTailnetAddress("192.168.50.27"));
  check("nonsense is not an address", !isTailnetAddress("100.64.0"), "a short address must not parse");

  // --- and the other family ---------------------------------------------
  //
  // Tailscale gives every node an address in fd7a:115c:a1e0::/48 as well as a
  // 100.x one, and which one a peer arrives on is decided by its resolver, not
  // by the collector. A check that knew only about IPv4 would admit an
  // unlisted node that simply connected over v6, while looking like it was
  // working — which is the only direction this must never fail in.
  check("a Tailscale IPv6 address is the tailnet", isTailnetAddress("fd7a:115c:a1e0::1"));
  check("a full-length Tailscale IPv6 address is the tailnet",
    isTailnetAddress("fd7a:115c:a1e0:ab12:cd34:ef56:7890:1234"));
  check("case does not matter", isTailscaleV6("FD7A:115C:A1E0::1"));
  check("a zone suffix is not part of the address", isTailscaleV6("fd7a:115c:a1e0::1%en0"));
  check("another ULA is not the tailnet", !isTailnetAddress("fd00:1234:5678::1"));
  // The prefix is three groups; sharing characters with the third is not
  // sharing the network.
  check("a longer third group is a different network", !isTailscaleV6("fd7a:115c:a1e0f::1"));
  // `::` here elides a zero third group, so this is fd7a:115c:0:...:a1e0:1.
  check("an elision in the middle of the prefix is not the prefix", !isTailscaleV6("fd7a:115c::a1e0:1"));
  check("ordinary IPv6 is not the tailnet", !isTailnetAddress("2001:db8::1"));
  check("loopback v6 is not the tailnet", !isTailnetAddress("::1"));

  check("loopback in both families", isLoopback("127.0.0.1") && isLoopback("::1") && isLoopback("127.1.2.3"));
  check("Node's IPv4-mapped prefix is stripped", normaliseIp("::ffff:100.101.102.103") === "100.101.102.103");

  // --- whois -----------------------------------------------------------------
  const peer = parseWhois(WHOIS);
  check("whois yields the short node name", peer?.node === "elsies-macbook", JSON.stringify(peer));
  check("whois yields the owner, for a readable log line", peer?.user === "someone@example.com");
  check("unparseable whois output is null, never a peer", parseWhois("not json") === null);
  check("whois output with no node is null", parseWhois(JSON.stringify({ UserProfile: {} })) === null);

  // --- matching --------------------------------------------------------------
  check("an entry matches the short name", peerAllowed({ node: "elsies-macbook", user: null }, ["elsies-macbook"]));
  check("matching is case-insensitive", peerAllowed({ node: "Elsies-MacBook", user: null }, ["elsies-macbook"]));
  check(
    "a fully qualified node matches a short entry",
    peerAllowed({ node: "elsies-macbook.tail1a2b3.ts.net", user: null }, ["elsies-macbook"]),
  );
  check(
    "a short node matches a fully qualified entry",
    peerAllowed({ node: "elsies-macbook", user: null }, ["elsies-macbook.tail1a2b3.ts.net"]),
  );
  check("a trailing dot does not defeat a match", peerAllowed({ node: "laptop.", user: null }, ["laptop"]));
  check("a different node does not match", !peerAllowed({ node: "someone-elses-phone", user: null }, ["laptop"]));
  // No globs, deliberately: an allowlist that can be got wrong quietly is
  // worse than one that has to be typed out.
  check("an entry is not a pattern", !peerAllowed({ node: "laptop-2", user: null }, ["laptop*"]));
  check("an empty allowlist matches nothing", !peerAllowed({ node: "laptop", user: null }, []));

  // --- the decision ----------------------------------------------------------
  const LIST = ["elsies-macbook", "pixel-4a"];
  const known = { node: "elsies-macbook", user: null };
  const stranger = { node: "conference-phone", user: null };

  check("with no allowlist nothing is checked, which is the default",
    admit("100.9.9.9", [], null).admit, "enabling this must be opt-in");
  check("a named tailnet node is admitted", admit("100.101.102.103", LIST, known).admit);
  check("an unnamed tailnet node is refused",
    !admit("100.101.102.103", LIST, stranger).admit,
    admit("100.101.102.103", LIST, stranger).why);

  // The one that decides whether this is a boundary at all. If an unavailable
  // `tailscale` binary made the lookup null and null were admitted, the
  // allowlist would disable itself exactly when it was needed.
  const unresolved = admit("100.101.102.103", LIST, null);
  check("a tailnet address that cannot be identified is REFUSED", !unresolved.admit, unresolved.why);
  check("and the refusal says what to check", /tailscale CLI/.test(unresolved.why), unresolved.why);

  // The whole point of the v6 work: the same decision over the other family.
  const v6 = "fd7a:115c:a1e0::1";
  check("an unlisted node over IPv6 is refused, not waved through",
    !admit(v6, LIST, stranger).admit, admit(v6, LIST, stranger).why);
  check("an IPv6 peer that cannot be identified is refused", !admit(v6, LIST, null).admit);
  check("a listed node over IPv6 is admitted", admit(v6, LIST, known).admit);

  // The other half of the design: this fences the tailnet, not the house.
  check("a LAN peer is still admitted under the existing posture",
    admit("192.168.50.27", LIST, null).admit,
    "fencing the LAN too would mean enabling this broke every phone on the shelf");
  check("loopback is always admitted", admit("127.0.0.1", LIST, null).admit);
  check("the LAN decision says which posture applies",
    /LAN posture/.test(admit("192.168.50.27", LIST, null).why));
}
