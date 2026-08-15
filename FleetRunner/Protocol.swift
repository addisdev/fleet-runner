import Foundation

// Swift mirror of fleet-collector/schemas ("schema": 1). Shared protocol, not
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
    let sustainedMinutes: Int?
    // batch / vision-eval / pipeline
    let inputSha256: String?
    let maxTokens: Int?
    let maxItems: Int?
    let computeUnits: String?
    let topic: String?
    let maxEvents: Int?
    let after: Int?
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
