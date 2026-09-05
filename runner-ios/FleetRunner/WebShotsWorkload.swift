import Foundation
import UIKit
import WebKit

/// web-shots on a real iPhone: the half of the visual-regression matrix the
/// host executor cannot reach.
///
/// The host captures real Chrome on real Android hardware over adb, and Safari
/// on iOS *simulators* through `simctl`. A real iPhone had no capture path at
/// all — `collector/docs/operations.md` says so plainly — so the matrix has
/// been advertising real phone screens while half the real phones were missing
/// from it. This closes that as a device job: a `WKWebView` inside the runner
/// app, which is the same WebKit engine Safari renders with, needs no WebDriver
/// session, and is already sitting on the phone.
///
/// It is a device job rather than a host one on purpose. The device is the
/// machine that renders the pixels, so the device is the only machine whose
/// baselines they can be compared against — the same argument that keeps the
/// host's diffing on the host. See `WebShots.profile` for what the profile is
/// called and why it is not called `safari`.
///
/// Result shape follows the host's: one row per page carrying the page's
/// `shot` block (suite, page, profile, sha256) and its `diff_pct`, then one
/// closing final row. Unlike the host there is no per-profile summary row —
/// a device is one profile, and a summary row would collide with the final row
/// on (job_id, device_id, iter=0) and silently overwrite it.
extension Workloads {

    static let webShotsLoadTimeoutS: TimeInterval = 30
    static let webShotsWaitForTimeoutS: TimeInterval = 15

    static func runWebShots(job: JobSpec, client: CollectorClient, deviceId: String,
                            artifacts: ArtifactCache) async {
        func fail(_ m: String) async {
            try? await client.postResult(
                ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                           iter: 0, final: true, ok: false,
                           device: Telemetry.descriptor(), error: m))
        }

        guard let base = job.targets?.url, !base.isEmpty else {
            await fail("web-shots needs targets.url"); return
        }
        // The suite is the first third of a baseline's key. A capture with no
        // suite has no cell in the matrix to land in, so this is refused rather
        // than defaulted — a default would file every suite's shots together.
        guard let suite = job.suite?.flows, !suite.isEmpty else {
            await fail("web-shots needs suite.flows (the web-specs/<site> directory that names this suite)")
            return
        }

        let manifest: ShotsManifest
        let pages: [ShotPage]
        do {
            if let sha = job.params?.inputSha256 {
                let file = try await artifacts.ensure(sha256: sha)
                manifest = try WebShots.decodeManifest(try Data(contentsOf: file))
            } else if let inline = job.params?.shots {
                manifest = inline
            } else {
                throw WebShotsError(
                    message: "web-shots needs params.input_sha256 (the shots.json artifact) or params.shots")
            }
            pages = try WebShots.pages(of: manifest)
        } catch {
            await fail(error.localizedDescription); return
        }

        // A manifest that asks for a frozen clock and does not get one produces
        // a page that fails its diff whenever the minute rolls over, which
        // reads as a flaky site rather than as a manifest this runner could not
        // honour. Refuse the job instead.
        var freezeScript: String?
        if let freeze = manifest.freezeTime {
            guard let script = WebShots.freezeTimeScript(freeze) else {
                await fail("shots.json freeze_time is not an ISO-8601 instant this runner can parse: \(freeze)")
                return
            }
            freezeScript = script
        }

        let profile = WebShots.profile(deviceId: deviceId)

        // The accepted truth for this suite. A failure here fails the job: a
        // page that cannot be judged is not a page that passed, and capturing
        // anyway would fill the matrix with cells that look accepted-and-clean
        // because nothing was ever compared.
        let baselines: [String: String]
        do {
            baselines = try await client.visualBaselines(suite: suite)
        } catch {
            await fail("baselines fetch failed: \(error.localizedDescription)"); return
        }

        let capture: WebShotCapture
        do {
            capture = try await WebShotCapture.make(freezeScript: freezeScript)
        } catch {
            await fail(error.localizedDescription); return
        }
        defer { Task { @MainActor in capture.tearDown() } }

