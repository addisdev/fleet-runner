import Foundation
import UIKit

/// Batch / vision-eval / pipeline engines mirroring the Android runner. Each
/// takes a job, does the work off the main actor, and posts per-item rows +
/// a final row (with artifacts where the workload produces them).
enum Workloads {

    // MARK: vision-eval (batch job, backend coreml)

    static func runVisionEval(job: JobSpec, client: CollectorClient, deviceId: String,
                              artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false,
                                                    device: Telemetry.descriptor(), error: m))
        }
        guard let modelRef = job.model, let setSha = job.params?.inputSha256 else {
            await fail("vision eval needs model + params.input_sha256"); return
        }
        let batteryStart = Telemetry.batteryPct()
        do {
            let modelZip = try await artifacts.ensure(sha256: modelRef.sha256)
            let modelDir = try unzip(modelZip, into: "model-\(modelRef.sha256)")
            let bundle = try firstEntry(in: modelDir, withExtension: ["mlmodelc", "mlpackage"])
            let setZip = try await artifacts.ensure(sha256: setSha)
            let setDir = try unzip(setZip, into: "evalset-\(setSha)")
            let manifest = try JSONSerialization.jsonObject(
                with: Data(contentsOf: setDir.appendingPathComponent("manifest.json"))) as! [String: Any]
            let limit = job.params?.maxItems ?? Int.max
            let items = Array(((manifest["items"] as? [[String: Any]]) ?? []).prefix(limit))
            let warmups = job.params?.warmupIters ?? 3
            let units = job.params?.computeUnits ?? "all"

            let outcome: Result<[String: Any], Error> = await Task.detached {
                do {
                    let backend = CoreMLBackend()
                    defer { backend.unload() }
                    let loadMs = try backend.load(modelDir: bundle, computeUnits: units)
                    guard let first = items.first,
                          let img0 = UIImage(contentsOfFile: setDir.appendingPathComponent(first["file"] as! String).path)
                    else { throw CollectorError.http(0, "empty eval set") }
                    for _ in 0..<warmups { _ = try backend.classify(img0, k: 1) }

                    var top1 = 0, top5 = 0
                    var latencies: [Double] = []
                    var thermals: [String] = []
                    var perImage: [[String: Any]] = []
                    for (i, item) in items.enumerated() {
                        let file = item["file"] as! String
                        let label = item["label"] as! Int
                        guard let img = UIImage(contentsOfFile: setDir.appendingPathComponent(file).path) else { continue }
                        let (top, ms) = try backend.classify(img, k: 5)
                        latencies.append(ms)
                        let hit1 = top.first == label
                        let hit5 = top.contains(label)
                        if hit1 { top1 += 1 }
                        if hit5 { top5 += 1 }
                        if i % 20 == 0 { thermals.append(Telemetry.thermal()) }
                        var row: [String: Any] = ["file": file, "label": label, "top1": top.first ?? -1,
                                                  "hit1": hit1, "hit5": hit5, "ms": ms]
                        if i == 0 { row["debug"] = backend.lastDebug }
                        perImage.append(row)
                        if (i + 1) % 20 == 0 {
                            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId,
                                                                    deviceId: deviceId, iter: i + 1, ok: true))
                        }
                    }
                    let n = max(items.count, 1)
                    let sorted = latencies.sorted()
                    return .success([
                        "job_id": job.jobId, "device_id": deviceId, "model": modelRef.name,
                        "accelerator": "coreml:\(backend.computeUnitsUsed)", "input_size": backend.inputSize,
                        "items": items.count,
                        "top1_acc": Double(top1) / Double(n), "top5_acc": Double(top5) / Double(n),
                        "latency_p50_ms": sorted[sorted.count / 2], "latency_p95_ms": sorted[(sorted.count * 95) / 100],
                        "latency_mean_ms": latencies.reduce(0, +) / Double(n),
                        "load_ms": loadMs, "thermal": thermals, "per_image": perImage,
                    ])
                } catch { return .failure(error) }
            }.value

            switch outcome {
            case .failure(let e): await fail(e.localizedDescription)
            case .success(let report):
                let data = try JSONSerialization.data(withJSONObject: report)
                let sha = try await client.uploadArtifact(data, name: "\(job.jobId)-eval.json")
                var m = Metrics()
                m.loadMs = report["load_ms"] as? Int64
                let p50 = report["latency_p50_ms"] as? Double ?? 1
                m.prefillTokS = 1000.0 / max(p50, 1)                       // images/sec
                m.decodeTokS = (report["top1_acc"] as? Double ?? 0) * 100 // top-1 %
                m.ttftMs = p50
                m.peakMemMb = Telemetry.physFootprintMb(); m.memMethod = "phys_footprint"
                m.thermal = report["thermal"] as? [String]
                m.batteryStartPct = batteryStart; m.batteryEndPct = Telemetry.batteryPct()
                try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                        iter: 0, final: true, ok: true,
                                                        device: Telemetry.descriptor(), metrics: m, artifacts: [sha]))
            }
        } catch { await fail(error.localizedDescription) }
    }

    // MARK: batch (llama.cpp generation)

    static func runBatch(job: JobSpec, client: CollectorClient, deviceId: String,
                         artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false, error: m))
        }
        #if canImport(llama)
        guard let modelRef = job.model, let inputSha = job.params?.inputSha256 else {
            await fail("batch needs model + params.input_sha256"); return
        }
        do {
            let modelFile = try await artifacts.ensure(sha256: modelRef.sha256)
            let inputFile = try await artifacts.ensure(sha256: inputSha)
            let input = try JSONSerialization.jsonObject(with: Data(contentsOf: inputFile)) as? [String: Any]
            let items = (input?["items"] as? [String]) ?? []
            let maxTokens = job.params?.maxTokens ?? 64
            let outputs: [[String: Any]] = try await Task.detached {
                let backend = LlamaCppBackend()
                defer { backend.unload() }
                guard backend.load(path: modelFile.path, nCtx: 2048,
                                   nThreads: Int32(min(ProcessInfo.processInfo.activeProcessorCount, 6))) != nil
                else { throw CollectorError.http(0, "llama.cpp failed to load") }
                var out: [[String: Any]] = []
                for (i, prompt) in items.enumerated() {
                    let t0 = DispatchTime.now()
                    let text = try backend.generate(prompt: prompt, maxTokens: Int32(maxTokens))
                    let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
                    out.append(["item": i, "output": text, "ms": ms])
                    try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId, iter: i + 1, ok: true))
                }
                return out
            }.value
            let report: [String: Any] = ["job_id": job.jobId, "device_id": deviceId, "backend": "llama.cpp", "outputs": outputs]
            let sha = try await client.uploadArtifact(try JSONSerialization.data(withJSONObject: report), name: "\(job.jobId)-outputs.json")
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: true,
                                                    device: Telemetry.descriptor(), artifacts: [sha]))
        } catch { await fail(error.localizedDescription) }
        #else
        await fail("llama.cpp not built into this binary")
        #endif
    }

    // MARK: pipeline (subscribe topic → generate → publish <topic>.out)

    static func runPipeline(job: JobSpec, client: CollectorClient, deviceId: String,
                            artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: false, error: m))
        }
        #if canImport(llama)
        guard let modelRef = job.model, let topic = job.params?.topic else {
            await fail("pipeline needs model + params.topic"); return
        }
        do {
            let modelFile = try await artifacts.ensure(sha256: modelRef.sha256)
            let maxEvents = job.params?.maxEvents ?? 1
            let maxTokens = job.params?.maxTokens ?? 64
            var cursor = job.params?.after ?? 0
            let backend = LlamaCppBackend()
            defer { backend.unload() }
            guard backend.load(path: modelFile.path, nCtx: 2048,
                               nThreads: Int32(min(ProcessInfo.processInfo.activeProcessorCount, 6))) != nil
            else { await fail("llama.cpp failed to load"); return }
            var processed = 0
            while processed < maxEvents {
                guard let event = try await client.pollEvent(topic: topic, after: cursor) else { continue }
                cursor = event.id
                let prompt = (event.payload["prompt"] as? String) ?? String(describing: event.payload)
                let t0 = DispatchTime.now()
                let text = try backend.generate(prompt: prompt, maxTokens: Int32(maxTokens))
                let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
                try await client.publishEvent(topic: "\(topic).out",
                                              payload: ["input_id": event.id, "device_id": deviceId, "output": text, "ms": ms])
                processed += 1
                try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId, iter: processed, ok: true))
            }
            try? await client.postResult(ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                                                    iter: 0, final: true, ok: true, device: Telemetry.descriptor()))
        } catch { await fail(error.localizedDescription) }
        #else
        await fail("llama.cpp not built into this binary")
        #endif
    }

    // MARK: helpers

    private static func unzip(_ zip: URL, into name: String) throws -> URL {
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(name, isDirectory: true)
        if FileManager.default.fileExists(atPath: dest.path) { return dest }
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        // Foundation has no public unzip on iOS; the fleet's artifacts are plain
        // deflate zips, which NSFileCoordinator-free unarchiving via `unzip`
        // isn't available either — so use the tiny stored/deflate reader below.
        try MiniZip.extract(zip, to: dest)
        return dest
    }

    private static func firstEntry(in dir: URL, withExtension exts: [String]) throws -> URL {
        let all = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        if let hit = all.first(where: { exts.contains($0.pathExtension) }) { return hit }
        for sub in all where (try? sub.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            if let hit = try? firstEntry(in: sub, withExtension: exts) { return hit }
        }
        throw CollectorError.http(0, "no \(exts.joined(separator: "/")) in artifact")
    }
}
