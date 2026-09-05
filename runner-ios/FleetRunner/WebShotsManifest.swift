import Foundation

/// The shots manifest and the naming rules around it, kept free of UIKit and
/// WebKit so every judgement this workload makes can be checked without a
/// device: parsing, validation, the profile name, thresholds and URL joining.
/// `WebShotsWorkload.swift` holds everything that needs a screen.
///
/// The shape mirrors `collector/web-specs/<site>/shots.json` exactly — the same
/// file the host executor reads in `runWebShots` — rather than a device-only
/// dialect of it. A device job is handed those same bytes as an artifact
/// (`params.input_sha256`) or inline (`params.shots`), so one manifest can
/// drive the host matrix and the phone half of it without being rewritten, and
/// a page added to the suite reaches both.
///
/// Note the manifest's own key casing is mixed — `waitFor` and `fullPage` are
/// camelCase, `settle_ms` and `threshold_pct` are snake_case — which is what
/// Playwright's option names did to it. `FleetJSON.decoder`'s
/// `.convertFromSnakeCase` handles both: a key with no underscore is passed
/// through untouched.

struct ShotsManifest: Codable {
    /// The profiles the host matrix captures under. A device job ignores this:
    /// its profile is its own screen (see `WebShots.profile`), and there is
    /// exactly one of them.
    var profiles: [String]?
    var thresholdPct: Double?
    var freezeTime: String?
    var pages: [ShotPage]?
}

struct ShotPage: Codable {
    var name: String?
    var path: String?
    var waitFor: String?
    var mask: [String]?
    var fullPage: Bool?
    var thresholdPct: Double?
    var settleMs: Int?
}

/// A problem with the job or the manifest, phrased for the `error` field of a
/// result row — which is the only place anyone will read it.
struct WebShotsError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum WebShots {

    // MARK: - the profile name

    /// The profile every capture from this runner is filed under.
    ///
    /// **This says `webkit`, not `safari`, and that is not a typo.**
    ///
    /// What captures here is a `WKWebView` embedded in the runner app. It is
    /// the same WebKit engine Safari renders with, which is the whole reason
    /// this workload is worth having — but it is not Safari. Safari applies
    /// reader-mode heuristics, runs the user's content blockers, ships its own
    /// chrome (which is in frame in the `ios-sim:` profile's `simctl`
    /// screenshots and is not in frame here), and treats a few viewport-meta
    /// edge cases differently from an embedded web view. A baseline matrix
    /// column labelled `safari` would be read as "this is what a person sees
    /// in Safari on this phone", and this capture cannot support that claim.
    /// `webkit` says exactly what it is: WebKit rendered these pixels.
    ///
    /// If you are reading this because the name looked wrong next to
    /// `ios-sim-safari`: those two profiles genuinely are different things, and
    /// renaming this one to match would make the matrix agree with itself by
    /// making it wrong.
    ///
    /// The device id is part of the name for the same reason the host's
    /// profiles are `android:<serial>` and `ios-sim:<name>`: baselines are
    /// keyed `(suite, page, profile)` and pixels differ per screen, so two
    /// phones are two baselines. Collapsing them under a bare `webkit` would
    /// diff a 6.1" screen against a 6.7" one and call the hardware difference
    /// a regression — and, worse, whichever phone ran last would silently
    /// redefine the truth for the other.
    static let profilePrefix = "webkit"

    static func profile(deviceId: String) -> String {
        let id = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? profilePrefix : "\(profilePrefix):\(id)"
    }

    // MARK: - manifest

    /// How long to sit on a loaded page before the shutter, when the manifest
    /// does not say.
    ///
    /// Deliberately not the 4 s the host's simulator path uses. That path
    /// drives Safari with `simctl openurl` and gets no load event at all, so
    /// its `settle_ms` is a blind wait standing in for one. Here the navigation
    /// really has finished and `document.fonts.ready` really has resolved
    /// before this starts, so this is only covering late layout — and four
    /// seconds a page, times a matrix, is a lease.
    static let defaultSettleMs = 1000

    /// Threshold the host applies when neither the page nor the manifest names
    /// one, kept identical so the same manifest judges the same way on both.
    static let defaultThresholdPct = 0.1

    /// A full-page capture is the whole scroll height, but a runaway page (an
    /// infinite feed, a broken 100vh × N layout) would otherwise ask the device
    /// for a bitmap it cannot allocate — and a job that dies of memory reports
    /// nothing at all. Past this the capture is the first `maxFullPageHeight`
    /// points and the row says so, which is a diffable baseline plus a visible
    /// caveat rather than silence.
    static let maxFullPageHeight: CGFloat = 8000

    static func decodeManifest(_ data: Data) throws -> ShotsManifest {
        do {
            return try FleetJSON.decoder.decode(ShotsManifest.self, from: data)
        } catch {
            throw WebShotsError(message: "shots manifest is not readable JSON: \(error.localizedDescription)")
        }
    }

