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
    /// What the agent is doing, as a value rather than as prose.
    ///
    /// `status` is still the sentence — it carries job ids and error text, and
    /// the host executor's smoke flows read it. This is the same information in
    /// the form a screen needs: something to colour a dot by and to choose a
    /// headline from, without any view parsing English out of a string.
    enum Phase {
        case stopped, starting, registering, polling, running, failing

        var headline: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting"
            case .registering: return "Registering"
            case .polling: return "Polling for work"
            case .running: return "Running a job"
            case .failing: return "Cannot reach the collector"
            }
        }

        /// True while the agent is in contact with the collector — what the
        /// header's live dot and the hero's pulse animation key off.
        var connected: Bool {
            switch self {
            case .polling, .running: return true
            default: return false
            }
        }
    }

    /// A job this device has finished, as much as the agent itself knows.
    ///
    /// Deliberately not carrying an ok/failed verdict: the workloads post their
    /// own final rows and the agent never sees the outcome, so a badge here
    /// would be a guess. The collector is where a job's verdict lives.
    struct FinishedJob {
        let jobId: String
        let workload: String
        let elapsed: TimeInterval
        let at: Date
    }

    @Published var status = "stopped"
    @Published private(set) var phase: Phase = .stopped
    /// The most recent beacon, so a running agent's screen shows the same
    /// numbers the collector was sent rather than readings taken a second
    /// later. Before the first beacon this is a local sample — see `sampleNow`.
    @Published private(set) var telemetry: BeaconSample?
    @Published private(set) var network = "unknown"
    @Published private(set) var lastBeacon: Date?
    @Published private(set) var runningJob: (id: String, workload: String, since: Date)?
    @Published private(set) var lastJob: FinishedJob?

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
        phase = .starting
        UIApplication.shared.isIdleTimerDisabled = true
        let client = CollectorClient(baseURL: baseURL)

        agentTask = Task { await self.agentLoop(client: client, deviceId: deviceId) }
        let jobBox = currentJobId
        beaconTask = Task.detached { [weak self] in
            while !Task.isCancelled {
                let beacon = await Telemetry.beacon()
                let net = Telemetry.networkType()
                // The screen shows the sample that was actually sent, stamped
                // with when it went — a tile that re-read the battery on every
                // redraw would drift away from what the collector believes.
                await MainActor.run {
                    self?.telemetry = beacon
                    self?.network = net
                    self?.lastBeacon = Date()
                }
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

    /// Take a reading without sending one.
    ///
    /// The battery and thermal tiles are worth something before the agent is
    /// started — deciding whether to enrol a phone that is on 8% is exactly a
    /// pre-start question — and until Start is pressed there is no beacon to
    /// show. This fills them in locally; the beacon loop overwrites it a minute
    /// later with what was actually reported.
    func sampleNow() {
        guard phase == .stopped else { return }
        telemetry = Telemetry.beacon()
        network = Telemetry.networkType()
    }

    func stop() {
        agentTask?.cancel()
        beaconTask?.cancel()
        agentTask = nil
        beaconTask = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = "stopped"
        phase = .stopped
        runningJob = nil
    }

    /// One workload this runner can run: what it declares to the collector, and
    /// what it does when a job of that kind arrives.
    ///
    /// `capability` is the string the queue routes on. Usually that is the
    /// workload name; where a runner serves only one backend of a workload it
    /// is the backend-qualified form the collector understands ("batch:coreml").
    private struct Route {
        let capability: String
        let workload: String
        /// nil matches any backend; a value claims only that backend.
        var backend: String?
        let run: (FleetAgent, JobSpec, CollectorClient, String, ArtifactCache) async -> Void
    }

    /// Every workload this runner dispatches, with what it declares for each.
    ///
    /// This list is the single source for both halves: the capabilities sent at
    /// registration are its `capability` column, and the dispatch in `agentLoop`
    /// is its `run` column, so declaring a workload and being able to run it are
    /// one act. They used to be a hand-kept array beside a `switch`, which is a
    /// pair of things that agree only until someone edits one of them — and the
    /// failure is silent in the worst direction: the collector routes us work we
    /// bounce straight back as "not supported by this runner yet".
    private static let routes: [Route] = [
        Route(capability: "benchmark", workload: "benchmark") { agent, job, client, deviceId, _ in
            await agent.runBenchmark(job: job, client: client, deviceId: deviceId)
        },
        Route(capability: "batch", workload: "batch") { _, job, client, deviceId, cache in
            await Workloads.runBatch(job: job, client: client, deviceId: deviceId, artifacts: cache)
        },
        Route(capability: "batch:coreml", workload: "batch", backend: "coreml") { _, job, client, deviceId, cache in
            await Workloads.runVisionEval(job: job, client: client, deviceId: deviceId, artifacts: cache)
        },
        Route(capability: "pipeline", workload: "pipeline") { _, job, client, deviceId, cache in
            await Workloads.runPipeline(job: job, client: client, deviceId: deviceId, artifacts: cache)
        },
        Route(capability: "thermal", workload: "thermal") { _, job, client, deviceId, cache in
            await Workloads.runThermal(job: job, client: client, deviceId: deviceId, artifacts: cache)
        },
        Route(capability: "embed-eval", workload: "embed-eval") { _, job, client, deviceId, cache in
            await Workloads.runEmbedEval(job: job, client: client, deviceId: deviceId, artifacts: cache)
        },
        Route(capability: "vantage", workload: "vantage") { _, job, client, deviceId, _ in
            await Workloads.runVantage(job: job, client: client, deviceId: deviceId)
        },
    ]

    /// What this device declares at registration, so the collector's routing
    /// only offers it work it can run. Derived from `routes` rather than
    /// written out, which makes drift impossible rather than merely unlikely.
    static var dispatchedWorkloads: [String] { routes.map(\.capability) }

    /// The route for a job, or nil when this runner has none. A route naming a
    /// backend wins over the workload's general route — that is what sends
    /// `batch` + backend coreml to the vision eval — so declaration order stays
    /// free to be the order we want to register in.
    private static func route(for job: JobSpec) -> Route? {
        routes.first { $0.workload == job.workload && $0.backend != nil && $0.backend == job.backend }
            ?? routes.first { $0.workload == job.workload && $0.backend == nil }
    }

    private func agentLoop(client: CollectorClient, deviceId: String) async {
        while !Task.isCancelled {
            do {
                status = "registering as \(deviceId)"
                phase = .registering
                try await client.register(
                    RegisterPost(
                        deviceId: deviceId,
                        descriptor: Telemetry.descriptor(),
                        pools: ["ml-capable"],
                        capabilities: Self.dispatchedWorkloads))
                while !Task.isCancelled {
                    status = "polling for work"
                    phase = .polling
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
                    phase = .running
                    let startedAt = Date()
                    runningJob = (id: job.jobId, workload: job.workload, since: startedAt)
                    currentJobId.set(job.jobId)
                    defer { currentJobId.set(nil); CancellationRegistry.shared.clear() }
                    let cache = ArtifactCache(collectorURL: baseURL!)
                    if let route = Self.route(for: job) {
                        await route.run(self, job, client, deviceId, cache)
                    } else {
                        try await client.postResult(
                            ResultPost(
                                kind: "result", jobId: job.jobId, deviceId: deviceId,
                                iter: 0, final: true, ok: false,
                                error: "workload '\(job.workload)' not supported by this runner yet"))
                    }
                    status = "finished \(job.jobId)"
                    lastJob = FinishedJob(
                        jobId: job.jobId, workload: job.workload,
                        elapsed: Date().timeIntervalSince(startedAt), at: Date())
                    runningJob = nil
                }
            } catch {
                status = "error: \(error.localizedDescription) — retrying in 10s"
                phase = .failing
                runningJob = nil
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