        let batteryStart = Telemetry.batteryPct()
        var captured = 0
        var diverged = 0
        var shas: [String] = []
        var report: [[String: Any]] = []

        for (index, page) in pages.enumerated() {
            // Iteration boundary: a beacon may have found the lease gone. The
            // rows already posted stay valid; the pages after this never happen.
            if CancellationRegistry.shared.isCancelled(job.jobId) {
                try? await client.postResult(
                    ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                               iter: 0, final: true, ok: false,
                               device: Telemetry.descriptor(), error: "cancelled"))
                return
            }

            let name = page.name ?? "page-\(index + 1)"
            var ok = false
            var note: String?
            var sha: String?
            var diffSha: String?
            var diffPct: Double?
            var rowArtifacts: [String] = []
            var row: [String: Any] = ["iter": index + 1, "page": name]

            guard let pageURL = WebShots.pageURL(base: base, path: page.path ?? "") else {
                note = "page '\(name)' path \(page.path.map { "'\($0)'" } ?? "(none)") is not a URL against \(base)"
                row["error"] = note!
                report.append(row)
                await postShotRow(client: client, job: job, deviceId: deviceId, iter: index + 1,
                                  ok: false, suite: suite, page: name, profile: profile,
                                  sha: nil, diffSha: nil, diffPct: nil, artifacts: [], note: note)
                continue
            }
            row["url"] = pageURL.absoluteString

            do {
                let shot = try await capture.capture(page: page, url: pageURL)
                captured += 1
                ok = true
                row["width_px"] = shot.widthPx
                row["height_px"] = shot.heightPx
                row["bytes"] = shot.png.count
                if let truncated = shot.truncatedNote { row["note"] = truncated }

                sha = try await client.uploadArtifact(shot.png, name: "\(job.jobId)-\(profile)-\(name).png")
                rowArtifacts.append(sha!)
                shas.append(sha!)

                let threshold = WebShots.threshold(for: page, in: manifest)
                row["threshold_pct"] = threshold
                if let baseline = baselines["\(name)|\(profile)"] {
                    if baseline == sha {
                        diffPct = 0 // identical bytes; nothing to decode
                    } else {
                        do {
                            let baselineFile = try await artifacts.ensure(sha256: baseline)
                            let outcome = try ShotDiff.compare(
                                captured: shot.png, baseline: try Data(contentsOf: baselineFile))
                            diffPct = outcome.diffPct
                            if outcome.diffPct > threshold {
                                ok = false
                                diverged += 1
                                note = outcome.note
                                    ?? String(format: "%.2f%% of pixels differ (threshold %g%%)",
                                              outcome.diffPct, threshold)
                                // The diff image only when it matters: a
                                // within-threshold pair has nothing worth a
                                // person's look, and the store is forever.
                                if let diffPNG = outcome.diffPNG {
                                    diffSha = try await client.uploadArtifact(
                                        diffPNG, name: "\(job.jobId)-\(profile)-\(name)-diff.png")
                                    rowArtifacts.append(diffSha!)
                                }
                            }
                        } catch {
                            // A baseline the store cannot produce is an
                            // operational problem, not a visual regression —
                            // but it must fail, loudly, because a page that
                            // cannot be judged is not a page that passed.
                            ok = false
                            diverged += 1
                            note = "baseline \(baseline.prefix(12))… unusable: \(error.localizedDescription)"
                        }
                    }
                } else {
                    // Visible, not failing: a new page's first capture is not a
                    // regression, but it stays flagged until someone accepts it.
                    note = "new: no baseline — accept this shot to start diffing"
                }
            } catch {
                note = "no screenshot for page '\(name)': \(error.localizedDescription)"
            }

            if let diffPct { row["diff_pct"] = diffPct }
            if let sha { row["sha256"] = sha }
            if let note { row["error"] = note }
            row["ok"] = ok
            report.append(row)

