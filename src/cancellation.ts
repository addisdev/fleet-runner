/**
 * Cancellation flag for the job this agent is running.
 *
 * The beacon loop is what hears about a cancellation — the collector answers a
 * beacon carrying a job_id with `lease_renewed: false` once the claim is gone,
 * whether the dashboard cancelled the job or the sweep took the lease back —
 * but the workload that has to stop is somewhere else in the event loop. One
 * job runs at a time, so a single slot holding that job's id is the whole
 * mechanism, exactly as on the two phone runners.
 */
let cancelledJobId: string | null = null;

/** Marks a job cancelled; its workload stops at the next iteration boundary. */
export function cancel(jobId: string): void {
  cancelledJobId = jobId;
}

export function isCancelled(jobId: string): boolean {
  return cancelledJobId === jobId;
}

/** Drops the flag, so a later job of the same name starts clean. */
export function clear(jobId: string): void {
  if (cancelledJobId === jobId) cancelledJobId = null;
}
