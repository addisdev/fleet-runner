// Inline stroke icons on a 16 grid, from the dashboard's asset sheet.
//
// Every icon is currentColor, so it takes the colour of the text it sits
// beside and needs no theme rule of its own — and every icon sits next to its
// word, never instead of it: the pills, battery and workload cells still read
// as text, the icon only makes them faster to scan.
import type { ComponentChildren } from "preact";

const PATHS = {
  phone: (
    <>
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75" />
      <path d="M7 12h2" />
    </>
  ),
  // Dashed outline: a phone that is not really there.
  simulator: (
    <>
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75" stroke-dasharray="2 1.6" />
      <path d="M7 12h2" />
    </>
  ),
  host: (
    <>
      <rect x="2.75" y="3.25" width="10.5" height="7.5" rx="1.25" />
      <path d="M1.5 12.75h13" />
    </>
  ),
  online: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.1 11.9a5.5 5.5 0 0 1 0-7.8M11.9 4.1a5.5 5.5 0 0 1 0 7.8" />
    </>
  ),
  stale: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  offline: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M4.1 11.9a5.5 5.5 0 0 1 0-7.8M11.9 4.1a5.5 5.5 0 0 1 0 7.8" />
      <path d="M2.5 13.5l11-11" />
    </>
  ),
  busy: <path d="M5 3.25v9.5l7.5-4.75z" />,
  charging: <path d="M9 1.75L3.75 9h4l-.75 5.25L12.25 7h-4z" />,
  thermal: (
    <>
      <path d="M6 9.4V3.25a2 2 0 0 1 4 0V9.4a3 3 0 1 1-4 0z" />
      <path d="M8 7v3.5" />
    </>
  ),
  hammer: (
    <>
      <path d="M2.75 13.25l5-5M6.5 5.25l2.5-2.5 1.5 1.5 1.75-1 1.5 1.5-1 1.75 1.5 1.5-2.5 2.5z" />
    </>
  ),
  waveform: (
    <>
      <path d="M1.75 8h1.5M5 4.5v7M7.75 6.25v3.5M10.5 2.75v10.5M13.25 6.25v3.5" />
    </>
  ),
  vector: (
    <>
      <circle cx="4" cy="11.5" r="1.75" />
      <circle cx="11.5" cy="4.5" r="1.75" />
      <path d="M5.4 10.2l4.8-4.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.9 8h12.2M8 1.75c1.6 1.8 2.4 3.9 2.4 6.25S9.6 12.45 8 14.25c-1.6-1.8-2.4-3.9-2.4-6.25S6.4 3.55 8 1.75z" />
    </>
  ),
  translate: (
    <>
      <path d="M1.75 3.5h6M4.75 3.5v-1.5M6.25 3.5c0 3-1.9 5.5-4.5 6.5M3 5.75c.8 2 2.5 3.6 4.5 4.25M8.25 14l3-8 3 8M9.4 11.4h3.7" />
    </>
  ),
  accessibility: (
    <>
      <circle cx="8" cy="3" r="1.4" />
      <path d="M2.75 5.75l5.25 1 5.25-1M8 6.75v3.5M8 10.25l-2 4M8 10.25l2 4" />
    </>
  ),
  stopwatch: (
    <>
      <circle cx="8" cy="9.25" r="4.75" />
      <path d="M8 9.25V6.5M6.25 1.75h3.5M12.25 4.75l1 1" />
    </>
  ),
  heartbeat: (
    <>
      <path d="M1.75 8h3l1.5-3.5L9 11.5l1.5-3.5h3.75" />
    </>
  ),
  install: (
    <>
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5" />
      <path d="M2.5 11.5v1.25a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11.5" />
    </>
  ),
  uitest: <path d="M2.75 4.5l1.5 1.5 3-3M2.75 10.5l1.5 1.5 3-3M9.5 4.75h4M9.5 10.75h4" />,
  benchmark: (
    <>
      <path d="M2.5 11.5a6 6 0 1 1 11 0" />
      <path d="M8 11.5l3-4" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  batch: (
    <>
      <path d="M8 2.5l6 3-6 3-6-3z" />
      <path d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" />
    </>
  ),
  visual: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M8 2.75v10.5" stroke-dasharray="1.6 1.6" />
    </>
  ),
  soak: (
    <>
      <rect x="1.75" y="4.75" width="10.5" height="6.5" rx="1.5" />
      <path d="M13.25 7v2M4 7v2M6.5 7v2" />
    </>
  ),
  audit: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c2 2 2 10.5 0 12.5M8 1.75c-2 2-2 10.5 0 12.5" />
    </>
  ),
  // Three stages, left to right, joined: a pipeline is stages in an order.
  pipeline: (
    <>
      <rect x="1.75" y="5.75" width="3.5" height="4.5" rx="1" />
      <rect x="6.25" y="5.75" width="3.5" height="4.5" rx="1" />
      <rect x="10.75" y="5.75" width="3.5" height="4.5" rx="1" />
      <path d="M5.25 8h1M9.75 8h1" />
    </>
  ),
  archive: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="3" rx="1" />
      <path d="M3 5.75v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6.5" />
      <path d="M6.5 8.75h3" />
    </>
  ),
  digest: (
    <>
      <path d="M4.25 1.75h5l3 3v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z" />
      <path d="M9.25 1.75v3h3" />
      <path d="M6 8h4M6 10.5h4" />
    </>
  ),

  // --- one per navigation tab ---
  //
  // The nav used to be ten words that all looked alike at a glance, which on a
  // phone (where the row scrolls and two labels are visible) made getting
  // somewhere a reading exercise. Each of these is the screen's subject drawn
  // literally: four tiles for the overview, a phone and a tablet for devices,
  // a queue for jobs, bars for results.
  overview: (
    <>
      <rect x="1.75" y="1.75" width="5" height="5" rx="1.25" />
      <rect x="9.25" y="1.75" width="5" height="5" rx="1.25" />
      <rect x="1.75" y="9.25" width="5" height="5" rx="1.25" />
      <rect x="9.25" y="9.25" width="5" height="5" rx="1.25" />
    </>
  ),
  devices: (
    <>
      <rect x="2.25" y="2.75" width="5.5" height="10.5" rx="1.5" />
      <rect x="9.75" y="4.75" width="4.5" height="8.5" rx="1.25" />
      <path d="M4.5 11.5h1M11.5 11.5h1" />
    </>
  ),
  // Solid ticks on the left, dashed queue stretching right: work waiting.
  jobs: (
    <>
      <path d="M2.25 4h3M2.25 8h3M2.25 12h3" />
      <path d="M7.5 4h6.25M7.5 8h6.25M7.5 12h6.25" stroke-dasharray="4.5 1.75" />
    </>
  ),
  results: (
    <>
      <path d="M2.75 13.25h10.5" />
      <rect x="3" y="7.25" width="2.5" height="6" rx="0.75" />
      <rect x="6.75" y="3.25" width="2.5" height="10" rx="0.75" />
      <rect x="10.5" y="5.75" width="2.5" height="7.5" rx="0.75" />
    </>
  ),
  // A target: an eval is a score against a known answer.
  evals: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="2.75" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  schedules: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="11" rx="1.5" />
      <path d="M1.75 6.25h12.5M5 1.5v2.5M11 1.5v2.5" />
      <path d="M8 8.5v2l1.5 1" />
    </>
  ),
  events: (
    <>
      <path d="M4 2.5v11" />
      <circle cx="4" cy="4.5" r="1.25" />
      <circle cx="4" cy="8.5" r="1.25" />
      <circle cx="4" cy="12.5" r="1.25" />
      <path d="M7.5 4.5h6M7.5 8.5h4M7.5 12.5h5" />
    </>
  ),
  alerts: (
    <>
      <path d="M4 11.25V7a4 4 0 0 1 8 0v4.25l1.25 1.5H2.75z" />
      <path d="M6.75 13.75a1.25 1.25 0 0 0 2.5 0" />
    </>
  ),
  system: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="4" rx="1.25" />
      <rect x="1.75" y="9.25" width="12.5" height="4" rx="1.25" />
      <path d="M4.25 4.75h.01M4.25 11.25h.01" />
    </>
  ),

  // --- job states ---
  //
  // The same circle at the same size for every state, so a column of them
  // reads down cleanly: only what is inside the circle changes. Never used
  // alone — the pill still says the word.
  queued: <circle cx="8" cy="8" r="6.25" stroke-dasharray="2.2 2" />,
  claimed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.5 5.5v5l4-2.5z" />
    </>
  ),
  done: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5 8.25l2 2 4-4.5" />
    </>
  ),
  failed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" />
    </>
  ),
  cancelled: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5 11l6-6" />
    </>
  ),
  retry: (
    <>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.6 4.2" />
      <path d="M11.75 1.75v3h-3" />
    </>
  ),
  locked: (
    <>
      <path d="M8 1.75l5.25 2.5v4c0 2.6-2.1 4.6-5.25 6-3.15-1.4-5.25-3.4-5.25-6v-4z" />
      <path d="M5.75 8l1.5 1.5 3-3" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.5v8M5.5 8l2.5 2.5L10.5 8" />
      <path d="M3 13.25h10" />
    </>
  ),
} satisfies Record<string, ComponentChildren>;

