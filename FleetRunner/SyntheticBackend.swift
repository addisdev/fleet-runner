import CryptoKit
import Foundation

struct IterResult {
    let prefillTokS: Double
    let decodeTokS: Double
    let ttftMs: Double
}

/// Mirror of the Android SyntheticBackend, token for token: each "token" is
/// ROUNDS_PER_TOKEN SHA-256 hashes of a 4 KiB block with the digest folded
/// back in, so tok/s measures real sustained CPU throughput and stays
/// comparable across the fleet. Backend name "synthetic" — hardware numbers,
/// never LLM numbers.
final class SyntheticBackend {
    static let roundsPerToken = 1000
    static let blockSize = 4096

    private var block: [UInt8] = []

    /// Returns load time in ms.
    func load() -> Int64 {
        let t0 = DispatchTime.now()
        block = (0..<Self.blockSize).map { UInt8(truncatingIfNeeded: $0 &* 31) }
        _ = SHA256.hash(data: Data(block))
        return Int64((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }

    private func hashTokens(_ tokens: Int) -> Int64 {
        precondition(!block.isEmpty, "load() not called")
        let t0 = DispatchTime.now()
        for _ in 0..<(tokens * Self.roundsPerToken) {
            let digest = SHA256.hash(data: Data(block))
            var i = 0
            for byte in digest {
                block[i] = byte
                i += 1
            }
        }
        return Int64((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }

    func runIteration(promptTokens: Int, genTokens: Int) -> IterResult {
        let prefillMs = hashTokens(promptTokens)
        let firstTokenMs = hashTokens(1)
        let decodeMs = firstTokenMs + hashTokens(max(genTokens - 1, 0))
        return IterResult(
            prefillTokS: Double(promptTokens) * 1000.0 / Double(max(prefillMs, 1)),
            decodeTokS: Double(genTokens) * 1000.0 / Double(max(decodeMs, 1)),
            ttftMs: Double(prefillMs + firstTokenMs)
        )
    }

    func unload() {
        block = []
    }
}
