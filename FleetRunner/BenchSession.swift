import Foundation

/// A loaded, warmed-up inference backend that can be measured over and over.
///
/// `benchmark` and `thermal` measure the same thing: one iteration is pp
/// prefill tokens plus tg generated tokens, timed. They differ only in what
/// ends the loop — a count of iterations for one, a clock for the other — and
/// in what each row records. So the load, the warmup and the measured
/// iteration live here once, and both workloads drive them.
///
/// Two inference paths would be two sets of numbers, and comparable numbers
/// across a shelf of mixed hardware is the entire point of the fleet. The
/// thermal curve is only readable against the cold benchmark if the warm
/// samples were produced by exactly the same code.
protocol BenchSession: AnyObject {
    /// Backend load time in ms, for the job's final row.
    var loadMs: Int64 { get }
    /// One measured iteration; nil when the backend failed mid-run.
    func measure() -> IterResult?
    func unload()
}

/// A backend that cannot be opened here, carrying the message the workload
/// should report. Distinct from `CollectorError.http(0, …)`, which reads as
/// "… failed: HTTP 0" and describes a request that never happened.
struct BenchUnavailable: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The synthetic SHA-256 backend: no model, no download, always available.
final class SyntheticSession: BenchSession {
    private let backend = SyntheticBackend()
    private let promptTokens: Int
    private let genTokens: Int
    let loadMs: Int64

    init(promptTokens: Int, genTokens: Int, warmups: Int) {
        self.promptTokens = promptTokens
        self.genTokens = genTokens
        loadMs = backend.load()
        for _ in 0..<warmups { _ = backend.runIteration(promptTokens: promptTokens, genTokens: genTokens) }
    }

    func measure() -> IterResult? {
        backend.runIteration(promptTokens: promptTokens, genTokens: genTokens)
    }

    func unload() { backend.unload() }
}

#if canImport(llama)
/// llama.cpp over the same `bench(pp:tg:)` call the benchmark has always used.
/// The ms → tok/s conversion lives here so there is one of it.
final class LlamaSession: BenchSession {
    private let backend = LlamaCppBackend()
    private let pp: Int32
    private let tg: Int32
    private(set) var loadMs: Int64 = 0

    init(modelPath: String, promptTokens: Int, genTokens: Int, warmups: Int,
         nCtx: Int32, nThreads: Int32) throws {
        pp = Int32(promptTokens)
        tg = Int32(genTokens)
        guard let ms = backend.load(path: modelPath, nCtx: nCtx, nThreads: nThreads) else {
            throw BenchUnavailable(message: "llama.cpp failed to load model")
        }
        loadMs = ms
        for _ in 0..<warmups { _ = backend.bench(pp: pp, tg: tg) }
    }

    func measure() -> IterResult? {
        guard let (prefillMs, decodeMs, ttftMs) = backend.bench(pp: pp, tg: tg) else { return nil }
        return IterResult(
            prefillTokS: Double(pp) * 1000.0 / max(prefillMs, 1),
            decodeTokS: Double(tg) * 1000.0 / max(decodeMs, 1),
            ttftMs: ttftMs)
    }

    func unload() { backend.unload() }
}
#endif

enum BenchBackend {
    /// Opens and warms up the backend a job asks for.
    ///
    /// `modelFile` is the already-downloaded gguf; only llama.cpp needs one,
    /// and fetching it is the caller's job because it wants to say so in the
    /// UI status while it happens. Throws `BenchUnavailable` with the message
    /// to report when this build or this device cannot serve the request.
    static func open(backend: String?, promptTokens: Int, genTokens: Int, warmups: Int,
                     nThreads: Int?, modelFile: URL?) throws -> BenchSession {
        switch backend {
        case nil, "synthetic":
            return SyntheticSession(promptTokens: promptTokens, genTokens: genTokens, warmups: warmups)
        case "llama.cpp":
            #if canImport(llama)
            guard let modelFile else {
                throw BenchUnavailable(message: "llama.cpp job needs a gguf model ref")
            }
            return try LlamaSession(
                modelPath: modelFile.path,
                promptTokens: promptTokens, genTokens: genTokens, warmups: warmups,
                nCtx: Int32(max(1024, promptTokens + genTokens + 8)),
                nThreads: Int32(nThreads ?? min(ProcessInfo.processInfo.activeProcessorCount, 6)))
            #else
            throw BenchUnavailable(
                message: "llama.cpp not built into this binary (llama.xcframework missing at build time)")
            #endif
        default:
            throw BenchUnavailable(message: "backend '\(backend ?? "?")' not supported on iOS")
        }
    }
}