export type IconName = keyof typeof PATHS;

/** A 16-grid stroke icon. Decorative unless given a title, in which case it
 *  is announced — use a title only when the icon carries meaning the text
 *  beside it does not (the charging bolt). */
export function Icon({ name, size = 14, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** The Fleet Runner glyph: the pulse from the launcher mark, on its ink
 *  square. This is the under-24px form of the mark, the same drawing as
 *  public/favicon.svg — the tile carries its ink as an attribute, so it is
 *  right with no stylesheet at all, and style.css lifts it on the dark shell
 *  where ink on near-ink would leave the pulse floating with no square.
 *  Decorative: the wordmark beside it says the name. */
export function Glyph({ size = 20 }: { size?: number }) {
  return (
    <svg class="glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect class="tile" width="16" height="16" rx="3.5" fill="#1c2025" />
      <path
        d="M3 8.5h2.2l1.4-4 2.4 8 1.5-4H13"
        fill="none"
        stroke="#e3a44a"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Which icon a workload gets. Covers every workload the collector accepts
 *  (WORKLOADS in src/server.ts); anything else shows its name alone, because a
 *  wrong icon would be worse than none. */
const WORKLOAD_ICON: Record<string, IconName> = {
  install: "install",
  "ui-test": "uitest",
  "web-test": "uitest",
  benchmark: "benchmark",
  batch: "batch",
  soak: "soak",
  drain: "soak",
  "web-shots": "visual",
  "web-audit": "audit",
  "web-unfurl": "audit",
  pipeline: "pipeline",
  archive: "archive",
  digest: "digest",
  thermal: "thermal",
  "cold-start": "stopwatch",
  "self-check": "heartbeat",
  build: "hammer",
  "speech-eval": "waveform",
  "embed-eval": "vector",
  vantage: "globe",
  "locale-shots": "translate",
  "app-soak": "soak",
  "a11y-audit": "accessibility",
};

/** The workload's name with its icon, for job tables. */
export function Workload({ name, children }: { name: string; children?: ComponentChildren }) {
  const icon = WORKLOAD_ICON[name];
  return (
    <span class="with-icon">
      {icon && <Icon name={icon} />}
      {name}
      {children}
    </span>
  );
}

/**
 * Which icon a nav tab gets. Keyed by route, so a tab and its icon are
 * declared in one place and a new route without an icon simply shows its word
 * rather than the wrong picture.
 */
export const NAV_ICON: Record<string, IconName> = {
  "/": "overview",
  "/devices": "devices",
  "/jobs": "jobs",
  "/results": "results",
  "/evals": "evals",
  "/visual": "visual",
  "/schedules": "schedules",
  "/artifacts": "archive",
  "/events": "events",
  "/alerts": "alerts",
  "/system": "system",
};

/**
 * A device, drawn as the object it is.
 *
 * The shelf view shows machines, not rows, so each one gets a silhouette: a
 * phone, or a laptop for a desktop runner, dashed when it is a simulator. The
 * screen carries two live facts at once — its fill is the device's status
 * colour, and the pulse is drawn on it only while the device is actually
 * online — so a shelf reads before any word on it does.
 *
 * `kind` comes from the reported OS rather than the API's `platform` field:
 * platform is a two-value ios/android split (anything not iOS is called
 * android), which would draw a MacBook running the machine runner as a phone.
 */
export function DeviceGlyph({
  kind,
  status,
  busy,
  simulator,
  size = 44,
}: {
  kind: "phone" | "laptop";
  status: "online" | "stale" | "offline";
  busy?: boolean;
  simulator?: boolean;
  size?: number;
}) {
  const cls = ["dev-glyph", status, busy ? "busy" : "", simulator ? "simulator" : ""].filter(Boolean).join(" ");

  if (kind === "laptop")
    return (
      <svg class={cls} width={size * 1.7} height={size * 1.7} viewBox="0 0 52 52" aria-hidden="true">
        <rect class="body" x="5" y="9" width="42" height="28" rx="4" />
        <rect class="screen" x="9" y="13" width="34" height="20" rx="1.5" />
        {status === "online" && <path class="pulse" d="M14 23h4l2.5-5 4 11 2.5-6h11" />}
        <path class="chin" d="M1.5 42.5h49" />
      </svg>
    );

  return (
    <svg class={cls} width={size} height={size * 1.73} viewBox="0 0 30 52" aria-hidden="true">
      <rect class="body" x="1.25" y="1.25" width="27.5" height="49.5" rx="5" />
      <rect class="screen" x="5" y="6" width="20" height="36" rx="2" />
      {status === "online" && <path class="pulse" d="M9 24h3l1.5-4 3 8 1.5-4h3" />}
      <path class="chin" d="M12 46h6" />
    </svg>
  );
}
