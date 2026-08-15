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

    /// Uploads raw bytes to the artifact store; returns the sha256.
    func uploadArtifact(_ data: Data, name: String) async throws -> String {
        var req = URLRequest(url: base.appendingPathComponent("artifacts"))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        req.setValue(name, forHTTPHeaderField: "x-artifact-name")
        let (body, res) = try await session.upload(for: req, from: data)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 201 else { throw CollectorError.http(code, "artifacts") }
        struct R: Decodable { let sha256: String }
        return try JSONDecoder().decode(R.self, from: body).sha256
    }

    func publishEvent(topic: String, payload: [String: Any]) async throws {
        var req = URLRequest(url: base.appendingPathComponent("events/\(topic)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (_, res) = try await session.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 201 else { throw CollectorError.http(code, "events") }
    }

    struct Event { let id: Int; let payload: [String: Any] }

    /// Long-polls the next event after `after`; nil when the poll expired.
    func pollEvent(topic: String, after: Int) async throws -> Event? {
        let url = base.appendingPathComponent("events/\(topic)/poll")
            .appending(queryItems: [URLQueryItem(name: "after", value: String(after))])
        let (data, res) = try await session.data(from: url)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        if code == 204 { return nil }
        guard code == 200,
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = obj["id"] as? Int else { throw CollectorError.http(code, "events/poll") }
        return Event(id: id, payload: obj["payload"] as? [String: Any] ?? [:])
    }
}
