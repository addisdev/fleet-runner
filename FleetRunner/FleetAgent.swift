import Foundation
import UIKit

/// Jobs the collector has told us to stop running, learned from a beacon that
/// came back with `lease_renewed: false`. The beacon runs detached and the
/// workloads read this from their own tasks, so it locks like CurrentJobBox.
final class CancellationRegistry: @unchecked Sendable {
    static let shared = CancellationRegistry()
    private let lock = NSLock()
    private var ids: Set<String> = []
    func cancel(_ jobId: String) { lock.lock(); ids.insert(jobId); lock.unlock() }
    func isCancelled(_ jobId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }; return ids.contains(jobId)
    }
    func clear() { lock.lock(); ids.removeAll(); lock.unlock() }
}

/// Thrown by a workload at an iteration boundary when its job was cancelled.
/// The message is what lands in the final row's `error`, and every workload
/// already reports failures as `fail(error.localizedDescription)`.
struct JobCancelled: Error, LocalizedError {
    var errorDescription: String? { "cancelled" }
}

/// Agent loop + telemetry beacon, mirroring the Android RunnerService.
@MainActor
final class FleetAgent: ObservableObject {
    @Published var status = "stopped"

    private var agentTask: Task<Void, Never>?
    private var beaconTask: Task<Void, Never>?
    private var baseURL: URL?

    // Beacons carrying a job_id renew that job's lease on the collector, so
    // long benchmarks aren't swept mid-run.
    private let currentJobId = CurrentJobBox()

