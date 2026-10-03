import Foundation
import Network

/// The smallest HTTP/1.1 server that does the job, on Network.framework.
///
/// Why hand-rolled: the test runner is the only process on the device that may
/// call XCUITest, so the server has to live inside it, and a UI-test bundle is
/// not somewhere to pull in a web framework -- it would be a dependency to vet,
/// pin and keep building on three platforms for the sake of parsing one
/// request line and a Content-Length. What it supports is what the actuator
/// sends: one request per connection, a body only when Content-Length says so,
/// `Connection: close` on every response. No keep-alive, no chunked encoding,
/// no TLS.
///
/// Threading is the important part. Requests arrive on the listener's own
/// queue, but every XCUITest call must happen on the main thread, AND must not
/// happen re-entrantly: an XCUITest action spins the main run loop while it
/// waits for the app to go idle, so a command scheduled with
/// `DispatchQueue.main.async` would run in the middle of the previous one --
/// a tap landing halfway through a swipe. So requests are put on a locked
/// queue here, and the test's own loop takes them off one at a time
/// (`next()`), which is the only place they are ever run.
final class DriverHTTPServer {
    struct Request {
        let method: String
        /// The path without the query string.
        let path: String
        let query: [String: String]
        let headers: [String: String]
        let body: Data

        /// The body as a JSON object, or an empty one for a request without a body.
        func json() throws -> [String: Any] {
            if body.isEmpty { return [:] }
            guard let obj = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                throw DriverError.badRequest("the body is not a JSON object")
            }
            return obj
        }
    }

    struct Response {
        var status: Int
        var contentType: String
        var body: Data

        static func json(_ obj: [String: Any], status: Int = 200) -> Response {
            // `.fragmentsAllowed` is not needed: every response is an object.
            let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
            return Response(status: status, contentType: "application/json", body: data)
        }

        static func error(_ message: String, status: Int) -> Response {
            .json(["ok": false, "error": message], status: status)
        }
    }

    /// A request waiting for the main loop, and how to answer it.
    struct Job {
        let request: Request
        let respond: (Response) -> Void
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "fleet.driver.http")
    private let lock = NSLock()
    private var pending: [Job] = []
    private let token: String?
    /// Requests larger than this are refused. The biggest legitimate body is a
    /// `/type` of a paragraph; a megabyte is room for every honest client.
    private let maxBody = 1 << 20

    /// Set once the listener is accepting, or once it has failed for good.
    private(set) var ready = false
    private(set) var failure: String?

    /// - Parameters:
    ///   - port: TCP port to listen on.
    ///   - loopbackOnly: bind 127.0.0.1 only. True on a simulator, where the
    ///     test runner shares the Mac's network stack: listening on every
    ///     interface there would put a remote control for the simulator on the
    ///     LAN. False on hardware, where the Mac reaches the device over the
    ///     CoreDevice tunnel interface and loopback is unreachable from it.
    ///   - token: when set, every request must carry it in `X-Fleet-Driver-Token`.
    init(port: UInt16, loopbackOnly: Bool, token: String?) throws {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw DriverError.badRequest("invalid port \(port)")
        }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        if loopbackOnly {
            params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
            listener = try NWListener(using: params)
        } else {
            listener = try NWListener(using: params, on: nwPort)
        }
        self.token = (token?.isEmpty ?? true) ? nil : token
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.lock.lock(); self.ready = true; self.lock.unlock()
            case .failed(let err):
                self.lock.lock(); self.failure = "\(err)"; self.ready = false; self.lock.unlock()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        listener.start(queue: queue)
    }

    func stop() {
        listener.cancel()
    }

    /// The listener's state, read under the lock it is written under.
    func state() -> (ready: Bool, failure: String?) {
        lock.lock(); defer { lock.unlock() }
        return (ready, failure)
    }

    /// The oldest request nobody has handled yet. Main thread only, by convention.
    func next() -> Job? {
        lock.lock(); defer { lock.unlock() }
        return pending.isEmpty ? nil : pending.removeFirst()
    }

    // MARK: - Connections

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    /// Read until the headers are complete and Content-Length bytes of body
    /// have arrived, then queue the request. One request per connection.
    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { conn.cancel(); return }
            var buf = buffer
            if let data { buf.append(data) }
            if error != nil { conn.cancel(); return }

            switch self.parse(buf) {
            case .incomplete:
                if isComplete { conn.cancel(); return }
                if buf.count > self.maxBody + 16 * 1024 {
                    self.send(conn, .error("request too large", status: 413))
                    return
                }
                self.receive(conn, buffer: buf)
            case .bad(let why):
                self.send(conn, .error(why, status: 400))
            case .done(let req):
                if let token = self.token, req.headers["x-fleet-driver-token"] != token {
                    self.send(conn, .error("missing or wrong X-Fleet-Driver-Token", status: 401))
                    return
                }
                let job = Job(request: req) { [weak self] resp in self?.send(conn, resp) }
                self.lock.lock(); self.pending.append(job); self.lock.unlock()
            }
        }
    }

    private enum Parsed {
        case incomplete
        case bad(String)
        case done(Request)
    }

    private func parse(_ buf: Data) -> Parsed {
        guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
        guard let head = String(data: buf[buf.startIndex..<headerEnd.lowerBound], encoding: .utf8) else {
            return .bad("headers are not UTF-8")
        }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count >= 2 else { return .bad("malformed request line") }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        if length < 0 || length > maxBody { return .bad("bad Content-Length \(length)") }
        let bodyStart = headerEnd.upperBound
        if buf.count - (bodyStart - buf.startIndex) < length { return .incomplete }
        let body = buf[bodyStart..<(bodyStart + length)]

        // Split the target into a path and a decoded query.
        let target = String(requestLine[1])
        let comps = URLComponents(string: "http://driver" + target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return .done(Request(
            method: String(requestLine[0]).uppercased(),
            path: comps?.path ?? target,
            query: query,
            headers: headers,
            body: Data(body)
        ))
    }

    private func send(_ conn: NWConnection, _ resp: Response) {
        let reason: String
        switch resp.status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 401: reason = "Unauthorized"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        case 413: reason = "Payload Too Large"
        case 422: reason = "Unprocessable Entity"
        default: reason = "Error"
        }
        var head = "HTTP/1.1 \(resp.status) \(reason)\r\n"
        head += "Content-Type: \(resp.contentType)\r\n"
        head += "Content-Length: \(resp.body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(resp.body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

/// What a handler throws. The status code is part of the error so the server
/// can answer with it, and nothing a handler does can take the runner down.
enum DriverError: Error, CustomStringConvertible {
    /// The request was wrong: a missing field, a key this platform lacks.
    case badRequest(String)
    /// The request was fine and the device could not do it.
    case failed(String)

    var status: Int {
        switch self {
        case .badRequest: return 400
        case .failed: return 500
        }
    }

    var description: String {
        switch self {
        case .badRequest(let s), .failed(let s): return s
        }
    }
}
