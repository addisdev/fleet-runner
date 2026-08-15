import Foundation
import UIKit

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
                try? await client.postResult(
                    ResultPost(kind: "beacon", jobId: jobBox.get(), deviceId: deviceId, beacon: beacon))
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

    private func agentLoop(client: CollectorClient, deviceId: String) async {
        while !Task.isCancelled {
            do {
                status = "registering as \(deviceId)"
                try await client.register(
                    RegisterPost(
                        deviceId: deviceId,
                        descriptor: Telemetry.descriptor(),
                        pools: ["ml-capable"]))
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
                    defer { currentJobId.set(nil) }
                    let cache = ArtifactCache(collectorURL: baseURL!)
                    switch (job.workload, job.backend) {
                    case ("benchmark", _):
                        await runBenchmark(job: job, client: client, deviceId: deviceId)
                    case ("batch", "coreml"):
                        await Workloads.runVisionEval(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    case ("batch", _):
                        await Workloads.runBatch(job: job, client: client, deviceId: deviceId, artifacts: cache)
                    case ("pipeline", _):
                        await Workloads.runPipeline(job: job, client: client, deviceId: deviceId, artifacts: cache)
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
        let outcome: (iters: [IterResult], thermals: [String], loadMs: Int64) = await Task.detached {
            let backend = SyntheticBackend()
            let loadMs = backend.load()
            for _ in 0..<warmups { _ = backend.runIteration(promptTokens: pp, genTokens: tg) }
            var iters: [IterResult] = []
            var thermals: [String] = []
            for i in 1...measures {
                let r = backend.runIteration(promptTokens: pp, genTokens: tg)
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
            backend.unload()
            return (iters, thermals, loadMs)
        }.value

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
                    let backend = LlamaCppBackend()
                    defer { backend.unload() }
                    guard let loadMs = backend.load(path: file.path, nCtx: nCtx, nThreads: nThreads) else {
                        return .failure(CollectorError.http(0, "llama.cpp failed to load model"))
                    }
                    for _ in 0..<warmups { _ = backend.bench(pp: Int32(pp), tg: Int32(tg)) }
                    var iters: [IterResult] = []
                    var thermals: [String] = []
                    for i in 1...measures {
                        guard let (prefillMs, decodeMs, ttftMs) = backend.bench(pp: Int32(pp), tg: Int32(tg)) else {
                            return .failure(CollectorError.http(0, "llama.cpp decode failed"))
                        }
                        let r = IterResult(
                            prefillTokS: Double(pp) * 1000.0 / max(prefillMs, 1),
                            decodeTokS: Double(tg) * 1000.0 / max(decodeMs, 1),
                            ttftMs: ttftMs)
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
                    return .success((iters, thermals, loadMs))
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
