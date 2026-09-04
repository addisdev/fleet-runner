import Foundation

// Swift mirror of collector/schemas ("schema": 1). Shared protocol, not
// shared code — the Android runner mirrors these independently in Kotlin.
// JSONEncoder/Decoder snake_case strategies map jobId <-> job_id etc.

struct ModelRef: Codable {
    let name: String
    let format: String
    let quant: String?
    let sha256: String
}

struct Targets: Codable {
    let pool: String?
    let match: String?
    let exclusive: Bool?
}

struct BenchParams: Codable {
    let promptTokens: Int?
    let genTokens: Int?
    let warmupIters: Int?
    let measureIters: Int?
    let nThreads: Int?
    /// Decoded and never read on iOS — the Android BenchmarkEngine turns a
    /// `benchmark` into a timed loop with it, this runner never has. Kept so
    /// the two protocols stay one protocol. Anything that wants a sustained
    /// run here should send the `thermal` workload, which is that idea done
    /// properly: a row per iteration rather than a mean over a warming device.
    let sustainedMinutes: Int?
    /// thermal: how long to keep measuring, in seconds. The workload's whole
    /// shape — it runs measured iterations until this elapses rather than a
    /// fixed count of them, because the answer is a curve against wall time.
    let durationS: Int?
    // batch / vision-eval / embed-eval / pipeline
    let inputSha256: String?
    let maxTokens: Int?
    let maxItems: Int?
    let computeUnits: String?
    let topic: String?
    let maxEvents: Int?
    let after: Int?
    /// embed-eval: the per-document token budget. Not the benchmark's prompt
    /// window — a document longer than this is truncated, identically on every
    /// device in the fleet, which is what keeps the recall numbers comparable.
    let nCtx: Int?
    // vantage
    /// The URLs to fetch. One result row per URL per repetition.
    let urls: [String]?
    /// How many times to sweep the whole list. Repetition-major, so the
    /// repeats of one URL are spread across the run.
    let repeats: Int?
    /// Per-request ceiling, so one hanging host cannot consume the job.
    let timeoutS: Int?
}

struct Constraints: Codable {
    let requireCharging: Bool?
    let minBatteryPct: Int?
}

struct JobSpec: Codable {
    let schema: Int
    let jobId: String
    let workload: String
    let executor: String
    let model: ModelRef?
    let backend: String?
    let params: BenchParams?
    let targets: Targets?
    let constraints: Constraints?
}

struct DeviceDescriptor: Codable {
    let model: String
    let soc: String
    let ramMb: Int64
    let os: String
    let appVer: String
}

struct Metrics: Codable {
    var loadMs: Int64?
    var prefillTokS: Double?
    var decodeTokS: Double?
    var ttftMs: Double?
    var peakMemMb: Int64?
    var memMethod: String?
    var thermal: [String]?
    var batteryStartPct: Int?
    var batteryEndPct: Int?

    // vision-eval. These used to ride in the LLM slots above -- accuracy in
    // decodeTokS, latency in ttftMs, throughput in prefillTokS -- and top-5 and
    // p95 had nowhere to go at all, so they reached only the uploaded report
    // artifact and never the results table. convertToSnakeCase maps these to
    // top1_pct, top5_pct, p50_ms, p95_ms and images_per_s.
    var top1Pct: Double?
    var top5Pct: Double?
    var p50Ms: Double?
    var p95Ms: Double?
    var imagesPerS: Double?

    // thermal. A benchmark row is a summary; a thermal row is a point on a
    // curve, and these two are what place it. convertToSnakeCase maps them to
    // elapsed_s and thermal_state, which is how fleet-collector's
    // schemas/metrics.json names them.
    //
    // `thermalState` is the single state at this sample, deliberately not the
    // `thermal` array above: the array is a bag of states a run passed
    // through, which cannot say when. A string rather than a number because
    // Android and iOS name their levels differently and flattening them would
    // invent a scale neither vendor publishes.
    var elapsedS: Double?
    var thermalState: String?

    // embed-eval. A query counts at k when at least one of its relevant
    // documents lands in its top k — the definition the collector's schema
    // pins for recall_at_1 ("fraction of queries whose top hit is relevant"),
    // which the wider ks have to share or the three numbers would not belong
    // to one series. `dim` rides along because recall is only comparable
    // within one embedding width: 0.71 from a 384-d model and 0.71 from a
    // 1024-d one are not the same claim. convertToSnakeCase maps these to
    // recall_at_1, recall_at_5, recall_at_10, docs_per_s and dim.
    var recallAt1: Double?
    var recallAt5: Double?
    var recallAt10: Double?
    var docsPerS: Double?
    var dim: Int?

    // vantage. One row per URL per repetition, carrying this device's view of
    // one request. Every phase is optional and that is load-bearing: a request
    // served over a pooled connection resolves no name, opens no socket and
    // shakes no hands, and reporting those as 0 would read as "instant"
    // rather than as "did not happen".
    //
    // `loadMs` above carries the whole transfer here rather than a model load
    // — the only name metrics.json offers for "how long until it was all
    // here". `networkType` is the point of the workload: the same URL measured
    // from cellular and from fibre is two answers, and a latency figure with
    // no idea what carried it is not comparable to anything.
    var dnsMs: Double?
    var connectMs: Double?
    var tlsMs: Double?
    var ttfbMs: Double?
    var networkType: String?

    /// Spelled out because `.convertToSnakeCase` cannot produce three of these
    /// names. The strategy splits on capitals and a digit is not one, so
    /// `recallAt1` encodes as **`recall_at1`** — one underscore short of the
    /// name metrics.json declares, and a metric under a name the collector
    /// does not know is a metric that silently never arrives. Every other case
    /// is listed with no raw value and still goes through the strategy, which
    /// leaves an already-snake_cased raw value alone; that is why `ttftMs` and
    /// friends keep working without being spelled out here.
    enum CodingKeys: String, CodingKey {
        case loadMs, prefillTokS, decodeTokS, ttftMs, peakMemMb, memMethod, thermal
        case batteryStartPct, batteryEndPct
        case top1Pct, top5Pct, p50Ms, p95Ms, imagesPerS
        case elapsedS, thermalState
        case recallAt1 = "recall_at_1"
        case recallAt5 = "recall_at_5"
        case recallAt10 = "recall_at_10"
        case docsPerS, dim
        case dnsMs, connectMs, tlsMs, ttfbMs, networkType
    }
}

struct BeaconSample: Codable {
    let batteryPct: Int
    let charging: Bool
    let thermal: String
}

struct ResultPost: Codable {
    var schema: Int = 1
    var kind: String
    var jobId: String?
    var deviceId: String
    var iter: Int?
    var final: Bool?
    var ok: Bool?
    var device: DeviceDescriptor?
    var metrics: Metrics?
    var beacon: BeaconSample?
    var error: String?
    var artifacts: [String]?
}

struct RegisterPost: Codable {
    let deviceId: String
    let descriptor: DeviceDescriptor
    let pools: [String]
    /// The workloads this runner can actually dispatch, so the queue only
    /// offers it work it can run. See FleetAgent.dispatchedWorkloads.
    let capabilities: [String]
}

enum FleetJSON {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}