    final class CurrentJobBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        func set(_ id: String?) { lock.lock(); value = id; lock.unlock() }
        func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
    }

    func start(baseURL: URL, deviceId: String) {
        stop()
        self.baseURL = baseURL
        status = "starting"
        UIApplication.shared.isIdleTimerDisabled = true
        let client = CollectorClient(baseURL: baseURL)

        agentTask = Task { await self.agentLoop(client: client, deviceId: deviceId) }
        let jobBox = currentJobId
        beaconTask = Task.detached {
            while !Task.isCancelled {
                let beacon = await Telemetry.beacon()
                let jobId = jobBox.get()
                // `try?` still swallows every failure: a throw, a timeout or a
                // non-2xx leaves `renewed` nil, and only an explicit false in a
                // 2xx body — the collector saying the claim is gone — cancels.
                let renewed = try? await client.postBeacon(
                    ResultPost(kind: "beacon", jobId: jobId, deviceId: deviceId, beacon: beacon))
                if renewed == false, let jobId {
                    CancellationRegistry.shared.cancel(jobId)
                }
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stop() {
        agentTask?.cancel()
        beaconTask?.cancel()
        agentTask = nil
        beaconTask = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = "stopped"
    }

    /// Exactly the workloads the dispatch switch in `agentLoop` handles, sent
    /// at registration as this device's capabilities. One list for both, so
    /// that the switch and what the collector's routing believes we can run
    /// cannot drift apart and earn us work we'd only bounce back as
    /// "not supported".
    static let dispatchedWorkloads = ["benchmark", "batch", "batch:coreml", "pipeline", "thermal"]

    private func agentLoop(client: CollectorClient, deviceId: String) async {
        while !Task.isCancelled {
            do {
                status = "registering as \(deviceId)"
                try await client.register(
                    RegisterPost(
                        deviceId: deviceId,
                        descriptor: Telemetry.descriptor(),
                        pools: ["ml-capable"],
                        capabilities: Self.dispatchedWorkloads))
                while !Task.isCancelled {
                    status = "polling for work"
                    guard let job = try await client.nextJob(deviceId: deviceId) else { continue }

                    // Same contract as Android: refuse jobs whose numbers would lie.
                    if let c = job.constraints {
                        var problem: String?
                        if c.requireCharging == true && !Telemetry.isCharging() {
                            #if !targetEnvironment(simulator)
                            problem = "constraint not met: require_charging (device is on battery)"
                            #endif
                        }
                        if let min = c.minBatteryPct, Telemetry.batteryPct() < min {
                            problem = "constraint not met: min_battery_pct \(min) (at \(Telemetry.batteryPct())%)"
                        }
                        if let problem {
                            try await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                                   iter: 0, final: true, ok: false, error: problem))
                            status = "rejected \(job.jobId): \(problem)"
                            continue
                        }
                    }

                    status = "running \(job.jobId)"
                    currentJobId.set(job.jobId)
                    defer { currentJobId.set(nil); CancellationRegistry.shared.clear() }
                    let cache = ArtifactCache(collectorURL: baseURL!)
                    // Every case here is a string in `dispatchedWorkloads` above,
                    // which is what we registered as our capabilities.
                    switch (job.workload, job.backend) {
                    case ("benchmark", _):
                        await runBenchmark(job: job, client: client, deviceId: deviceId)
                    case ("batch", "coreml"):
                        await Workloads.runVisionEval(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    case ("batch", _):
                        await Workloads.runBatch(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    case ("pipeline", _):
                        await Workloads.runPipeline(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    case ("thermal", _):
                        await Workloads.runThermal(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    default:
                        try await client.postResult(
                            ResultPost(
                                kind: "result", jobId: job.jobId, deviceId: deviceId,
                                iter: 0, final: true, ok: false,
                                error: "workload '\(job.workload)' not supported by this runner yet"))
                    }
                    status = "finished \(job.jobId)"
                }
            } catch {
                status = "error: \(error.localizedDescription) — retrying in 10s"
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func runBenchmark(job: JobSpec, client: CollectorClient, deviceId: String) async {
        let pp = job.params?.promptTokens ?? 512
        let tg = job.params?.genTokens ?? 128
        let warmups = job.params?.warmupIters ?? 1
        let measures = job.params?.measureIters ?? 3
        let batteryStart = Telemetry.batteryPct()

        if job.backend == "llama.cpp" {
            await runLlamaBenchmark(job: job, client: client, deviceId: deviceId,
                                    pp: pp, tg: tg, warmups: warmups, measures: measures,
                                    batteryStart: batteryStart)
            return
        }
        guard job.backend == nil || job.backend == "synthetic" else {
            try? await client.postResult(
                ResultPost(
                    kind: "result", jobId: job.jobId, deviceId: deviceId,
                    iter: 0, final: true, ok: false,
                    device: Telemetry.descriptor(),
                    error: "backend '\(job.backend ?? "?")' not supported on iOS"))
            return
        }

        // Off the main actor: the hash loop must not block UI or beacons.
        let outcome: (iters: [IterResult], thermals: [String], loadMs: Int64, cancelled: Bool) = await Task.detached {
            // The same session the thermal curve is measured with, so a cold
            // number and a warm one come out of identical code and can be read
            // against each other.
            let session = SyntheticSession(promptTokens: pp, genTokens: tg, warmups: warmups)
            defer { session.unload() }
            var iters: [IterResult] = []
            var thermals: [String] = []
            var cancelled = false
            for i in 1...measures {
                if CancellationRegistry.shared.isCancelled(job.jobId) { cancelled = true; break }
                guard let r = session.measure() else { break }
                iters.append(r)
                thermals.append(Telemetry.thermal())
                var m = Metrics()
                m.prefillTokS = r.prefillTokS
                m.decodeTokS = r.decodeTokS
                m.ttftMs = r.ttftMs
                m.peakMemMb = Telemetry.physFootprintMb()
                m.memMethod = "phys_footprint"
                m.thermal = [thermals[thermals.count - 1]]
                try? await client.postResult(
                    ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId, iter: i, metrics: m))
            }
            return (iters, thermals, session.loadMs, cancelled)
        }.value

        if outcome.cancelled {
            try? await client.postResult(
                ResultPost(
                    kind: "result", jobId: job.jobId, deviceId: deviceId,
                    iter: 0, final: true, ok: false,
                    device: Telemetry.descriptor(), error: "cancelled"))
            return
        }

        var summary = Metrics()
        summary.loadMs = outcome.loadMs
        summary.prefillTokS = outcome.iters.map(\.prefillTokS).reduce(0, +) / Double(outcome.iters.count)
        summary.decodeTokS = outcome.iters.map(\.decodeTokS).reduce(0, +) / Double(outcome.iters.count)
        summary.ttftMs = outcome.iters.map(\.ttftMs).reduce(0, +) / Double(outcome.iters.count)
        summary.peakMemMb = Telemetry.physFootprintMb()
        summary.memMethod = "phys_footprint"
        summary.thermal = outcome.thermals
        summary.batteryStartPct = batteryStart
        summary.batteryEndPct = Telemetry.batteryPct()

        try? await client.postResult(
            ResultPost(
                kind: "result", jobId: job.jobId, deviceId: deviceId,
                iter: 0, final: true, ok: true,
                device: Telemetry.descriptor(), metrics: summary))
    }

    private func runLlamaBenchmark(
        job: JobSpec, client: CollectorClient, deviceId: String,
        pp: Int, tg: Int, warmups: Int, measures: Int, batteryStart: Int
    ) async {
        func fail(_ message: String) async {
            try? await client.postResult(
                ResultPost(
                    kind: "result", jobId: job.jobId, deviceId: deviceId,
                    iter: 0, final: true, ok: false,
                    device: Telemetry.descriptor(), error: message))
        }
        #if canImport(llama)
        guard let modelRef = job.model, modelRef.format == "gguf" else {
            await fail("llama.cpp job needs a gguf model ref")
            return
        }
        guard let baseURL else {
            await fail("agent started without a collector URL")
            return
        }
        do {
            status = "downloading \(modelRef.name)"
            let file = try await ArtifactCache(collectorURL: baseURL).ensure(sha256: modelRef.sha256)
            status = "running \(job.jobId)"

            let nCtx = Int32(max(1024, pp + tg + 8))
            let nThreads = Int32(job.params?.nThreads ?? min(ProcessInfo.processInfo.activeProcessorCount, 6))

            let outcome: Result<(iters: [IterResult], thermals: [String], loadMs: Int64), Error> =
                await Task.detached {
                    do {
                        // The same session the thermal curve is measured with,
                        // so a cold number and a warm one come out of
                        // identical code and can be read against each other.
                        let session = try LlamaSession(
                            modelPath: file.path, promptTokens: pp, genTokens: tg,
                            warmups: warmups, nCtx: nCtx, nThreads: nThreads)
                        defer { session.unload() }
                        var iters: [IterResult] = []
                        var thermals: [String] = []
                        for i in 1...measures {
                            if CancellationRegistry.shared.isCancelled(job.jobId) { return .failure(JobCancelled()) }
                            guard let r = session.measure() else {
                                return .failure(BenchUnavailable(message: "llama.cpp decode failed"))
                            }
                            iters.append(r)
                            thermals.append(Telemetry.thermal())
                            var m = Metrics()
                            m.prefillTokS = r.prefillTokS
                            m.decodeTokS = r.decodeTokS
                            m.ttftMs = r.ttftMs
                            m.peakMemMb = Telemetry.physFootprintMb()
                            m.memMethod = "phys_footprint"
                            m.thermal = [thermals[thermals.count - 1]]
                            try? await client.postResult(
                                ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId, iter: i, metrics: m))
                        }
                        return .success((iters, thermals, session.loadMs))
                    } catch {
                        return .failure(error)
                    }
                }.value

            switch outcome {
            case .failure(let error):
                await fail(error.localizedDescription)
            case .success(let out):
                var summary = Metrics()
                summary.loadMs = out.loadMs
                summary.prefillTokS = out.iters.map(\.prefillTokS).reduce(0, +) / Double(out.iters.count)
                summary.decodeTokS = out.iters.map(\.decodeTokS).reduce(0, +) / Double(out.iters.count)
                summary.ttftMs = out.iters.map(\.ttftMs).reduce(0, +) / Double(out.iters.count)
                summary.peakMemMb = Telemetry.physFootprintMb()
                summary.memMethod = "phys_footprint"
                summary.thermal = out.thermals
                summary.batteryStartPct = batteryStart
                summary.batteryEndPct = Telemetry.batteryPct()
                try? await client.postResult(
                    ResultPost(
                        kind: "result", jobId: job.jobId, deviceId: deviceId,
                        iter: 0, final: true, ok: true,
                        device: Telemetry.descriptor(), metrics: summary))
            }
        } catch {
            await fail("artifact download failed: \(error.localizedDescription)")
        }
        #else
        await fail("llama.cpp not built into this binary (llama.xcframework missing at build time)")
        #endif
    }
}
