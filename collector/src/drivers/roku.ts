/**
 * Roku: streaming players and Roku TVs, over SSDP and ECP.
 *
 * The first driver here that reaches devices over the NETWORK rather than over
 * a cable and a vendor CLI. adb, simctl and devicectl all answer the question
 * "what is plugged into this Mac?"; this one answers "what Rokus are on this
 * LAN?", and the difference shows up in every part of it -- there is no tool to
 * shell out to, discovery is a multicast broadcast with a deadline rather than
 * a command that returns, and a device can appear and disappear without anybody
 * touching a cable.
 *
 * ## Discovery
 *
 * Roku's External Control Protocol advertises over SSDP. An M-SEARCH datagram
 * to 239.255.255.250:1900 with `ST: roku:ecp` makes every Roku on the segment
 * reply with a unicast HTTP-over-UDP response carrying a `LOCATION` header --
 * `http://<ip>:8060/` -- and `GET <location>query/device-info` then returns an
 * XML descriptor with the serial number, model and firmware.
 *
 * The whole thing is time-boxed, because there is no "that was all of them"
 * signal in SSDP. A device that was asleep, on the far side of a slow access
 * point, or simply dropped a UDP packet does not reply, and there is nothing to
 * distinguish that from there being no more Rokus. So discovery waits a fixed
 * window and reports what answered -- which means a Roku can be missing from
 * one pass and present in the next, and that is normal rather than a fault.
 *
 * ## Installing is NOT implemented, and this is why
 *
 * A dev channel is installed with a multipart POST to
 * `http://<ip>/plugin_install` behind HTTP digest authentication as user
 * `rokudev`. Node's fetch has no digest support, so it would mean implementing
 * RFC 7616 by hand -- parse the challenge, pick qop, generate a cnonce, compute
 * HA1/HA2/response, track the nonce count -- and Roku's implementation has
 * known quirks around `qop=auth` that only real hardware would reveal. Writing
 * that against no device to test it on would produce code that looks finished,
 * gets committed, and fails the first time somebody actually has a Roku.
 *
 * `runner-roku/build.sh` does the install instead, with `curl --digest`, which
 * is a correct digest client that already exists. The cost of the split is one
 * manual step; the cost of the alternative is an untested auth implementation
 * in the executor.
 *
 * If it is implemented later, the password comes from `secrets.ts` -- the
 * executor host's Keychain -- and NEVER from a job spec. `POST /jobs` is
 * unauthenticated and specs are stored in SQLite, returned by the API and
 * rendered on the dashboard, so a password in one is published to everyone on
 * the LAN. `rokuDevPassword()` below is that lookup, exported and unused by
 * this driver on purpose: it is the seam an install would use, and having it
 * here is what stops the eventual implementation reaching for `job.params`.
 *
 * ## Verified: no
 *
 * No Roku hardware was available. The SSDP exchange and the device-info XML
 * shape below come from Roku's published ECP documentation. The parsers are
 * pure functions over recorded-shape strings and are exercised by
 * `runDriverChecks`; the socket code is not exercised by anything.
 */
import dgram from "node:dgram";
import { log } from "../fleet-client.js";
import { keychainPassword, type KeychainResult } from "../secrets.js";
import type { Target } from "../workloads/types.js";
import type { Driver } from "./types.js";

/** SSDP's multicast group and port. Not configurable; they are in the spec. */
const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

/**
 * How long to listen for replies.
 *
 * SSDP has no end-of-list, so this is the whole discovery cost and it is paid
 * on every pass. Two seconds is a compromise: presence reporting calls
 * `listAllTargets()` every 60 seconds, and `MX: 1` below tells devices to
 * spread their replies over at most one second, so two gives a slow device a
 * second one to answer in without adding two seconds to every job that selects
 * targets.
 */
const DISCOVERY_MS = 2000;

/** Per-device timeout on the device-info fetch, once one has answered SSDP. */
const DEVICE_INFO_MS = 3000;

/**
 * The Keychain service holding the Roku developer password.
 *
 * Separate from the UI-test service in secrets.ts because they are different
 * secrets for different machines, and one service name holding both would mean
 * a single Keychain ACL grant covering both.
 */
export const ROKU_KEYCHAIN_SERVICE = process.env.FLEET_ROKU_KEYCHAIN_SERVICE ?? "fleet-roku-dev";

/**
 * The developer password for `plugin_install`, from the executor host's login
 * Keychain.
 *
 * Add it with:
 *
 *   security add-generic-password -s fleet-roku-dev -a rokudev -w
 *
 * which prompts rather than taking the password as an argument.
 */
