import SwiftUI

/// The dashboard's palette, in Swift.
///
/// These are the same hex values as `collector/dash/src/style.css`, light and
/// dark, copied rather than approximated — a phone on the shelf and the
/// collector in the browser are one product, and "close enough" green is how
/// two screens stop looking like one thing.
///
/// Every colour is a dynamic UIColor, so the app follows the system appearance
/// the way the dashboard follows `prefers-color-scheme`, with no theme setting
/// of its own to get out of step.
enum Fleet {

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }

    static let bg = dynamic(light: 0xF7F8FA, dark: 0x16181C)
    static let panel = dynamic(light: 0xFFFFFF, dark: 0x1C1F24)
    static let panel2 = dynamic(light: 0xF0F2F5, dark: 0x21252B)
    static let line = dynamic(light: 0xDDE1E7, dark: 0x31363E)
    static let ink = dynamic(light: 0x1C2025, dark: 0xE6E8EC)
    static let inkDim = dynamic(light: 0x7A828E, dark: 0x98A1AD)
    static let inkFaint = dynamic(light: 0x9AA2AE, dark: 0x767E89)
    static let accent = dynamic(light: 0x2F6FDB, dark: 0x6EA3FF)
    static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x10131A)
    static let ok = dynamic(light: 0x2E7D32, dark: 0x57B45C)
    static let warn = dynamic(light: 0x9A5B00, dark: 0xD5952F)
    static let bad = dynamic(light: 0xC62828, dark: 0xEF5D5D)
    /// The "fair" thermal step, which is neither ok nor warn — same value the
    /// dashboard uses for `.th-fair`.
    static let fair = dynamic(light: 0x9A8C20, dark: 0xCBB93C)

    /// The brand amber. Not a theme colour: it is the mark and the pulse and
    /// nothing else, so it is the one value that does not change with
    /// appearance. Interactive things stay `accent`, so the brand never reads
    /// as a button.
    static let pulse = Color(UIColor(hex: 0xE3A44A))
    /// The mark's tile, lifted on dark so the square does not sink into the
    /// panel behind it — the same two values `.glyph .tile` carries.
    static let tile = dynamic(light: 0x1C2025, dark: 0x2A2E35)

    /// The word a thermal state is drawn in.
    static func thermalColor(_ state: String) -> Color {
        switch state {
        case "nominal": return ok
        case "fair": return fair
        case "serious": return warn
        case "critical": return bad
        default: return inkFaint
        }
    }

    /// Battery colour follows the dashboard's thresholds exactly: below 15% and
    /// not charging is bad, below 30% is a warning, anything else is fine.
    static func batteryColor(pct: Int, charging: Bool) -> Color {
        if charging { return ok }
        if pct < 15 { return bad }
        if pct < 30 { return warn }
        return ok
    }

    // Panel geometry. The phone uses a larger radius than the dashboard's 8px
    // because a card that fills the width of a phone needs a corner you can
    // see; everything else — padding, gaps, the type ramp — is shared.
    static let cardRadius: CGFloat = 16
    static let tileRadius: CGFloat = 14
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
    }
}

/// The pulse from the mark, as a path that can be drawn.
///
/// One flat run, one spike, one flat run — the same shape as the glyph, the
/// README banner and the dashboard's favicon, so the thing that moves on the
/// runner's home screen is recognisably the product's own mark rather than a
/// generic loading squiggle.
struct PulseTrace: Shape {
    func path(in rect: CGRect) -> Path {
        // Authored against a 290×88 box and scaled, so the spike keeps its
        // proportions on any width.
        let sx = rect.width / 290, sy = rect.height / 88
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var path = Path()
        path.move(to: p(0, 44))
        path.addLine(to: p(92, 44))
        path.addLine(to: p(114, 14))
        path.addLine(to: p(148, 80))
        path.addLine(to: p(168, 44))
        path.addLine(to: p(290, 44))
        return path
    }
}

/// The under-24px form of the mark: the same drawing as the dashboard's
/// `Glyph` and `public/favicon.svg`, path for path.
///
/// Not a scaled-down `PulseTrace` — that one is drawn wide, and squeezed into a
/// 28pt square its spike becomes a blob. A mark this small is a different
/// drawing of the same idea, which is exactly why the web glyph is its own path
/// too.
struct GlyphPulse: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 16
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
        }
        var path = Path()
        path.move(to: p(3, 8.5))
        path.addLine(to: p(5.2, 8.5))
        path.addLine(to: p(6.6, 4.5))
        path.addLine(to: p(9.0, 12.5))
        path.addLine(to: p(10.5, 8.5))
        path.addLine(to: p(13, 8.5))
        return path
    }
}

/// The mark at header size: the pulse on its ink tile.
struct FleetGlyph: View {
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(Fleet.tile)
            GlyphPulse()
                .stroke(Fleet.pulse, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A panel: the phone's equivalent of the dashboard's `.panel`.
struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Fleet.cardRadius, style: .continuous).fill(Fleet.panel))
            .overlay(
                RoundedRectangle(cornerRadius: Fleet.cardRadius, style: .continuous)
                    .strokeBorder(Fleet.line, lineWidth: 1))
    }
}

/// The dashboard's panel heading, which on a phone labels a card.
struct CardLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .kerning(0.8)
            .foregroundStyle(Fleet.inkDim)
    }
}

/// The dashboard's pill, at phone size.
struct StatusPill: View {
    let text: String
    let color: Color
    var systemImage: String?

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 10, weight: .semibold)) }
            Text(text)
        }
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .overlay(Capsule().strokeBorder(color.opacity(0.4), lineWidth: 1))
    }
}