            await postShotRow(client: client, job: job, deviceId: deviceId, iter: index + 1,
                              ok: ok, suite: suite, page: name, profile: profile,
                              sha: sha, diffSha: diffSha, diffPct: diffPct,
                              artifacts: rowArtifacts, note: note)
        }

        // The rows carry no URL and no capture size — the result schema has no
        // field for either — so the report is what makes a red matrix
        // debuggable without a person guessing which path a page name meant.
        var finalArtifacts = shas
        let summaryJSON: [String: Any] = [
            "job_id": job.jobId, "device_id": deviceId,
            "suite": suite, "profile": profile, "base_url": base,
            "pages": pages.count, "captured": captured, "diverged": diverged,
            "engine": "WKWebView (WebKit); not Safari — no reader mode, no content blockers",
            "screen_pt": ["width": capture.screenSize.width, "height": capture.screenSize.height],
            "rows": report,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: summaryJSON),
           let sha = try? await client.uploadArtifact(data, name: "\(job.jobId)-web-shots.json") {
            finalArtifacts.append(sha)
        }

        let missed = pages.count - captured
        let ok = missed == 0 && diverged == 0
        let problems = [
            missed > 0 ? "\(missed) of \(pages.count) pages not captured" : nil,
            diverged > 0 ? "\(diverged) page(s) diverged from baseline" : nil,
        ].compactMap { $0 }.joined(separator: "; ")

        var summary = Metrics()
        summary.peakMemMb = Telemetry.physFootprintMb()
        summary.memMethod = "phys_footprint"
        summary.thermal = [Telemetry.thermal()]
        summary.batteryStartPct = batteryStart
        summary.batteryEndPct = Telemetry.batteryPct()

        try? await client.postResult(
            ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                       iter: 0, final: true, ok: ok,
                       device: Telemetry.descriptor(), metrics: summary,
                       error: ok ? nil : problems,
                       artifacts: finalArtifacts.isEmpty ? nil : finalArtifacts,
                       test: TestOutcome(passed: pages.count - missed - diverged,
                                         failed: missed + diverged, artifacts: nil)))
    }

    /// One cell of the matrix, posted the way the collector's
    /// /api/visual/matrix expects to read it back.
    ///
    /// `diff_pct` is the only metric here and it is a named field — never
    /// laundered through a slot that means something else. There is no metric
    /// name in the collector's closed list for "pages captured", so that count
    /// lives in `test` and in the report artifact rather than being invented.
    private static func postShotRow(
        client: CollectorClient, job: JobSpec, deviceId: String, iter: Int, ok: Bool,
        suite: String, page: String, profile: String,
        sha: String?, diffSha: String?, diffPct: Double?, artifacts: [String], note: String?
    ) async {
        var metrics: Metrics?
        if let diffPct {
            var m = Metrics()
            m.diffPct = (diffPct * 10_000).rounded() / 10_000
            metrics = m
        }
        try? await client.postResult(
            ResultPost(kind: "result", jobId: job.jobId, deviceId: deviceId,
                       iter: iter, ok: ok, metrics: metrics, error: note,
                       test: TestOutcome(passed: ok ? 1 : 0, failed: ok ? 0 : 1,
                                         artifacts: artifacts.isEmpty ? nil : artifacts),
                       shot: ShotRef(suite: suite, page: page, profile: profile,
                                     sha256: sha, diffSha256: diffSha)))
    }
}

// MARK: - capture

/// One page's pixels, plus what the row needs to say about how they were taken.
struct WebShot {
    let png: Data
    let widthPx: Int
    let heightPx: Int
    /// Set when a full-page capture hit `WebShots.maxFullPageHeight`, so a
    /// clipped baseline is a visible caveat rather than a quiet one.
    let truncatedNote: String?
}

/// An offscreen `WKWebView`, sized to the device's screen, that captures one
/// page at a time.
///
/// The web view lives in a `UIWindow` of its own at one level *below* normal,
/// rather than inside the runner's own view hierarchy. WebKit renders lazily
/// for a view with no window, so a detached web view snapshots blank; a window
/// under the app's own opaque one is a real render surface that never appears
/// on screen and never disturbs the screen that is there. It is deliberately
/// not made key: the runner's UI keeps the keyboard and the focus it had.
///
/// One instance per job, reused across pages: a fresh web view per page would
/// pay process-launch cost per cell of the matrix, and its data store is
/// non-persistent anyway, so nothing carries over that a reload would not.
@MainActor
final class WebShotCapture: NSObject, WKNavigationDelegate {
    private var window: UIWindow?
    private let webView: WKWebView
    private var pending: CheckedContinuation<Void, Error>?
    private var timeoutTask: Task<Void, Never>?
    let screenSize: CGSize

