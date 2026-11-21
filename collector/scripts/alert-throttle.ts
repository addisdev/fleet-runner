/**
 * How many banners the alert receiver may raise, decided without touching the
 * screen, so a test can drive it with a fake clock.
 *
 * The receiver used to raise one banner per alert. Over the seven days to
 * 2026-11-16 that was 168 banners on the owner's Mac -- job-failed 117,
 * schedule-missed 42 -- about two dozen a day, some with a sound at 3 a.m. The
 * dashboard already holds every alert; a banner only has to say "look". So:
 *
 * - **One banner per alert kind per hour.** The first alert of a kind shows at
 *   once. Later ones in that hour are counted, and when the hour ends the count
 *   becomes one banner ("fleet: job-failed ×6 in the last hour") carrying the
 *   latest alert's text. That summary starts a new hour of its own, so a kind
 *   that keeps firing is one banner an hour, never two in a minute.
 * - **Sound only where waiting costs something:** a thermally critical device
 *   and a stuck job. Everything else is silent, whatever priority it was sent
 *   at.
 * - **Nothing for a host that is off on purpose.** `FLEET_ALERT_QUIET_HOSTS`
 *   names hosts somebody turned off (fleet-host, 2026-11-16); a
 *   `schedule-missed` or `device-offline` that names one is logged and not
 *   shown. The collector has no retired or paused state for a host, so the
 *   receiver is told.
 */

export type IncomingAlert = { title: string; body: string; priority: string };

export type Banner = { title: string; message: string; sound: boolean };

export type Outcome = {
  /** The alert kind: the collector's rule name, or the title for anything else. */
  rule: string;
  /** true: a banner now. "folded": counted into the hour's summary. false: never shown. */
  shown: true | false | "folded";
  reason?: string;
};

/** A summary banner raised when an hour with folded alerts ends. */
export type Summary = { rule: string; folded: number; banner: Banner };

export const SOUND_RULES: ReadonlySet<string> = new Set(["thermal-critical", "job-stuck"]);

/** Rules that say a host is missing, which is no news for a host turned off on purpose. */
export const QUIET_HOST_RULES: ReadonlySet<string> = new Set(["schedule-missed", "device-offline"]);

export const HOUR_MS = 60 * 60 * 1000;

/** "fleet: job-failed" -> "job-failed"; any other sender's title is its own kind. */
export function ruleOf(title: string): string {
  const t = title.trim();
  const m = /^fleet:\s*(.+)$/i.exec(t);
  return (m ? m[1] : t).trim() || "fleet";
}

/** FLEET_ALERT_QUIET_HOSTS: comma- or space-separated host names. */
export function parseQuietHosts(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
}

/** Whether the text names the host as a whole word ("fleet-host", not "fleet-hostess"). */
export function mentionsHost(text: string, host: string): boolean {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`, "i").test(text);
}

type Timer = { cancel(): void };
type Window = { folded: number; latest: IncomingAlert | null; timer: Timer };

export type ThrottleOptions = {
  quietHosts?: string[];
  windowMs?: number;
  /** Raise a banner. The receiver passes osascript; tests pass an array push. */
  show: (b: Banner, why: { rule: string; summary?: Summary }) => void;
  /** Schedule fn after ms. Defaults to setTimeout, unref'd. */
  setTimer?: (fn: () => void, ms: number) => Timer;
};

const realTimer = (fn: () => void, ms: number): Timer => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class AlertThrottle {
  private readonly windows = new Map<string, Window>();
  private readonly quietHosts: string[];
  private readonly windowMs: number;
  private readonly show: ThrottleOptions["show"];
  private readonly setTimer: NonNullable<ThrottleOptions["setTimer"]>;

  constructor(opts: ThrottleOptions) {
    this.quietHosts = opts.quietHosts ?? [];
    this.windowMs = opts.windowMs ?? HOUR_MS;
    this.show = opts.show;
    this.setTimer = opts.setTimer ?? realTimer;
  }

  receive(a: IncomingAlert): Outcome {
    const rule = ruleOf(a.title);

    if (QUIET_HOST_RULES.has(rule)) {
      const host = this.quietHosts.find((h) => mentionsHost(`${a.title}\n${a.body}`, h));
      if (host) return { rule, shown: false, reason: `quiet host ${host}` };
    }

    const w = this.windows.get(rule);
    if (w) {
      w.folded += 1;
      w.latest = a;
      return { rule, shown: "folded" };
    }

    this.open(rule);
    this.show({ title: a.title, message: a.body || "(no message)", sound: SOUND_RULES.has(rule) }, { rule });
    return { rule, shown: true };
  }

  /** Kinds with an hour running, and how many alerts each has folded so far. */
  pending(): Record<string, number> {
    return Object.fromEntries([...this.windows].map(([k, w]) => [k, w.folded]));
  }

  private open(rule: string) {
    this.windows.set(rule, {
      folded: 0,
      latest: null,
      timer: this.setTimer(() => this.close(rule), this.windowMs),
    });
  }

  private close(rule: string) {
    const w = this.windows.get(rule);
    this.windows.delete(rule);
    if (!w || w.folded === 0 || !w.latest) return;
    const title = `fleet: ${rule} ×${w.folded} in the last hour`;
    const banner = { title, message: w.latest.body || w.latest.title, sound: SOUND_RULES.has(rule) };
    const summary = { rule, folded: w.folded, banner };
    // The summary is this kind's banner for the next hour, so anything that
    // arrives in it folds into the next summary rather than showing at once.
    this.open(rule);
    this.show(banner, { rule, summary });
  }

  /** Stop every timer (tests, shutdown). Folded counts not yet shown are dropped. */
  stop() {
    for (const w of this.windows.values()) w.timer.cancel();
    this.windows.clear();
  }
}