export function rokuDevPassword(): Promise<KeychainResult> {
  return keychainPassword("rokudev", ROKU_KEYCHAIN_SERVICE);
}

/** What one Roku answered with. */
export type RokuDevice = {
  /** Dotted-quad, from the SSDP LOCATION header. */
  ip: string;
  /** ECP port, which is 8060 on every Roku but is read rather than assumed. */
  port: number;
  /** `serial-number` from device-info. Absent until device-info is fetched. */
  serial?: string;
  udn?: string;
  modelName?: string;
  modelNumber?: string;
  /** "STB", "TV" or "Projector" -- Roku's own word for the form factor. */
  deviceType?: string;
  softwareVersion?: string;
  /** True when the device reports developer mode is on, so install would work. */
  developerEnabled?: boolean;
};

/**
 * The M-SEARCH datagram.
 *
 * CRLF line endings and a trailing blank line are load-bearing: SSDP is
 * HTTP-shaped and a device that cannot parse the request simply does not reply,
 * which is indistinguishable from there being no Rokus. `ST: roku:ecp` is
 * Roku's own search target -- `ssdp:all` would work too and would also wake
 * every printer, speaker and router on the network into replying.
 *
 * `MX: 1` asks devices to spread their replies over at most one second, which
 * is what keeps DISCOVERY_MS short.
 */
export function mSearchDatagram(): Buffer {
  return Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "ST: roku:ecp",
      "MX: 1",
      "",
      "",
    ].join("\r\n"),
    "ascii",
  );
}

/**
 * The `LOCATION` header out of an SSDP reply, as ip and port.
 *
 * Returns null for anything that is not a Roku ECP endpoint, which includes
 * every other SSDP responder that answers a multicast search it was not the
 * target of -- and they do. Header names are matched case-insensitively because
 * SSDP is HTTP-shaped and devices spell them however they like; a parser that
 * only accepted `LOCATION:` would silently drop the ones that send `Location:`.
 */
export function parseSsdpLocation(message: string): { ip: string; port: number } | null {
  const line = message.split(/\r?\n/).find((l) => /^location\s*:/i.test(l));
  if (!line) return null;
  const url = line.slice(line.indexOf(":") + 1).trim();
  const m = /^https?:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(url);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { ip: m[1], port };
}

/**
 * One tag's text out of the device-info XML.
 *
 * A regex rather than an XML parser, deliberately: the response is a flat list
 * of single-level elements with no attributes and no namespaces, the collector
 * has no XML dependency, and adding one for this would be the largest thing in
 * package.json serving the smallest purpose. The pattern is anchored to the
 * exact tag name so a substring match cannot pick up `model-number` when asked
 * for `model-name`.
 */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return undefined;
  const text = m[1].trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The device-info XML into a descriptor.
 *
 * Pure over its input so it can be checked against a recorded response, which
 * is the only way it is ever checked: no Roku was available to produce a live
 * one.
 */
export function parseDeviceInfo(xml: string, base: RokuDevice): RokuDevice {
  return {
    ...base,
    serial: xmlTag(xml, "serial-number"),
    udn: xmlTag(xml, "device-id") ?? xmlTag(xml, "udn"),
    modelName: xmlTag(xml, "model-name") ?? xmlTag(xml, "friendly-model-name"),
    modelNumber: xmlTag(xml, "model-number"),
    deviceType: xmlTag(xml, "device-type"),
    softwareVersion: xmlTag(xml, "software-version"),
    // Roku spells booleans as the strings "true"/"false" here. Compared rather
    // than coerced: `Boolean("false")` is true, and this field decides whether
    // the executor thinks it can install anything.
    developerEnabled: xmlTag(xml, "developer-enabled")?.toLowerCase() === "true",
  };
}

/**
 * The id a Roku is known by, which must be stable across discovery passes.
 *
 * The serial number first, because it is the device and does not change. The IP
 * only as a fallback for a Roku that answered SSDP and then failed the
 * device-info fetch -- and it is marked as such in the id, because a
 * DHCP-assigned address is a name that silently becomes a different device's
 * after a lease expires, and a target id that moves between devices puts one
 * Roku's results under another's name.
 *
 * The prefix matches the runner's own `roku-` device_id prefix so that a
 * driver-discovered target and a registered agent read as the same kind of
 * thing on the dashboard. They are NOT guaranteed to be the same string: the
 * agent identifies itself by `GetChannelClientId()`, which is a per-publisher
 * value that ECP does not expose, so nothing outside the device can compute it.
 * That is a real limitation and is written down in runner-roku/README.md.
 */
