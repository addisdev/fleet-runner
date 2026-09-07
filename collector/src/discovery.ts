/**
 * A brain announces itself, and anything on the same link can find it.
 *
 * ## The problem this solves
 *
 * The hard part of enrolling a device has never been the software. The
 * enrolment screen already says it:
 *
 *   > The hard part of enrolling a phone is not the software, it is typing the
 *   > collector's address on a touch keyboard without a typo, once per device.
 *
 * A QR code fixes that for a phone, because a phone has a camera. It fixes
 * nothing for a television, which has neither a camera nor a keyboard worth
 * using -- and televisions are the next platforms on the shelf. A Roku's remote
 * has no text entry at all beyond an on-screen grid.
 *
 * So the address has to arrive some other way. There are exactly two: the
 * device finds the brain, or the brain reaches the device. This module is the
 * first. The `enrol` host workload is the second, and between them no
 * television ever needs somebody to type an IP address into it.
 *
 * ## Why it is off by default
 *
 * `FLEET_DISCOVERY=1`, and `fleet up` turns it on. A collector should not start
 * announcing itself on somebody's office network because they upgraded, and the
 * project's whole security posture is that the network is the access control --
 * which means what it announces itself to is a decision, not a default.
 *
 * ## What it does not change
 *
 * mDNS is link-local by construction: the packets go to 224.0.0.251 with a TTL
 * of 1 and do not cross a router. So a collector bound to a tailnet address is
 * not advertised across the tailnet, and the posture in docs/deploy/index.md is
 * untouched. Discovery makes an address easier to learn; it does not make the
 * collector reachable from anywhere it was not already.
 */
import { Bonjour, type Browser, type Service } from "bonjour-service";
import { networkInterfaces } from "node:os";

/** The service type. `_fleet._tcp` under `.local`, as DNS-SD requires. */
export const SERVICE_TYPE = "fleet";

export type Advertised = { stop: () => Promise<void> };

/** A brain somebody found, as the browser sees it. */
export type FoundBrain = {
  /** The collector's stable id, from its TXT record. */
  id: string | null;
  name: string;
  /** A URL that should reach it. */
  url: string;
  host: string;
  port: number;
  version: string | null;
};

/**
 * Advertise this collector.
 *
 * The TXT record carries what a browser needs in order to tell two brains apart
 * without connecting to either: the stable id, the display name and the
 * version. `id` is the one that matters -- a fleet with two collectors called
 * "MacBookPro" is entirely possible, and the id is what a config file should
 * pin.
 */
export function advertise(opts: {
  id: string;
  name: string;
  port: number;
  version: string;
  log?: (msg: string) => void;
}): Advertised {
  const log = opts.log ?? (() => {});
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    // The instance name is what a person sees in a picker, so it is the brain's
    // name rather than its id. Two brains with the same name are disambiguated
    // by Bonjour itself, which appends a number -- and by the id in the TXT
    // record, which is what anything automatic should read.
    name: opts.name,
    type: SERVICE_TYPE,
    port: opts.port,
    txt: { id: opts.id, name: opts.name, ver: opts.version },
  });
  service.on("error", (e: Error) => log(`mDNS advertisement failed: ${e.message}`));
  log(`advertising as "${opts.name}" over mDNS (_${SERVICE_TYPE}._tcp on :${opts.port})`);

  return {
    stop: async () => {
      // Unpublishing sends a goodbye packet with TTL 0, so a browser that is
      // already running drops this brain immediately rather than showing it for
      // the remaining lifetime of the record. Without it, `fleet join
      // --discover` lists collectors that stopped minutes ago, which is a worse
      // answer than listing none.
      await new Promise<void>((resolve) => bonjour.unpublishAll(() => resolve()));
      bonjour.destroy();
    },
  };
}

/**
 * Look for brains on this link for `ms`, then answer with what replied.
 *
 * Time-boxed rather than a live subscription, because every caller is a person
 * waiting at a prompt or a screen being drawn. A browser that stayed open would
 * be a better API for a daemon and a worse one for the two things that actually
 * use this.
 */
export function browse(ms = 2_000): Promise<FoundBrain[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map<string, FoundBrain>();
    let browser: Browser | null = null;

    const finish = () => {
      try {
        browser?.stop();
        bonjour.destroy();
      } catch {
        /* nothing useful to do about a failure to stop looking */
      }
      resolve([...found.values()]);
    };

    try {
      browser = bonjour.find({ type: SERVICE_TYPE }, (service: Service) => {
        const brain = toBrain(service);
        if (!brain) return;
        // Keyed on id when there is one, so a brain answering on several
        // interfaces is one entry rather than three. Falling back to the URL
        // keeps a collector too old to publish an id visible instead of
        // collapsing every such collector into one row.
        found.set(brain.id ?? brain.url, brain);
      });
    } catch (e) {
      // No multicast on this host, or a socket the OS would not give us. That
      // is an ordinary state of affairs on a locked-down network, and the
      // caller's fallback is the URL field that has always existed.
      void e;
      return finish();
    }

    setTimeout(finish, ms).unref();
  });
}

/**
 * Turn a DNS-SD answer into something usable, or null.
 *
 * The address is the interesting part. A service advertises a hostname, several
 * IPv4 addresses and several IPv6 addresses, and which of them is reachable
 * depends on the asker. IPv4 is preferred here for a plain reason: the fleet's
 * agents include a Roku channel and a browser page on a smart TV, and an
 * address of the form `http://[fe80::1%en0]:8788` is not something every one of
 * those can parse, let alone one somebody might have to read aloud.
 */
export function toBrain(service: Service): FoundBrain | null {
  const port = service.port;
  if (!port) return null;
  const txt = (service.txt ?? {}) as Record<string, string>;
  const v4 = (service.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  // A link-local IPv6 address needs a zone index to be usable and the zone is
  // the asker's, not the advertiser's -- so it is skipped rather than offered
  // as a URL that works on one machine and not the next.
  const v6 = (service.addresses ?? []).find((a) => a.includes(":") && !a.startsWith("fe80"));
  const host = v4 ?? v6 ?? service.host ?? null;
  if (!host) return null;
  const authority = host.includes(":") ? `[${host}]` : host;
  return {
    id: txt.id ?? null,
    name: txt.name ?? service.name ?? host,
    url: `http://${authority}:${port}`,
    host,
    port,
    version: txt.ver ?? null,
  };
}

/**
 * Whether this host has an interface mDNS could plausibly work on.
 *
 * Used only to say something useful when a browse finds nothing: "no brains
 * found" and "this machine has no non-loopback network interface" are very
 * different problems and look identical from the outside.
 */
export function hasMulticastableInterface(): boolean {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === "IPv4") return true;
    }
  }
  return false;
}
