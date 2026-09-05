import Foundation

/// The phases of one request in milliseconds, as they are reported.
///
/// Every field is optional and that is load-bearing: a request served over a
/// pooled connection resolves no name, opens no socket and shakes no hands, so
/// those phases did not happen. Reported as 0 they would read as "instant",
/// which is a different and much more flattering claim — and one that would
/// drag every median in the run down with it.
struct RequestPhases {
    var dnsMs: Double?
    var connectMs: Double?
    var tlsMs: Double?
    var ttfbMs: Double?
    var loadMs: Int64?
}

/// Turns one `URLSessionTaskTransactionMetrics` into the five reported phases.
///
/// Given dates rather than a session, so the mapping can be checked by writing
/// timestamps down: the arithmetic here is the whole workload, and
/// "connect_ms quietly included the TLS handshake" produces perfectly
/// reasonable-looking numbers on every device in the fleet at once.
///
/// The definitions are chosen to mean the same thing as the Android runner's
/// OkHttp `EventListener` mapping, which is the only reason a phone's number
/// and a laptop's number can go in one column:
///
/// | reported     | here                                        | OkHttp                                |
/// |--------------|---------------------------------------------|---------------------------------------|
/// | `dns_ms`     | domainLookupStart → domainLookupEnd         | dnsStart → dnsEnd                     |
/// | `connect_ms` | connectStart → secureConnectionStart        | connectStart → secureConnectStart     |
/// |              | (or connectEnd when there is no TLS)        | (or connectEnd)                       |
/// | `tls_ms`     | secureConnectionStart → secureConnectionEnd | secureConnectStart → secureConnectEnd |
/// | `ttfb_ms`    | fetchStart → responseStart                  | callStart → responseHeadersStart      |
/// | `load_ms`    | fetchStart → responseEnd                    | callStart → callEnd                   |
///
/// `connect_ms` is deliberately TCP only. Apple's `connectEndDate` sits *after*
/// the handshake, so taking connectStart → connectEnd here while Android takes
/// connectStart → connectEnd there would put TCP + TLS in one platform's
/// column and TCP alone in the other's, with the handshake counted twice on one
/// side and once on the other.
enum VantageTiming {

    /// Milliseconds between two moments, never negative: a clamped 0 is a
    /// rounding artefact, a negative duration is nonsense that would poison a
    /// median rather than announce itself.
    static func ms(_ from: Date?, _ to: Date?) -> Double? {
        guard let from, let to else { return nil }
        return max(to.timeIntervalSince(from) * 1000, 0)
    }

    /// The reported phases of a transaction, from the dates it recorded.
    /// A date the OS did not fill in means the phase did not happen.
    static func phases(
        fetchStart: Date?,
        domainLookupStart: Date?, domainLookupEnd: Date?,
        connectStart: Date?, secureConnectionStart: Date?, secureConnectionEnd: Date?,
        connectEnd: Date?,
        responseStart: Date?, responseEnd: Date?
    ) -> RequestPhases {
        // TLS is a sub-interval of Apple's connect, so the TCP part ends where
        // the handshake begins; with no TLS it ends at connectEnd.
        let tcpEnd = secureConnectionStart ?? connectEnd
        return RequestPhases(
            dnsMs: ms(domainLookupStart, domainLookupEnd),
            connectMs: ms(connectStart, tcpEnd),
            tlsMs: ms(secureConnectionStart, secureConnectionEnd),
            ttfbMs: ms(fetchStart, responseStart),
            loadMs: ms(fetchStart, responseEnd).map { Int64($0.rounded()) })
    }

    /// A response the server meant to give. 4xx and 5xx are answers too, but
    /// they are answers to a question the caller got wrong or the server could
    /// not serve, so the row is marked not-ok and the timings stay — a 500 that
    /// took four seconds is a real four seconds.
    static func ok(_ code: Int) -> Bool { (100..<400).contains(code) }
}