    static func make(freezeScript: String?) async throws -> WebShotCapture {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState != .background }) ?? UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first
        else {
            // Not defaulted to a guessed screen size: the profile's whole
            // meaning is "this device's screen", and inventing one would make
            // the baseline a fiction.
            throw WebShotsError(
                message: "no window scene — the runner must be in the foreground to capture web shots")
        }
        return WebShotCapture(scene: scene, freezeScript: freezeScript)
    }

    private init(scene: UIWindowScene, freezeScript: String?) {
        let bounds = scene.screen.bounds
        screenSize = bounds.size

        let config = WKWebViewConfiguration()
        // Non-persistent, so no cache or cookie jar left by an earlier job can
        // serve a page that no longer renders that way.
        config.websiteDataStore = .nonPersistent()
        config.suppressesIncrementalRendering = true
        if let freezeScript {
            config.userContentController.addUserScript(
                WKUserScript(source: freezeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }

        webView = WKWebView(frame: CGRect(origin: .zero, size: bounds.size), configuration: config)
        webView.isOpaque = true
        webView.backgroundColor = .white
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        super.init()
        webView.navigationDelegate = self

        let window = UIWindow(windowScene: scene)
        window.frame = bounds
        window.windowLevel = .normal - 1
        let host = UIViewController()
        host.view.backgroundColor = .white
        host.view.addSubview(webView)
        window.rootViewController = host
        window.isHidden = false
        self.window = window
    }

    func tearDown() {
        finish(.failure(WebShotsError(message: "capture torn down")))
        webView.navigationDelegate = nil
        webView.stopLoading()
        webView.removeFromSuperview()
        window?.isHidden = true
        window = nil
    }

    /// Load one page and photograph it.
    func capture(page: ShotPage, url: URL) async throws -> WebShot {
        // Back to the screen's own size before every page: the previous page
        // may have grown the view for a full-page shot, and a viewport that
        // depends on which page ran before it is not a baseline.
        webView.frame = CGRect(origin: .zero, size: screenSize)
        webView.layoutIfNeeded()

        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                                timeoutInterval: Workloads.webShotsLoadTimeoutS))
        try await waitForLoad(timeout: Workloads.webShotsLoadTimeoutS)

        if let selector = page.waitFor, !selector.isEmpty {
            try await waitFor(selector: selector, timeout: Workloads.webShotsWaitForTimeoutS)
        }

        // Determinism first, then fonts, then settle: injected CSS can change
        // layout, and web fonts certainly do, so both must land before the
        // settle window rather than during it.
        try? await inject(css: WebShots.killMotionCSS)
        if let mask = page.mask, !mask.isEmpty {
            try? await inject(css: WebShots.maskCSS(mask))
        }
        _ = try? await webView.callAsyncJavaScript(
            "await document.fonts.ready; return true;", contentWorld: .page)

        let settle = WebShots.settleMs(for: page)
        if settle > 0 { try? await Task.sleep(for: .milliseconds(settle)) }

        var truncated: String?
        if page.fullPage ?? true {
            let full = await contentHeight()
            let wanted = max(full, screenSize.height)
            let height = min(wanted, WebShots.maxFullPageHeight)
            if wanted > WebShots.maxFullPageHeight {
                truncated = "full-page capture clipped at \(Int(WebShots.maxFullPageHeight))pt " +
                    "of \(Int(wanted))pt"
            }
            if abs(height - webView.frame.height) > 0.5 {
                webView.frame = CGRect(origin: .zero, size: CGSize(width: screenSize.width, height: height))
                webView.layoutIfNeeded()
                // The resize is a layout change of its own; give the page the
                // frame it needs to reflow into it before the shutter.
                try? await Task.sleep(for: .milliseconds(250))
            }
        }

        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: webView.bounds.size)
        config.afterScreenUpdates = true
        let image = try await webView.takeSnapshot(configuration: config)
        guard let png = image.pngData() else {
            throw WebShotsError(message: "snapshot produced no PNG")
        }
        return WebShot(png: png,
                       widthPx: Int(image.size.width * image.scale),
                       heightPx: Int(image.size.height * image.scale),
                       truncatedNote: truncated)
    }

    // MARK: navigation

    private func waitForLoad(timeout: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            pending = c
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled else { return }
                self?.finish(.failure(WebShotsError(
                    message: "load did not finish inside \(Int(timeout))s")))
            }
        }
    }

    /// Resumes whatever is waiting on a navigation, at most once. Everything
    /// here runs on the main actor, so "at most once" needs no lock — but it
    /// does need this one funnel, because a timeout and a `didFail` racing to
    /// resume the same continuation is a crash, not a failed job.
    private func finish(_ result: Result<Void, Error>) {
        guard let c = pending else { return }
        pending = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        c.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(.success(()))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        finish(.failure(error))
    }

    // MARK: page helpers

    private func waitFor(selector: String, timeout: TimeInterval) async throws {
        let js = "document.querySelector(\(WebShots.jsLiteral(selector))) !== null"
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = try? await webView.evaluateJavaScript(js), (value as? Bool) == true { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
        throw WebShotsError(message: "waitFor '\(selector)' never matched inside \(Int(timeout))s")
    }

    private func inject(css: String) async throws {
        let js = """
        (function () {
          var s = document.createElement('style');
          s.textContent = \(WebShots.jsLiteral(css));
          (document.head || document.documentElement).appendChild(s);
          return true;
        })();
        """
        _ = try await webView.evaluateJavaScript(js)
    }

    /// The page's full scroll height in points, falling back to the viewport
    /// when the page will not say — a fallback that captures the fold rather
    /// than capturing nothing.
    private func contentHeight() async -> CGFloat {
        let js = """
        Math.ceil(Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0));
        """
        if let value = try? await webView.evaluateJavaScript(js), let n = value as? NSNumber {
            let h = CGFloat(truncating: n)
            if h.isFinite && h > 0 { return h }
        }
        return screenSize.height
    }
}

