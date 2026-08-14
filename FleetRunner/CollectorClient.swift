import Foundation

enum CollectorError: Error, LocalizedError {
    case http(Int, String)
    var errorDescription: String? {
        if case let .http(code, path) = self { return "\(path) failed: HTTP \(code)" }
        return nil
    }
}

/// Async HTTP client for the collector.
final class CollectorClient: Sendable {
    private let base: URL
    private let session: URLSession

    init(baseURL: URL) {
        self.base = baseURL
        let config = URLSessionConfiguration.ephemeral
        // The collector holds next-job long-polls for ~25 s; stay well above.
        config.timeoutIntervalForRequest = 40
        self.session = URLSession(configuration: config)
    }

    private func post<T: Encodable>(_ path: String, body: T) async throws {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try FleetJSON.encoder.encode(body)
        let (_, res) = try await session.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw CollectorError.http(code, path) }
    }

    func register(_ body: RegisterPost) async throws {
        try await post("devices/register", body: body)
    }

    /// Long-polls for work; nil when the poll expired with no job (HTTP 204).
    func nextJob(deviceId: String) async throws -> JobSpec? {
        let url = base.appendingPathComponent("devices/\(deviceId)/next-job")
        let (data, res) = try await session.data(from: url)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        if code == 204 { return nil }
        guard code == 200 else { throw CollectorError.http(code, "next-job") }
        return try FleetJSON.decoder.decode(JobSpec.self, from: data)
    }

    func postResult(_ row: ResultPost) async throws {
        try await post("results", body: row)
    }
}
