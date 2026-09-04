// Shared presentational bits and the formatters every page needs.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.js";
import { BASE, navigate, useRoute } from "./router.js";

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ComponentChildren } & JSX.HTMLAttributes<HTMLAnchorElement>) {
  const route = useRoute();
  // A nav link stays "current" whatever filters the page carries.
  const path = to.split("?")[0];
  const onClick = (e: MouseEvent) => {
    // Leave modified clicks alone: cmd-click into a new tab must still work.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={`${BASE}${to === "/" ? "" : to}`} onClick={onClick} aria-current={route === path ? "page" : undefined} {...rest}>
      {children}
    </a>
  );
}

export function Panel({ title, children, aside }: { title?: string; children: ComponentChildren; aside?: ComponentChildren }) {
  return (
    <section class="panel">
      {title && (
        <div class="panel-head">
          <h2>{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * True for one beat after `value` changes — false on the first render.
 *
 * The dashboard updates numbers in place from the live stream, which is right
 * (re-animating a whole panel because one count moved would be noise) but
 * makes a change easy to miss entirely if you happened to look away. This is
 * the smallest signal that says "that number just moved": no layout shift, no
 * colour flash, gone in 180ms.
 */
function useChanged(value: unknown): boolean {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    setChanged(true);
    const t = setTimeout(() => setChanged(false), 220);
    return () => clearTimeout(t);
  }, [value]);

  return changed;
}

export function Stat({ label, value, tone }: { label: string; value: ComponentChildren; tone?: "ok" | "warn" | "bad" }) {
  // Only primitives are worth watching: a tile rendering an element gets a new
  // vnode every render and would flash forever.
  const watchable = typeof value === "string" || typeof value === "number" ? value : null;
  const changed = useChanged(watchable);
  return (
    <div class={`stat${tone ? ` ${tone}` : ""}${changed ? " changed" : ""}`}>
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

/* Every state gets an icon — device states and job states alike.
   Device states are read across a whole shelf at a glance; job states are read
   down a long Jobs table, where a column of identical circles differing only
   inside is faster to scan than five words of similar length. The word stays
   in every pill, so the icon is never the only thing carrying the meaning. */
const PILL_ICON: Partial<Record<string, IconName>> = {
  online: "online",
  stale: "stale",
  offline: "offline",
  queued: "queued",
  claimed: "claimed",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export const Pill = ({ kind, children }: { kind: string; children?: ComponentChildren }) => {
  const icon = PILL_ICON[kind];
  return (
    <span class={`pill ${kind}`}>
      {icon && <Icon name={icon} size={11} />}
      {children ?? kind}
    </span>
  );
};

/**
 * A shape-true placeholder for the panel that is about to arrive.
 *
 * "Loading devices…" told you the same thing every skeleton does, but the page
 * then jumped from one line of text to a full table. A placeholder shaped like
 * its panel means the layout is already correct when the data lands, so
 * nothing below it moves.
 *
 * `what` is still announced, for anyone who is being read the page rather than
 * looking at it — the blocks themselves are decoration and stay hidden.
 */
export function Loading({ what, shape = "rows" }: { what: string; shape?: "rows" | "stats" | "none" }) {
  if (shape === "none") return <p class="skeleton">Loading {what}…</p>;
  return (
    <div role="status" aria-live="polite">
      <span class="visually-hidden">Loading {what}…</span>
      {shape === "stats" ? (
        <div class="sk-stats" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} class="sk sk-stat" />
          ))}
        </div>
      ) : (
        <div class="sk-rows" aria-hidden="true">
          <div class="sk sk-head" />
          <div class="sk sk-row" />
          <div class="sk sk-row" style={{ width: "82%" }} />
          <div class="sk sk-row" style={{ width: "91%" }} />
        </div>
      )}
    </div>
  );
}

export function ErrorBox({ error }: { error: Error }) {
  return <p class="error">{error.message}</p>;
}

export const Empty = ({ children }: { children: ComponentChildren }) => <p class="empty">{children}</p>;

/** Renders the three states every fetched panel has, so no page reimplements them. */
export function Loaded<T>({
  state,
  what,
  shape,
  empty,
  children,
}: {
  state: { data: T | null; error: Error | null; loading: boolean };
  what: string;
  /** Shape of the placeholder while the first response is in flight. */
  shape?: "rows" | "stats" | "none";
  /** Drawn instead of the plain "No x." sentence when the fetch returns nothing. */
  empty?: ComponentChildren;
  children: (data: T) => ComponentChildren;
}) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (!state.data)
    return state.loading ? <Loading what={what} shape={shape} /> : <>{empty ?? <Empty>No {what}.</Empty>}</>;
  return <>{children(state.data)}</>;
}

/**
 * A clock that ticks, for anything counting down between polls.
 *
 * Lease countdowns used to move only when the 30s refresh landed, so a bar
 * that should drain smoothly jumped in six-percent steps and a "1m 20s left"
 * could sit there reading 1m 20s for half a minute. The deadline is already in
 * the payload — this just lets the page do the subtraction itself, which is
 * arithmetic on data the collector sent, not a number the page invented.
 */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // A backgrounded tab has nothing to redraw; setInterval there is pure
    // wake-ups. It resyncs on the way back in.
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, everyMs);
    const on = () => setNow(Date.now());
    addEventListener("visibilitychange", on);
    return () => {
      clearInterval(id);
      removeEventListener("visibilitychange", on);
    };
  }, [everyMs]);
  return now;
}