export function rokuTargetId(d: RokuDevice): string {
  if (d.serial) return `roku-${d.serial}`;
  return `roku-ip-${d.ip.replace(/\./g, "-")}`;
}

/**
 * Broadcast one M-SEARCH and collect the endpoints that answer.
 *
 * Never throws, per the driver contract: a host with no route to the multicast
 * group, no permission to bind, or no network at all has no Rokus, and that is
 * ordinary rather than an error. The one thing that IS worth saying out loud is
 * a socket error, because "no Rokus found" and "this host cannot send multicast
 * at all" need opposite responses and look identical from the outside.
 */
export async function discoverEndpoints(timeoutMs = DISCOVERY_MS): Promise<RokuDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, RokuDevice>();
    let socket: dgram.Socket;
    try {
      // reuseAddr because the executor may share a host with anything else
      // doing SSDP, and refusing to bind would be a discovery outage caused by
      // a neighbouring process rather than by anything about this fleet.
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed by the error path. Closing twice throws, and throwing
        // out of a timer callback would take the executor down.
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);
    // The timer must not hold the process open: this runs inside an executor
    // that is otherwise idle between polls.
    timer.unref?.();

    socket.on("error", (e) => {
      log(`roku: SSDP socket error (${e.message}); no Rokus will be discovered from this host`);
      finish();
    });

    socket.on("message", (msg) => {
      const loc = parseSsdpLocation(msg.toString("utf8"));
      // Keyed by ip:port rather than by ip. A device answers the search once
      // per interface it heard it on, and dropping the duplicates here is
      // cheaper than fetching device-info twice for the same box.
      if (loc) found.set(`${loc.ip}:${loc.port}`, { ip: loc.ip, port: loc.port });
    });

    socket.bind(() => {
      try {
        // Bound to an ephemeral port and sending to the group: the replies come
        // back UNICAST to that port, so there is no group membership to join.
        // Adding one would also receive every other device's announcements,
        // which is noise this driver has no use for.
        socket.send(mSearchDatagram(), SSDP_PORT, SSDP_ADDR);
      } catch (e) {
        log(`roku: could not send SSDP M-SEARCH (${(e as Error).message})`);
        finish();
      }
    });
  });
}

/**
 * Fill in a descriptor for one endpoint.
 *
 * A device that answered SSDP and then fails this is still returned, with only
 * its address: it exists, it is on the network, and dropping it because a
 * second request timed out would hide a Roku that is merely busy.
 */
export async function fetchDeviceInfo(d: RokuDevice, timeoutMs = DEVICE_INFO_MS): Promise<RokuDevice> {
  try {
    const res = await fetch(`http://${d.ip}:${d.port}/query/device-info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return d;
    return parseDeviceInfo(await res.text(), d);
  } catch {
    return d;
  }
}

export async function rokuDevices(timeoutMs = DISCOVERY_MS): Promise<RokuDevice[]> {
  const endpoints = await discoverEndpoints(timeoutMs);
  if (endpoints.length === 0) return [];
  // Concurrently: they are independent HTTP requests to different boxes, and
  // serialising them would make a shelf of six Rokus cost six timeouts in the
  // worst case, on a path that runs every 60 seconds.
  return Promise.all(endpoints.map((e) => fetchDeviceInfo(e, timeoutMs)));
}

export const rokuDriver: Driver = {
  name: "roku",
  describes: "Roku players and Roku TVs on this network, over SSDP and ECP (discovery only -- no install)",
  async list(): Promise<Target[]> {
    try {
      return (await rokuDevices()).map((d): Target => ({
        id: rokuTargetId(d),
        // Named, not guessed. Everything that answers `ST: roku:ecp` is a Roku;
        // there is no ambiguity here of the kind that makes simctl's runtime
        // mapping refuse an unknown answer.
        platform: "roku",
        kind: "device",
        driver: "roku",
      }));
    } catch (e) {
      // The contract says list() never throws. discoverEndpoints already
      // resolves rather than rejecting, so this is unreachable -- and an
      // unreachable path that would empty the shelf is worth one catch.
      log(`roku: discovery failed (${(e as Error).message}); reporting no Rokus`);
      return [];
    }
  },
  // No install. See the header: it needs HTTP digest auth that Node's fetch
  // does not do, and writing that with no hardware to test it against would
  // produce something that looks finished and is not.
  // `runner-roku/build.sh --install <ip>` does it with `curl --digest`.
};
