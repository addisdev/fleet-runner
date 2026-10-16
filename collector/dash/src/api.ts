// Typed access to the collector's read API, plus the hooks the pages use.
import { useEffect, useRef, useState } from "preact/hooks";
import { onLive } from "./live.js";
import { tokenHeader } from "./token.js";
import type { JobDetail } from "./client.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith("/") ? path : `/api/${path}`, {
    ...init,
    headers: { accept: "application/json", ...tokenHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // The API answers unknown /api paths with JSON, so an HTML body here means
    // something upstream (a proxy, a stale bundle) is answering instead.
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export type Loadable<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };

/**
 * Fetch on mount, again whenever a live event names one of `topics`, and on a
 * slow timer if `refreshMs` is set. The stream carries a nudge, not a payload:
 * the page refetches the endpoint it already trusts rather than trying to patch
 * its own copy of the state.
 *
 * The timer is not a fallback for the stream — it exists because a screen full
 * of "3m ago" and lease countdowns goes stale on its own, with no event to say so.
 */
export function useApi<T>(path: string | null, topics: string[] = [], refreshMs = 0): Loadable<T> {
  return useLoad<T>(path, () => api<T>(path!), topics, refreshMs);
}

/**
 * useApi for anything that returns a promise -- the generated /api/v1 client,
 * mostly. `key` stands in for the path: it changes exactly when the request
 * would, and null means "not yet".
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>, topics: string[] = [], refreshMs = 0): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const [nonce, setNonce] = useState(0);
  // Guards against a slow first response overwriting a fast second one.
  const seq = useRef(0);
  // The loader closes over the render that made it; the effect below runs on
  // key changes only, so it reads the newest one from here.
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    if (key === null) return;
    const mine = ++seq.current;
    setLoading(true);
    loader.current()
      .then((d) => {
        if (seq.current === mine) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (seq.current === mine) setError(e as Error);
      })
      .finally(() => {
        if (seq.current === mine) setLoading(false);
      });
  }, [key, nonce]);

  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    if (topics.length === 0) return;
    // Coalesce bursts: a fan-out enqueue publishes one event per child, and
    // refetching once per child would hammer the collector.
    let timer: number | undefined;
    return onLive(topics, () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 250) as unknown as number;
    });
  }, [topics.join(",")]);

  useEffect(() => {
    if (!refreshMs) return;
    // A hidden tab left open for a week should not keep waking the collector.
    const tick = () => document.visibilityState === "visible" && reload();
    const id = setInterval(tick, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  return { data, error, loading, reload };
}

// --- response shapes ---
//
// Devices, jobs and their details come from /api/v1, so their types are the
// generated client's (collector/src/client/api.gen.ts), re-exported here for
// the pages that import them from this file. Do not redeclare them: a copy is
// how the dashboard drifted from the server before.
export type { Device, DeviceDetail, DeviceList, Job, JobDetail, JobList } from "./client.js";
export type ResultRow = JobDetail["results"][number];

// The rest mirror unversioned /api/* routes that /api/v1 does not offer yet.

export type Peer = {
  url: string;
  id: string | null;
  name: string | null;
  reachable: boolean;
  error: string | null;
  devices: { total: number; online: number } | null;
};

export type Peers = {
  self: { id: string; name: string };
  peers: Peer[];
  configured: number;
};

export type Overview = {
  generated_at: string;
  devices: {
    total: number;
    online: number;
    stale: number;
    offline: number;
    busy: number;
    idle: number;
    charging: number;
    low_battery: number;
    low_battery_devices: string[];
    worst_thermal: string | null;
    by_pool: Record<string, number>;
  };
  queue: {
    queued: number;
    claimed: number;
    done_24h: number;
    failed_24h: number;
    skipped_24h: number;
    last_attempt: number;
    oldest_queued_age_s: number | null;
  };
  running: {
    job_id: string;
    workload: string;
    executor: string;
    claimed_by: string | null;
    claimed_at: string | null;
    attempts: number;
    max_attempts: number;
    lease_deadline: string | null;
    lease_remaining_s: number | null;
    lease_fraction: number | null;
    elapsed_s: number | null;
  }[];
  recent_failures: {
    job_id: string;
    workload: string;
    executor: string;
    claimed_by: string | null;
    last_error: string | null;
    finished_at: string | null;
    attempts: number;
    max_attempts: number;
  }[];
  schedules: {
    total: number;
    enabled: number;
    missed: number;
    next: { id: string; cron: string; next_run: string | null; next_run_in_s: number | null; missed: boolean }[];
  };
  health: Health;
};

export type BeaconSample = {
  ts: string | null;
  battery_pct: number | null;
  charging: boolean | null;
  thermal: string | null;
  mem_mb: number | null;
  mem_method: string | null;
  process_alive: boolean | null;
  job_id: string | null;
};

export type BeaconHistory = { device_id: string; hours: number; count: number; samples: BeaconSample[] };

export type RecentResults = {
  results: {
    job_id: string;
    device_id: string;
    iter: number;
    workload: string;
    final: boolean;
    ok: boolean;
    created_at: string | null;
    age_s: number;
    summary: string;
  }[];
};

export type Locks = { locks: { device_id: string; job_id: string; acquired_at: string | null; held_s: number }[] };

/** The health block inside /api/overview. The token banner reads /api/v1/health instead. */
export type Health = {
  ok: boolean;
  instance: string;
  started_at: string;
  uptime_s: number;
  now: string;
  node: string;
  pid: number;
  stream_clients: number;
  guard: boolean;
  /** "tokens" when every read needs a token too, not only changes. */
  auth?: "off" | "tokens";
};

// --- night-QA findings (mirrors src/findings.ts) ---

// Findings, one finding and the verdict come from /api/v1, so their types are
// the generated client's. The precision table is not in /api/v1 and keeps its
// own type below.
export type { Finding, FindingDetail, FindingList } from "./client.js";
import type { Finding as V1Finding } from "./client.js";
export type FindingVerdict = NonNullable<V1Finding["verdict"]>;

export type FindingPrecision = {
  floor: number;
  min: number;
  classes: {
    app: string;
    check: string;
    subclass: string | null;
    open: number;
    real: number;
    duplicate: number;
    not_a_bug: number;
    agent_mistake: number;
    judged: number;
    precision: number | null;
    disabled: boolean;
  }[];
  disabled: { app: string; check: string; subclass: string | null; precision: number | null; judged: number }[];
};
