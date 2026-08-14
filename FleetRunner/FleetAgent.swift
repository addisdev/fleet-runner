import Foundation
import UIKit

/// Agent loop + telemetry beacon, mirroring the Android RunnerService.
@MainActor
final class FleetAgent: ObservableObject {
    @Published var status = "stopped"

    private var agentTask: Task<Void, Never>?
    private var beaconTask: Task<Void, Never>?

    func start(baseURL: URL, deviceId: String) {
        stop()
        status = "starting"
        UIApplication.shared.isIdleTimerDisabled = true
        let client = CollectorClient(baseURL: baseURL)

        agentTask = Task { await self.agentLoop(client: client, deviceId: deviceId) }
        beaconTask = Task.detached {
            while !Task.isCancelled {
                let beacon = await Telemetry.beacon()
                try? await client.postResult(
                    ResultPost(kind: "beacon", deviceId: deviceId, beacon: beacon))
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
                    status = "running \(job.jobId)"
                    if job.workload == "benchmark" {
                        await runBenchmark(job: job, client: client, deviceId: deviceId)
                    } else {
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

        guard job.backend == nil || job.backend == "synthetic" else {
            try? await client.postResult(
                ResultPost(
                    kind: "result", jobId: job.jobId, deviceId: deviceId,
                    iter: 0, final: true, ok: false,
                    device: Telemetry.descriptor(),
                    error: "backend '\(job.backend ?? "?")' not built on iOS yet (Phase 3b)"))
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
}