/// Collects the metrics URLSession hands back for one task, and refuses that
/// task's redirects.
///
/// A per-task delegate rather than a session-wide one: `didFinishCollecting`
/// fires before the request returns, so the phases are ready by the time
/// `data(from:delegate:)` resumes and there is nothing to key or unkey by task.
/// Both callbacks live on this one object rather than being split with a
/// session delegate, so there is no question of which delegate the task
/// consults for which method.
private final class VantageProbe: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var collected: RequestPhases?

    /// Turns every redirect into a response of its own.
    ///
    /// URLSession follows redirects by default, which folds several requests
    /// into one task: `responseStartDate` would then be the first byte of the
    /// last hop and the earlier hops' phases would be lost. Answering nil stops
    /// at the 3xx, so a redirect is a row with its own honest timings.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didFinishCollecting metrics: URLSessionTaskMetrics) {
        // The last transaction is the one that produced the response. With
        // redirects turned off there is normally exactly one; a retried request
        // can produce more, and the one that answered is the honest sample.
        guard let t = metrics.transactionMetrics.last else { return }
        let phases = VantageTiming.phases(
            fetchStart: t.fetchStartDate,
            domainLookupStart: t.domainLookupStartDate, domainLookupEnd: t.domainLookupEndDate,
            connectStart: t.connectStartDate,
            secureConnectionStart: t.secureConnectionStartDate,
            secureConnectionEnd: t.secureConnectionEndDate,
            connectEnd: t.connectEndDate,
            responseStart: t.responseStartDate, responseEnd: t.responseEndDate)
        lock.lock(); collected = phases; lock.unlock()
    }

    var phases: RequestPhases {
        lock.lock(); defer { lock.unlock() }
        return collected ?? RequestPhases()
    }
}

/// vantage: fetch a list of URLs and record connection timings from wherever
/// this device happens to be.
///
/// A phone on cellular, a laptop on café wifi and a desktop on home fibre give
/// three different answers to the same question, and that spread *is* the
/// measurement — which is why `network_type` rides on every row. A latency
/// figure with no idea what carried it is not comparable to anything.
///
/// One result row per URL per repetition. A URL that answers 500 is a row with
/// `ok: false`; so is one whose connection was refused. Neither fails the job —
/// the job failed only if it could not run at all (no URLs to fetch), because a
/// site being down is exactly what this workload exists to notice, not an error
/// in the runner.
extension Workloads {

    static let vantageDefaultTimeoutS = 30

