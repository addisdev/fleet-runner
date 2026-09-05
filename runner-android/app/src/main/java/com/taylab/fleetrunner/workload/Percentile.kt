package com.taylab.fleetrunner.workload

/**
 * The one percentile the runners report, defined once.
 *
 * The vision eval established the convention — nearest rank, `sorted[n * p /
 * 100]` — and p50_ms / p95_ms mean that in its rows. Every workload that
 * reports those names has to compute them the same way or the column stops
 * being one column, so the arithmetic lives here rather than being retyped
 * per engine.
 */
object Percentile {

    /**
     * The [p]th percentile of an already-sorted array. NaN for an empty run,
     * which keeps "no samples" distinguishable from "0 ms" — a distinction the
     * vantage rows depend on, because a request that never connected has no
     * latency rather than a zero one.
     */
    fun of(sorted: DoubleArray, p: Int): Double {
        if (sorted.isEmpty()) return Double.NaN
        return sorted[((sorted.size * p) / 100).coerceIn(0, sorted.size - 1)]
    }

    /** [of] over an unsorted collection, sorting a copy. */
    fun ofUnsorted(values: Collection<Double>, p: Int): Double =
        of(values.toDoubleArray().also { it.sort() }, p)
}
