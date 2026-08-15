import CoreML
import Foundation
import UIKit
import Vision

/// Core ML image classifier — the iOS counterpart of the Android LiteRT
/// backend. Models arrive as zipped compiled `.mlmodelc` bundles (or
/// `.mlpackage`, compiled on-device). Preprocessing is folded into the model
/// (ImageType with ImageNet scale/bias) so the app hands over raw RGB pixels;
/// params.compute_units selects "all" (ANE+GPU+CPU), "cpu_gpu", or "cpu".
final class CoreMLBackend {
    private var model: MLModel?
    private var inputName = "image"
    private var outputName = "logits"
    private(set) var inputSize = 224
    private(set) var computeUnitsUsed = "all"
    private(set) var lastDebug = ""

    /// Returns load time in ms.
    func load(modelDir: URL, computeUnits: String) throws -> Int64 {
        let t0 = DispatchTime.now()
        let config = MLModelConfiguration()
        var effective = computeUnits
        #if targetEnvironment(simulator)
        // The Simulator's emulated GPU/ANE returned an all-zero logits tensor
        // for this model class (verified: identical inputs give correct
        // logits on .cpuOnly and on the Mac). Force CPU on simulators and say
        // so; real devices honor the requested units.
        if effective != "cpu" { effective = "cpu (simulator: gpu/ane emulation unreliable)" }
        config.computeUnits = .cpuOnly
        #else
        switch computeUnits {
        case "cpu": config.computeUnits = .cpuOnly
        case "cpu_gpu": config.computeUnits = .cpuAndGPU
        default: config.computeUnits = .all
        }
        #endif
        computeUnitsUsed = effective

        var url = modelDir
        if url.pathExtension == "mlpackage" || url.pathExtension == "mlmodel" {
            url = try MLModel.compileModel(at: url)
        }
        let m = try MLModel(contentsOf: url, configuration: config)
        model = m

        let desc = m.modelDescription
        if let (name, feature) = desc.inputDescriptionsByName.first {
            inputName = name
            if let c = feature.imageConstraint { inputSize = Int(c.pixelsWide) }
        }
        if let name = desc.outputDescriptionsByName.keys.first { outputName = name }
        return Int64((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }

    /// Classify one square image; returns (top-k class indices, latency ms).
    func classify(_ image: UIImage, k: Int) throws -> ([Int], Double) {
        guard let model else { throw CollectorError.http(0, "model not loaded") }
        guard let buffer = image.pixelBuffer(size: inputSize) else {
            throw CollectorError.http(0, "pixel buffer conversion failed")
        }
        let input = try MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: buffer)])
        let t0 = DispatchTime.now()
        let out = try model.prediction(from: input)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
        // Take the first multi-array output whatever its name (converters
        // sometimes rename), and read it through the typed pointer with the
        // real stride so a [1,1081] array isn't misread.
        var arr: MLMultiArray?
        for name in out.featureNames {
            if let a = out.featureValue(for: name)?.multiArrayValue { arr = a; outputName = name; break }
        }
        guard let arr else { throw CollectorError.http(0, "no multi-array output; features: \(out.featureNames)") }
        // Read through the strided subscript — the output is float16 with a
        // leading batch dim, and raw dataPointer indexing silently misreads
        // it (produced "class 0 for every image" on the simulator).
        let n = arr.count
        var scores = [Float](repeating: 0, count: n)
        for i in 0..<n { scores[i] = arr[i].floatValue }
        let top = scores.indices.sorted { scores[$0] > scores[$1] }.prefix(k)
        // Diagnostic breadcrumb for the report: shape/dtype/first logits and
        // a pixel sample, so a wrong-input failure is visible from the artifact.
        let px = CVPixelBufferLockAndSample(buffer)
        lastDebug = "out=\(outputName) shape=\(arr.shape) dtype=\(arr.dataType.rawValue) n=\(n) first3=\(scores.prefix(3).map { $0 }) max=\(scores.max() ?? 0) inSize=\(inputSize) pixels=\(px) features=\(out.featureNames)"
        return (Array(top), ms)
    }

    func unload() { model = nil }
}

private func CVPixelBufferLockAndSample(_ b: CVPixelBuffer) -> String {
    CVPixelBufferLockBaseAddress(b, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(b) else { return "nil" }
    let p = base.assumingMemoryBound(to: UInt8.self)
    let w = CVPixelBufferGetWidth(b), fmt = CVPixelBufferGetPixelFormatType(b)
    let mid = (w / 2) * CVPixelBufferGetBytesPerRow(b) + (w / 2) * 4
    return "fmt=\(fmt) \(w)px mid=[\(p[mid]),\(p[mid+1]),\(p[mid+2]),\(p[mid+3])]"
}

extension UIImage {
    /// 32ARGB pixel buffer at the model's input size — the format Vision/Core ML
    /// image inputs accept without a color-space guess. Drawn through
    /// CoreGraphics so orientation and decode happen the same way for every
    /// source. Returns nil (never a silent black frame) if the draw fails.
    func pixelBuffer(size: Int) -> CVPixelBuffer? {
        guard let cg = cgImage ?? UIImage(data: pngData() ?? Data())?.cgImage else { return nil }
        var pb: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        guard CVPixelBufferCreate(kCFAllocatorDefault, size, size, kCVPixelFormatType_32ARGB,
                                  attrs as CFDictionary, &pb) == kCVReturnSuccess, let buffer = pb else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer),
              let ctx = CGContext(data: base, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
        // Guard against the failure mode that produced all-class-0 predictions:
        // a buffer that drew nothing is uniformly zero.
        let px = base.assumingMemoryBound(to: UInt8.self)
        var nonZero = false
        for i in stride(from: 0, to: min(4096, size * 4), by: 7) where px[i] != 0 { nonZero = true; break }
        return nonZero ? buffer : nil
    }
}