    static func runVantage(job: JobSpec, client: CollectorClient, deviceId: String) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false,
                                                    device: Telemetry.descriptor(), error: m))
        }
        let urls = job.params?.urls ?? []
        guard !urls.isEmpty else {
            await fail("vantage needs params.urls (a non-empty list)"); return
        }
        let repeats = max(job.params?.repeats ?? 1, 1)
        let timeout = Double(job.params?.timeoutS ?? vantageDefaultTimeoutS)
        let batteryStart = Telemetry.batteryPct()

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        // Ephemeral so no shared cache can serve a stored response as a
        // suspiciously fast one. Redirects are refused per task, by the probe.
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }

        var iter = 0
        var rows: [[String: Any]] = []
        var dns: [Double] = [], connect: [Double] = [], tls: [Double] = []
        var ttfb: [Double] = [], load: [Double] = []
        var networks: [String] = []
        var okRows = 0

        // Repetition-major: each repeat is one sweep of the whole list, so the
        // repeats of a single URL are spread across the run rather than
        // hammering one host back to back.
        for repeatIndex in 1...repeats {
            for url in urls {
                // Iteration boundary: a beacon may have found the lease gone.
                // The rows already posted stay valid; this one never happens.
                if CancellationRegistry.shared.isCancelled(job.jobId) {
                    try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId,
                                                            deviceId: deviceId, iter: 0, final: true, ok: false,
                                                            device: Telemetry.descriptor(), error: "cancelled"))
                    return
                }
                iter += 1
                // Read per request, not once per job: a device can leave wifi
                // mid-run, and the rows on either side are honestly different
                // measurements.
                let network = Telemetry.networkType()
                var status: Int?
                var failure: String?
                var bytes = 0
                var phases = RequestPhases()

                if let target = URL(string: url) {
                    let probe = VantageProbe()
                    do {
                        let (data, response) = try await session.data(from: target, delegate: probe)
                        status = (response as? HTTPURLResponse)?.statusCode
                        bytes = data.count
                    } catch {
                        // A refused connection, a DNS failure or a timeout is
                        // this device's answer about this URL, which is data.
                        // Whatever phases were reached before it gave up are
                        // still reported.
                        failure = error.localizedDescription
                    }
                    phases = probe.phases
                } else {
                    failure = "not a URL"
                }

                let rowOk = status.map(VantageTiming.ok) ?? false
                if rowOk {
                    okRows += 1
                    if let v = phases.dnsMs { dns.append(v) }
                    if let v = phases.connectMs { connect.append(v) }
                    if let v = phases.tlsMs { tls.append(v) }
                    if let v = phases.ttfbMs { ttfb.append(v) }
                    if let v = phases.loadMs { load.append(Double(v)) }
                }
                networks.append(network)

                var m = Metrics()
                m.dnsMs = phases.dnsMs
                m.connectMs = phases.connectMs
                m.tlsMs = phases.tlsMs
                m.ttfbMs = phases.ttfbMs
                m.loadMs = phases.loadMs
                m.networkType = network
                let rowError = failure ?? status.flatMap { VantageTiming.ok($0) ? nil : "HTTP \($0)" }
                try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                        iter: iter, ok: rowOk, metrics: m, error: rowError))

                // The rows carry no URL — the result schema has no field for
                // one — so the artifact is what says which iter was which URL.
                // Without it the run is a column of anonymous latencies.
                var row: [String: Any] = [
                    "iter": iter, "repeat": repeatIndex, "url": url,
                    "ok": rowOk, "network_type": network, "bytes": bytes,
                ]
                if let status { row["status"] = status }
                if let failure { row["error"] = failure }
                if let v = phases.dnsMs { row["dns_ms"] = v }
                if let v = phases.connectMs { row["connect_ms"] = v }
                if let v = phases.tlsMs { row["tls_ms"] = v }
                if let v = phases.ttfbMs { row["ttfb_ms"] = v }
                if let v = phases.loadMs { row["load_ms"] = v }
                rows.append(row)
            }
        }

        let report: [String: Any] = [
            "job_id": job.jobId, "device_id": deviceId,
            "urls": urls.count, "repeats": repeats,
            "rows": iter, "rows_ok": okRows,
            "network_types": Array(Set(networks)).sorted(),
            "requests": rows,
        ]
        var artifacts: [String] = []
        if let data = try? JSONSerialization.data(withJSONObject: report),
           let sha = try? await client.uploadArtifact(data, name: "\(job.jobId)-vantage.json") {
            artifacts.append(sha)
        }

        var summary = Metrics()
        // Medians over the ok rows only, so one refused connection cannot pull
        // the summary toward a timeout that was never a latency. Same field
        // names as the per-request rows because it is the same quantity
        // aggregated — the per-URL rows are the data, and the collector's views
        // build series from the !final rows, so the two never land in one
        // series.
        summary.dnsMs = Percentile.of(dns, 50)
        summary.connectMs = Percentile.of(connect, 50)
        summary.tlsMs = Percentile.of(tls, 50)
        summary.ttfbMs = Percentile.of(ttfb, 50)
        summary.loadMs = Percentile.of(load, 50).map { Int64($0.rounded()) }
        // One word when the device stayed on one transport for the whole run,
        // which is the normal case. A run that changed transport says so rather
        // than picking one.
        let seen = Array(Set(networks)).sorted()
        summary.networkType = seen.isEmpty ? "unknown" : seen.joined(separator: "+")
        summary.peakMemMb = Telemetry.physFootprintMb()
        summary.memMethod = "phys_footprint"
        summary.thermal = [Telemetry.thermal()]
        summary.batteryStartPct = batteryStart
        summary.batteryEndPct = Telemetry.batteryPct()

        try? await client.postResult(
            ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                       // The job ran. Whether the internet answered is the
                       // finding, not the verdict.
                       iter: 0, final: true, ok: true,
                       device: Telemetry.descriptor(), metrics: summary,
                       artifacts: artifacts.isEmpty ? nil : artifacts))
    }
}
