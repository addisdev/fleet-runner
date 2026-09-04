import Foundation

/// thermal: what the benchmark measures after the device stops being cold.
///
/// `benchmark` runs a handful of iterations on a device straight out of a
/// drawer and reports one number. That number is the best case and nobody
/// ships against the best case — the plant-ID eval's 7 ms per image was
/// measured cold, and whether it survives five minutes in a warm pocket is
/// what decides whether the feature needs a "device is warming up" banner.
///
/// So this runs the *same* measured iteration back to back for a fixed
/// duration and posts one row per iteration: throughput against elapsed time
/// against the OS thermal state. The output is a curve, not a number. The
/// collector's /api/results/thermal reads those rows and derives the first and
/// last tok/s, the drop between them, and the elapsed second at which the OS
/// first admitted the device was warming up.
extension Workloads {

    /// What the closing row can say, gathered as the loop runs.
    private struct ThermalCurve: Sendable {
        var loadMs: Int64
        /// The states the run passed through, in order and without repeats.
        /// Fifteen minutes is hundreds of iterations and each one's row
        /// already carries its own `thermal_state`, so what the closing row
        /// usefully adds is the shape — nominal → fair → serious — rather than
        /// several hundred copies of the word "fair".
        var states: [String] = []
        var lastDecodeTokS: Double?
        /// Elapsed seconds at the first sample whose state differed from the
        /// one the run started in — where the OS admitted the device was
        /// warming up. Stays nil when it never changed, so "no turn" reads as
        /// absent rather than as a turn at second zero or at the end.
        var thermalTurnedAtS: Double?
        var iterations = 0

        mutating func record(thermal: String, decodeTokS: Double, at elapsed: Double) {
            if states.last != thermal {
                if !states.isEmpty && thermalTurnedAtS == nil { thermalTurnedAtS = elapsed }
                states.append(thermal)
            }
            lastDecodeTokS = decodeTokS
            iterations += 1
        }
    }

    static func runThermal(job: JobSpec, client: CollectorClient, deviceId: String,
                           artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false,
                                                    device: Telemetry.descriptor(), error: m))
        }
        let promptTokens = job.params?.promptTokens ?? 512
        let genTokens = job.params?.genTokens ?? 128
        let warmups = job.params?.warmupIters ?? 1
        // Fifteen minutes: long enough for a phone in a pocket to reach the
        // state it will actually live in, short enough to schedule nightly.
        let duration = Double(job.params?.durationS ?? 900)
        let batteryStart = Telemetry.batteryPct()

        // Only llama.cpp needs an artifact, and fetching it before the loop
        // keeps the download out of the curve's clock.
        var downloaded: URL?
        if job.backend == "llama.cpp" {
            guard let modelRef = job.model, modelRef.format == "gguf" else {
                await fail("llama.cpp job needs a gguf model ref"); return
            }
            do { downloaded = try await artifacts.ensure(sha256: modelRef.sha256) }
            catch { await fail("artifact download failed: \(error.localizedDescription)"); return }
        }
        let modelFile = downloaded

        // Detached, like every other workload here: the measured loop must not
        // block the main actor, and above all it must not block the agent's
        // 60-second beacon. That beacon carries this job's id and is what
        // renews the lease, so a 15-minute run survives only because the work
        // is over here and the beacon is over there. It is also the only thing
        // that can cancel us, via the registry checked below.
        let outcome: Result<ThermalCurve, Error> = await Task.detached {
            do {
                let session = try BenchBackend.open(
                    backend: job.backend, promptTokens: promptTokens, genTokens: genTokens,
                    warmups: warmups, nThreads: job.params?.nThreads, modelFile: modelFile)
                defer { session.unload() }

                var curve = ThermalCurve(loadMs: session.loadMs)
                let start = DispatchTime.now()
                // The clock is read between iterations, never inside one: a
                // half-measured iteration is not a point on the curve, and an
                // iteration cut short would report a throughput the device
                // never achieved. So the run overshoots `duration` by at most
                // one iteration, which is the honest way to be wrong about it.
                while elapsedS(since: start) < duration {
                    // Iteration boundary: a beacon may have found the lease gone.
                    if CancellationRegistry.shared.isCancelled(job.jobId) { throw JobCancelled() }
                    guard let r = session.measure() else {
                        throw BenchUnavailable(message: "backend failed mid-run")
                    }
                    let now = elapsedS(since: start)
                    let thermal = Telemetry.thermal()
                    curve.record(thermal: thermal, decodeTokS: r.decodeTokS, at: now)

                    var m = Metrics()
                    m.elapsedS = now
                    m.prefillTokS = r.prefillTokS
                    m.decodeTokS = r.decodeTokS
                    m.ttftMs = r.ttftMs
                    m.thermalState = thermal
                    // The battery at this sample. `battery_pct` is a beacon
                    // field, not a metric name, so the reading rides in
                    // battery_end_pct — which is what the collector's thermal
                    // view reads it out of.
                    m.batteryEndPct = Telemetry.batteryPct()
                    m.peakMemMb = Telemetry.physFootprintMb()
                    m.memMethod = "phys_footprint"
                    try? await client.postResult(
                        ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                   iter: curve.iterations, metrics: m))
                }
                return .success(curve)
            } catch {
                return .failure(error)
            }
        }.value

        switch outcome {
        case .failure(let error):
            await fail(error.localizedDescription)
        case .success(let curve):
            var summary = Metrics()
            summary.loadMs = curve.loadMs
            // The sustained number: the last iteration, after the device has
            // become whatever it becomes. That is the figure a feature ships
            // against.
            //
            // The cold one is NOT here beside it. metrics.json declares
            // exactly one decode_tok_s, and a first/last pair would need two
            // names or one name carrying two meanings — which is precisely the
            // drift that once put vision accuracy in decode_tok_s and left
            // those numbers unqueryable. The cold figure is iteration 1's own
            // row, where it is already a legal, queryable point on the curve.
            summary.decodeTokS = curve.lastDecodeTokS
            // Elapsed at the thermal turn, closing the job with the one number
            // the curve cannot be read without. On a final row this is the
            // moment of the turn rather than a sample's own timestamp; the
            // collector's thermal view builds the curve from `!final` rows, so
            // the two readings never meet in the same series. Absent when the
            // device held its state for the whole run.
            summary.elapsedS = curve.thermalTurnedAtS
            summary.thermalState = curve.states.last
            summary.thermal = curve.states
            summary.peakMemMb = Telemetry.physFootprintMb()
            summary.memMethod = "phys_footprint"
            summary.batteryStartPct = batteryStart
            summary.batteryEndPct = Telemetry.batteryPct()
            try? await client.postResult(
                ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                           iter: 0, final: true, ok: true,
                           device: Telemetry.descriptor(), metrics: summary))
        }
    }

    /// Wall seconds since `start`. Uptime rather than a wall clock so an NTP
    /// step cannot bend the curve's axis; the app holds the idle timer off for
    /// the whole run, so the device does not sleep out from under it.
    private static func elapsedS(since start: DispatchTime) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
    }
}
