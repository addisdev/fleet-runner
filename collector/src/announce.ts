/**
 * Every fleet-state change fans out to connected dashboards, drops the
 * overview's short cache, and reaches anything in this process waiting on it.
 * Called after the write commits, never inside a transaction -- a broken
 * browser pipe must not roll back a device's result.
 *
 * Its own module because the queue, the protocol routes and the control API
 * all announce, and `GET /api/v1/jobs/:id/wait` listens: a waiter woken by the
 * same event the dashboard gets cannot disagree with the dashboard.
 */
import { invalidateOverview } from "./api/overview.js";
import { publish, type FleetEvent } from "./api/stream.js";

type Listener = (event: FleetEvent) => void;
const listeners = new Set<Listener>();

export function announce(event: FleetEvent): void {
  invalidateOverview();
  publish(event);
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch {
      // A waiter that threw is its own problem, not the next listener's.
    }
  }
}

/** Hear every announcement until the returned function is called. */
export function onAnnounce(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