    /// The manifest's pages, validated the way the host validates them.
    ///
    /// Checked here — before a web view is built — rather than discovered as a
    /// half-captured matrix when a file path fails to write. Page names become
    /// artifact names and baseline keys, so a name that cannot be one is a
    /// job-level error, not a page-level one.
    static func pages(of manifest: ShotsManifest) throws -> [ShotPage] {
        let pages = manifest.pages ?? []
        if pages.isEmpty { throw WebShotsError(message: "shots manifest lists no pages") }
        for p in pages {
            guard let name = p.name, isUsableName(name) else {
                throw WebShotsError(
                    message: "shots.json page name unusable as a filename: \(p.name.map { "\"\($0)\"" } ?? "null")")
            }
            guard let path = p.path, !path.isEmpty else {
                throw WebShotsError(message: "shots.json page '\(name)' has no path")
            }
        }
        let names = pages.compactMap(\.name)
        if Set(names).count != names.count {
            throw WebShotsError(message: "shots.json page names must be unique — they name the artifacts")
        }
        return pages
    }

    /// Same rule as the host's `/^[a-z0-9][a-z0-9_-]*$/i`.
    static func isUsableName(_ name: String) -> Bool {
        name.range(of: "^[a-z0-9][a-z0-9_-]*$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func threshold(for page: ShotPage, in manifest: ShotsManifest) -> Double {
        page.thresholdPct ?? manifest.thresholdPct ?? defaultThresholdPct
    }

    static func settleMs(for page: ShotPage) -> Int {
        max(page.settleMs ?? defaultSettleMs, 0)
    }

    /// A page's path resolved against the job's `targets.url`, the same join
    /// the host does with `new URL(p.path, url)`: an absolute path replaces the
    /// base's path, a relative one hangs off it, and an absolute URL wins
    /// outright.
    static func pageURL(base: String, path: String) -> URL? {
        guard let baseURL = URL(string: base) else { return nil }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    /// A Swift string as a JavaScript literal, for the selectors and CSS this
    /// workload injects. Built by the JSON encoder rather than by hand because
    /// a page name or selector carrying a quote, a backslash or a line
    /// separator would otherwise stop being data and start being code.
    static func jsLiteral(_ s: String) -> String {
        guard let data = try? JSONEncoder().encode(s),
              let literal = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        // U+2028/U+2029 are legal in JSON strings and are line terminators in
        // JavaScript source, so JSON-encoding alone is not enough here.
        return literal
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    // MARK: - determinism

    /// Mirrors the `KILL_MOTION_CSS` the host injects on its android path and
    /// the `_shots` spec injects on its browser path. Same three properties,
    /// because a caret blinking in a captured input is a 100%-reproducible way
    /// to fail a diff at random.
    static let killMotionCSS =
        "*, *::before, *::after { animation: none !important; transition: none !important; " +
        "caret-color: transparent !important; }"

    /// CSS that stands in for Playwright's `mask` option: the masked box is
    /// painted flat and everything inside it is hidden, so a clock or an avatar
    /// cannot fail a diff for being what it is.
    ///
    /// Not pixel-identical to Playwright's overlay, and it does not need to be
    /// — a baseline is per profile, and nothing ever diffs these pixels against
    /// a Playwright-captured column.
    static func maskCSS(_ selectors: [String]) -> String {
        selectors.map { sel in
            "\(sel) { background: #FF00FF !important; color: transparent !important; " +
            "box-shadow: none !important; border-color: #FF00FF !important; }\n" +
            "\(sel) * { visibility: hidden !important; }"
        }.joined(separator: "\n")
    }

    /// A script that pins `Date` to a fixed instant, for manifests that set
    /// `freeze_time` (the host gets this from Playwright's clock API).
    ///
    /// Injected at document start so a page that stamps a render time reads the
    /// frozen clock rather than the real one. Returns nil when the manifest's
    /// string is not a date this runner can parse — a silently unfrozen clock
    /// would produce a page that fails its diff once a minute, so the caller
    /// turns nil into a visible job error instead.
    static func freezeTimeScript(_ iso: String) -> String? {
        guard let date = isoDate(iso) else { return nil }
        let ms = Int64((date.timeIntervalSince1970 * 1000).rounded())
        return """
        (function () {
          var fixed = \(ms);
          var Real = Date;
          function Frozen(...args) {
            if (!(this instanceof Frozen)) return new Real(fixed).toString();
            return args.length === 0 ? new Real(fixed) : new Real(...args);
          }
          Frozen.prototype = Real.prototype;
          Frozen.now = function () { return fixed; };
          Frozen.parse = Real.parse;
          Frozen.UTC = Real.UTC;
          window.Date = Frozen;
        })();
        """
    }

    /// `freeze_time` as the manifest writes it. Both spellings the host's
    /// `new Date(...)` accepts for an ISO-8601 string: with and without
    /// fractional seconds.
    static func isoDate(_ s: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }
}
