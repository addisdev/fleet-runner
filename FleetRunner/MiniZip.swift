import Compression
import Foundation

/// Minimal ZIP extractor: walks the central directory, handles stored (0)
/// and deflate (8) entries via the Compression framework. Enough for the
/// fleet's own artifacts (eval sets, .mlmodelc bundles); not a general tool
/// (no zip64, no encryption, no data descriptors on the read path).
enum MiniZip {
    struct ZipError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func extract(_ zipURL: URL, to dest: URL) throws {
        let data = try Data(contentsOf: zipURL, options: .mappedIfSafe)
        guard data.count > 22 else { throw ZipError(message: "zip too small") }

        // End of central directory: scan back for signature 0x06054b50.
        var eocd = -1
        var i = data.count - 22
        while i >= max(0, data.count - 22 - 65_535) {
            if data.u32(at: i) == 0x0605_4b50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ZipError(message: "no end-of-central-directory") }
        let entryCount = Int(data.u16(at: eocd + 10))
        var offset = Int(data.u32(at: eocd + 16))

        let destPath = dest.standardizedFileURL.path
        for _ in 0..<entryCount {
            guard data.u32(at: offset) == 0x0201_4b50 else { throw ZipError(message: "bad central header") }
            let method = data.u16(at: offset + 10)
            let compSize = Int(data.u32(at: offset + 20))
            let nameLen = Int(data.u16(at: offset + 28))
            let extraLen = Int(data.u16(at: offset + 30))
            let commentLen = Int(data.u16(at: offset + 32))
            let localOffset = Int(data.u32(at: offset + 42))
            let name = String(decoding: data[(offset + 46)..<(offset + 46 + nameLen)], as: UTF8.self)
            offset += 46 + nameLen + extraLen + commentLen

            // Local header to find the data start.
            guard data.u32(at: localOffset) == 0x0403_4b50 else { throw ZipError(message: "bad local header") }
            let lNameLen = Int(data.u16(at: localOffset + 26))
            let lExtraLen = Int(data.u16(at: localOffset + 28))
            let start = localOffset + 30 + lNameLen + lExtraLen
            let payload = data.subdata(in: start..<(start + compSize))

            let out = dest.appendingPathComponent(name)
            guard out.standardizedFileURL.path.hasPrefix(destPath) else { throw ZipError(message: "zip slip: \(name)") }
            if name.hasSuffix("/") {
                try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                continue
            }
            try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            switch method {
            case 0: try payload.write(to: out)
            case 8: try inflate(payload).write(to: out)
            default: throw ZipError(message: "unsupported method \(method) for \(name)")
            }
        }
    }

    private static func inflate(_ input: Data) throws -> Data {
        var out = Data()
        let bufSize = 1 << 16
        let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        defer { dst.deallocate() }
        let streamPtr = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPtr.deallocate() }
        var status = compression_stream_init(streamPtr, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
        guard status == COMPRESSION_STATUS_OK else { throw ZipError(message: "inflate init") }
        defer { compression_stream_destroy(streamPtr) }
        try input.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            streamPtr.pointee.src_ptr = src.bindMemory(to: UInt8.self).baseAddress!
            streamPtr.pointee.src_size = input.count
            repeat {
                streamPtr.pointee.dst_ptr = dst
                streamPtr.pointee.dst_size = bufSize
                status = compression_stream_process(streamPtr, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                guard status != COMPRESSION_STATUS_ERROR else { throw ZipError(message: "inflate failed") }
                out.append(dst, count: bufSize - streamPtr.pointee.dst_size)
            } while status == COMPRESSION_STATUS_OK
        }
        return out
    }
}

private extension Data {
    func u16(at i: Int) -> UInt16 { UInt16(self[startIndex + i]) | (UInt16(self[startIndex + i + 1]) << 8) }
    func u32(at i: Int) -> UInt32 {
        UInt32(self[startIndex + i]) | (UInt32(self[startIndex + i + 1]) << 8) |
        (UInt32(self[startIndex + i + 2]) << 16) | (UInt32(self[startIndex + i + 3]) << 24)
    }
}
