/**
 * Clock offset against NTP.
 *
 * A skewed executor clock is the failure nothing else reveals: every duration
 * in the results table is computed from timestamps this machine wrote, so a
 * clock two minutes fast does not look like a broken clock, it looks like
 * builds that got slower. The self-check workload posts the offset so the
 * alert engine can say which it is.
 *
 * Spoken directly over UDP rather than shelled to `sntp`/`ntpdate`, because
 * neither is present by default on macOS 13+ or on a minimal Linux, and a
 * check that reports "skipped" on every machine checks nothing.
 */
import dgram from "node:dgram";

/** Seconds between the NTP epoch (1900-01-01) and the Unix one. */
export const NTP_EPOCH_OFFSET_S = 2_208_988_800;

export const DEFAULT_NTP_HOST = "pool.ntp.org";
export const NTP_PORT = 123;

/**
 * Reads one 64-bit NTP timestamp out of a packet, as Unix milliseconds.
 *
 * The wire format is 32 bits of seconds since 1900 and 32 bits of fractional
 * second. Returns null for a zero timestamp — an unsynchronised server sends
 * zeros, and turning that into 1900 would report an offset of about
 * -3.9 × 10^12 ms and take the alert with it.
 */
export function readNtpTimestamp(buf: Buffer, at: number): number | null {
  if (buf.length < at + 8) return null;
  const seconds = buf.readUInt32BE(at);
  const fraction = buf.readUInt32BE(at + 4);
  if (seconds === 0 && fraction === 0) return null;
  return (seconds - NTP_EPOCH_OFFSET_S) * 1000 + (fraction / 2 ** 32) * 1000;
}

export type NtpSample = {
  /** Local clock when the request left. */
  t1: number;
  /** Server clock when it arrived. */
  t2: number;
  /** Server clock when the reply left. */
  t3: number;
  /** Local clock when the reply arrived. */
  t4: number;
};

/**
 * The standard NTP offset: ((t2 - t1) + (t3 - t4)) / 2.
 *
 * Positive means the server is ahead of this machine — this machine is slow.
 * The averaging is what cancels the network path: half the round trip is spent
 * in each direction, so the two differences carry that delay with opposite
 * signs and it falls out. Subtracting t1 from t2 alone would report the
 * one-way latency as clock skew, which on a busy Wi-Fi link is tens of
 * milliseconds of pure fiction.
 */
export function offsetMs(s: NtpSample): number {
  return ((s.t2 - s.t1) + (s.t3 - s.t4)) / 2;
}

/** Round-trip delay, for deciding whether a sample is worth believing. */
export function roundTripMs(s: NtpSample): number {
  return (s.t4 - s.t1) - (s.t3 - s.t2);
}

/** A client-mode NTPv4 request: LI 0, VN 4, Mode 3 in the first byte, rest zero. */
export function clientPacket(): Buffer {
  const buf = Buffer.alloc(48);
  buf[0] = (0 << 6) | (4 << 3) | 3;
  return buf;
}

/**
 * Asks one NTP server for the time. Null on any failure — no server, no
 * network, a firewall that eats UDP 123, a garbage reply — because the rule
 * every probe in this repo obeys is answer or answer null, and a self-check
 * that throws when the wifi is down reports nothing about the disk either.
 */
export function ntpOffsetMs(
  host: string = process.env.FLEET_NTP_HOST ?? DEFAULT_NTP_HOST,
  timeoutMs = 3000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };

    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Stamped before the send, so the round trip this offset corrects for
    // includes the DNS lookup and the socket write rather than starting after
    // them.
    const t1 = Date.now();
    socket.on("error", () => finish(null));
    socket.on("message", (msg) => {
      const t4 = Date.now();
      const t2 = readNtpTimestamp(msg, 32); // receive timestamp
      const t3 = readNtpTimestamp(msg, 40); // transmit timestamp
      if (t2 === null || t3 === null) return finish(null);
      finish(Math.round(offsetMs({ t1, t2, t3, t4 })));
    });
    socket.send(clientPacket(), NTP_PORT, host, (err) => {
      if (err) finish(null);
    });
  });
}
