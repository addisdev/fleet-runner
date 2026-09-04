package com.taylab.fleetrunner

import java.util.concurrent.atomic.AtomicReference

/**
 * Cross-coroutine cancellation flag for the job this runner is executing.
 *
 * The beacon loop is what hears about a cancellation — the collector answers a
 * beacon carrying a job_id with `lease_renewed: false` once the claim is gone,
 * whether the dashboard cancelled the job or the sweeper took the lease back —
 * but the engine that has to stop is running on a different coroutine, so the
 * news has to cross a thread boundary. One job runs at a time, so a single
 * atomic slot holding that job's id is the whole mechanism.
 */
object JobCancellation {

    private val cancelled = AtomicReference<String?>(null)

    /** Marks [jobId] cancelled; its engine stops at the next iteration boundary. */
    fun cancel(jobId: String) {
        cancelled.set(jobId)
    }

    fun isCancelled(jobId: String): Boolean = cancelled.get() == jobId

    /** Drops [jobId]'s flag, so a later job of the same name starts clean. */
    fun clear(jobId: String) {
        cancelled.compareAndSet(jobId, null)
    }
}
