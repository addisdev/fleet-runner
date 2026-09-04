import Foundation

/// The one percentile the runners report, defined once.
///
/// The vision eval established the convention — nearest rank,
/// `sorted[n * p / 100]` — and p50_ms / p95_ms mean that in its rows. Every
/// workload reporting those names has to compute them the same way or the
/// column stops being one column, so the arithmetic lives here rather than
/// being retyped per workload. The Android runner keeps the same definition in
/// `workload/Percentile.kt`.
enum Percentile {

    /// The `p`th percentile of `values`. nil for an empty run, which keeps "no
    /// samples" distinguishable from "0 ms" — a distinction the vantage rows
    /// depend on, because a request that never connected has no latency rather
    /// than a zero one.
    static func of(_ values: [Double], _ p: Int) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        return sorted[min((sorted.count * p) / 100, sorted.count - 1)]
    }
}
