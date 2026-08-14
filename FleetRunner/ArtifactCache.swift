import CryptoKit
import Foundation

/// Content-addressed on-device cache of collector artifacts.
final class ArtifactCache {
    private let base: URL
    private let dir: URL

    init(collectorURL: URL) {
        base = collectorURL
        dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("artifacts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// Returns the local file for sha256, downloading and verifying if absent.
    func ensure(sha256: String) async throws -> URL {
        let dest = dir.appendingPathComponent(sha256)
        if FileManager.default.fileExists(atPath: dest.path) { return dest }

        let (tmp, res) = try await URLSession.shared.download(
            from: base.appendingPathComponent("artifacts/\(sha256)"))
        guard (res as? HTTPURLResponse)?.statusCode == 200 else {
            throw CollectorError.http((res as? HTTPURLResponse)?.statusCode ?? 0, "artifacts")
        }

        // Verify the content hash before the rename, streaming to bound memory.
        var hasher = SHA256()
        let handle = try FileHandle(forReadingFrom: tmp)
        defer { try? handle.close() }
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let got = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard got == sha256 else {
            try? FileManager.default.removeItem(at: tmp)
            throw CollectorError.http(0, "artifact hash mismatch: wanted \(sha256) got \(got)")
        }
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }
}