/**
 * A lease, counted down locally from its deadline.
 *
 * Returns the same two numbers the API sends — seconds left and the fraction
 * of the window remaining — recomputed for this instant. The window length is
 * recovered from the pair the collector sent (remaining ÷ fraction) rather
 * than assumed, so a job with a non-default lease_ttl_s drains at its own rate.
 */
export function leaseNow(
  job: { lease_deadline: string | null; lease_remaining_s: number | null; lease_fraction: number | null },
  now: number,
): { remaining_s: number | null; fraction: number | null } {
  if (!job.lease_deadline) return { remaining_s: job.lease_remaining_s, fraction: job.lease_fraction };
  const remaining = Math.max(0, (new Date(job.lease_deadline).getTime() - now) / 1000);
  const ttl =
    job.lease_remaining_s != null && job.lease_fraction ? job.lease_remaining_s / job.lease_fraction : null;
  return {
    remaining_s: remaining,
    fraction: ttl && ttl > 0 ? Math.max(0, Math.min(1, remaining / ttl)) : job.lease_fraction,
  };
}

// --- formatters ---

/** Compact duration: the dashboard is read at a glance, so "3h 12m", not "3:12:44". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.abs(Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function ago(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return seconds < 5 ? "just now" : `${duration(seconds)} ago`;
}

export function agoFrom(iso: string | null | undefined): string {
  if (!iso) return "—";
  return ago((Date.now() - new Date(iso).getTime()) / 1000);
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Local wall-clock time; the fleet and its owner share a timezone. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const short = (id: string, max = 34) => (id.length <= max ? id : `${id.slice(0, max - 1)}…`);

/** Round for reading, not for precision: benchmark tables want 47.4, not
 *  47.38271604938272. Never applied to a stored value, only to its display. */
export function num(v: unknown, digits = 1): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

// --- form controls ---

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: (string | { value: string; label: string })[];
  onChange: (v: string) => void;
}) {
  const norm = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <label class="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">any</option>
        {norm.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Search({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        // Committed on Enter/blur rather than per keystroke: each change is a
        // history entry and a refetch, and neither should happen mid-word.
        onChange={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

export function Filters({ children, onClear, active }: { children: ComponentChildren; onClear?: () => void; active?: boolean }) {
  return (
    <div class="filters">
      {children}
      {active && onClear && (
        <button type="button" class="linkish" onClick={onClear}>
          clear
        </button>
      )}
    </div>
  );
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return <p class="empty">{total} total</p>;
  return (
    <div class="pager">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← prev
      </button>
      <span class="dim">
        page {page} of {pages} · {total} total
      </span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        next →
      </button>
    </div>
  );
}

/** Collapsed by default: a job spec is reference material, not the first thing
 *  you need to see on the page. */
export function Json({ value, label = "JSON", open = false }: { value: unknown; label?: string; open?: boolean }) {
  return (
    <details class="json" open={open}>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function Button({
  children,
  onClick,
  tone,
  busy,
  disabled,
  title,
}: {
  children: ComponentChildren;
  onClick: () => void;
  tone?: "danger" | "primary";
  busy?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" class={`btn${tone ? ` ${tone}` : ""}`} onClick={onClick} disabled={busy || disabled} title={title}>
      {busy ? "…" : children}
    </button>
  );
}

/**
 * A two-step button. Destructive actions get a deliberate second click rather
 * than a modal: the confirm state names what will happen, and wanders off after
 * a few seconds so a half-pressed cancel does not sit armed on a shared screen.
 */
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  tone = "danger",
  busy,
  disabled,
}: {
  children: ComponentChildren;
  confirm: string;
  onConfirm: () => void;
  tone?: "danger" | "primary";
  busy?: boolean;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed)
    return (
      <Button tone={tone} onClick={() => setArmed(true)} busy={busy} disabled={disabled}>
        {children}
      </Button>
    );
  return (
    <span class="confirm">
      <Button
        tone={tone}
        busy={busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirm}
      </Button>
      <button type="button" class="linkish" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  );
}

export const Actions = ({ children }: { children: ComponentChildren }) => <div class="actions">{children}</div>;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field wide">
      <span>{label}</span>
      {children}
      {hint && <small class="faint">{hint}</small>}
    </label>
  );
}

/**
 * A device, by name.
 *
 * One name, not a name and an id stacked together. The id is still what job
 * specs pin and what `adb devices` prints, so it stays available on hover and
 * on the device's own page — but a list of machines should read like a list of
 * machines.
 */
export function DeviceName({ id, names, link = true }: { id: string; names: Record<string, string>; link?: boolean }) {
  const named = names[id];
  const body = named ? <span>{named}</span> : <code>{id}</code>;
  return link ? (
    <Link to={`/devices/${encodeURIComponent(id)}`} title={id}>
      {body}
    </Link>
  ) : (
    <span title={id}>{body}</span>
  );
}

export function CopyId({ text }: { text: string }) {
  return (
    <button
      type="button"
      class="linkish"
      title="Copy to clipboard"
      onClick={() => void navigator.clipboard?.writeText(text)}
    >
      copy
    </button>
  );
}