// MARK: - diffing

/// How far a capture drifted from its accepted baseline.
///
/// Diffing happens on the device for the same reason the host diffs on the
/// host: a baseline is only comparable to pixels rendered by the same
/// renderer on the same screen. Shipping the bytes to the collector to be
/// judged would look tidier and would be wrong — the collector has no idea
/// what this phone's subpixel rendering looks like, and moving the judgement
/// there would quietly make every device's baseline mean "whatever the
/// collector's decoder thinks".
enum ShotDiff {

    struct Outcome {
        let diffPct: Double
        let diffPNG: Data?
        let note: String?
    }

    /// pixelmatch's colour distance and its default threshold, so "is this
    /// pixel different" means the same thing on the phone as it does on the
    /// host. What is *not* ported is pixelmatch's antialiasing detection: it
    /// needs each pixel's neighbourhood in both images and is a workload of its
    /// own. The practical consequence is that this reads slightly hotter than
    /// the host on text edges, which is a reason to set a suite's
    /// `threshold_pct` with the device column in mind — not a reason to compare
    /// the two columns, which nothing does.
    private static let maxDelta = 35215.0 * 0.1 * 0.1

    static func compare(captured: Data, baseline: Data) throws -> Outcome {
        guard let capturedImage = UIImage(data: captured)?.cgImage else {
            throw WebShotsError(message: "captured PNG could not be decoded")
        }
        guard let baselineImage = UIImage(data: baseline)?.cgImage else {
            throw WebShotsError(message: "baseline PNG could not be decoded")
        }
        let w = capturedImage.width, h = capturedImage.height
        guard w == baselineImage.width, h == baselineImage.height else {
            // A size change short-circuits to 100%, as it does on the host:
            // mismatched grids cannot be compared pixel for pixel, and a page
            // whose height changed has materially changed however its
            // overlapping pixels look.
            return Outcome(
                diffPct: 100,
                diffPNG: nil,
                note: "dimensions changed: \(w)×\(h) vs baseline " +
                      "\(baselineImage.width)×\(baselineImage.height)")
        }
        guard w > 0, h > 0 else {
            throw WebShotsError(message: "captured PNG has no pixels")
        }

        let a = try raster(capturedImage)
        let b = try raster(baselineImage)

        var diffMask = [Bool](repeating: false, count: w * h)
        var differing = 0
        for i in 0..<(w * h) {
            let o = i * 4
            if delta(a[o], a[o + 1], a[o + 2], b[o], b[o + 1], b[o + 2]) > maxDelta {
                diffMask[i] = true
                differing += 1
            }
        }
        let pct = Double(differing) * 100.0 / Double(w * h)
        return Outcome(diffPct: pct,
                       diffPNG: differing > 0 ? diffImage(mask: diffMask, base: a, width: w, height: h) : nil,
                       note: nil)
    }

    /// Both images drawn into one known format — 8-bit RGBA over white — so
    /// the comparison is never actually comparing two colour spaces or two
    /// alpha conventions and calling the difference a regression.
    private static func raster(_ image: CGImage) throws -> [UInt8] {
        let w = image.width, h = image.height
        var bytes = [UInt8](repeating: 255, count: w * h * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = bytes.withUnsafeMutableBytes({ raw in
            CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                      bytesPerRow: w * 4, space: space, bitmapInfo: info)
        }) else {
            throw WebShotsError(message: "could not rasterise a \(w)×\(h) image for diffing")
        }
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = ctx.data else {
            throw WebShotsError(message: "rasteriser produced no pixels")
        }
        return [UInt8](UnsafeBufferPointer(
            start: data.assumingMemoryBound(to: UInt8.self), count: w * h * 4))
    }

    /// pixelmatch's YIQ colour delta.
    private static func delta(_ r1: UInt8, _ g1: UInt8, _ b1: UInt8,
                              _ r2: UInt8, _ g2: UInt8, _ b2: UInt8) -> Double {
        if r1 == r2 && g1 == g2 && b1 == b2 { return 0 }
        let r1d = Double(r1), g1d = Double(g1), b1d = Double(b1)
        let r2d = Double(r2), g2d = Double(g2), b2d = Double(b2)
        let y = (r1d - r2d) * 0.29889531 + (g1d - g2d) * 0.58662247 + (b1d - b2d) * 0.11448223
        let i = (r1d - r2d) * 0.59597799 - (g1d - g2d) * 0.27417610 - (b1d - b2d) * 0.32180189
        let q = (r1d - r2d) * 0.21147017 - (g1d - g2d) * 0.52261711 + (b1d - b2d) * 0.31114694
        return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
    }

    /// The captured page, faded, with every differing pixel in red — enough for
    /// a person to see *where* it moved, which is the only question a diff
    /// image is opened to answer.
    private static func diffImage(mask: [Bool], base: [UInt8], width w: Int, height h: Int) -> Data? {
        var out = [UInt8](repeating: 255, count: w * h * 4)
        for i in 0..<(w * h) {
            let o = i * 4
            if mask[i] {
                out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255
            } else {
                // Greyscale at low contrast: present enough to place the red,
                // faint enough that the red is what the eye lands on.
                // Broken into steps deliberately: as one expression, Swift's
                // type checker gives up on the literal/Double mix and fails the
                // build with "unable to type-check in reasonable time".
                let r = Double(base[o]) * 0.299
                let g = Double(base[o + 1]) * 0.587
                let b = Double(base[o + 2]) * 0.114
                let luma: Double = r + g + b
                let lifted: Double = 180.0 + luma * 0.075
                let grey = UInt8(min(255.0, lifted))
                out[o] = grey; out[o + 1] = grey; out[o + 2] = grey; out[o + 3] = 255
            }
        }
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        return out.withUnsafeMutableBytes { raw -> Data? in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                      bytesPerRow: w * 4, space: space, bitmapInfo: info),
                  let cg = ctx.makeImage() else { return nil }
            return UIImage(cgImage: cg).pngData()
        }
    }
}
