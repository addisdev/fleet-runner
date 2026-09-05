import SwiftUI

@main
struct FleetRunnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// The runner's one screen.
///
/// A fleet device spends its life face-down on a shelf, so this is read in two
/// situations and no others: while enrolling it, and while standing over it
/// wondering why it is not taking work. Both questions are answered above the
/// fold — what the agent is doing, which collector it is talking to, and
/// whether the battery or the heat is about to disqualify it from a job — and
/// the settings that only matter once are the fields underneath.
///
/// No fake status bar and no fake keyboard: iOS draws the real ones on top.
struct ContentView: View {
    @StateObject private var agent = FleetAgent()
    // Loopback by default: a simulator shares the Mac's network stack, so this
    // works out of the box there, and a real device is told its collector once,
    // in the field below, rather than having one baked into the binary.
    @AppStorage("base_url") private var baseUrl = "http://127.0.0.1:8788"
    @AppStorage("device_id") private var deviceId = Self.defaultDeviceId()

    var body: some View {
        ZStack {
            Fleet.bg.ignoresSafeArea()

            VStack(spacing: 12) {
                header
                ScrollView {
                    VStack(spacing: 12) {
                        hero
                        collector
                        tiles
                        jobCard
                    }
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
                controls
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 12)
        }
        .tint(Fleet.accent)
        .foregroundStyle(Fleet.ink)
        .onAppear {
            agent.sampleNow()
            // Headless start for simctl / the host executor:
            //   simctl launch booted com.taylab.fleetrunner -autostart 1
            if UserDefaults.standard.bool(forKey: "autostart") { start() }
        }
    }

    // MARK: - header

    private var header: some View {
        HStack(spacing: 10) {
            FleetGlyph()
            Text("Fleet Runner")
                .font(.system(size: 17, weight: .semibold))
            Spacer()
            LiveDot(phase: agent.phase)
        }
    }

    // MARK: - hero

    /// The status, at the size of the only question that matters, over the
    /// mark's own pulse. The trace draws while the agent is in contact with the
    /// collector and rests as a flat line when it is not — so "is this thing
    /// working" is answered before any word is read.
    private var hero: some View {
        Card {
            VStack(alignment: .leading, spacing: 0) {
                PulseLine(active: agent.phase.connected)
                    .frame(height: 72)
                    .padding(.bottom, 12)

                HStack(alignment: .firstTextBaseline) {
                    Text(agent.phase.headline)
                        .font(.system(size: 24, weight: .semibold))
                    Spacer(minLength: 12)
                    if let beat = agent.lastBeacon {
                        // When the collector last heard from this device, which
                        // is the number you want when you are standing over a
                        // phone the dashboard calls stale.
                        (Text(beat, style: .relative) + Text(" ago"))
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Fleet.inkFaint)
                            .lineLimit(1)
                    }
                }

                Text(subtitle)
                    .font(.system(size: 14))
                    .foregroundStyle(Fleet.inkDim)
                    .padding(.top, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The detail under the headline. In the failing case this is the actual
    /// error the agent reported, because "cannot reach the collector" without
    /// the reason is the half of the message that does not help.
    private var subtitle: String {
        switch agent.phase {
        case .stopped: return "Not registered. Start the agent to join the fleet."
        case .failing: return agent.status
        default: return "Registered as \(deviceId) in pool ml-capable"
        }
    }

    // MARK: - collector

    private var collector: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    CardLabel(text: "Collector")
                    TextField("Collector URL", text: $baseUrl)
                        .font(.system(size: 15, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)
                }
                Divider().overlay(Fleet.line)
                VStack(alignment: .leading, spacing: 4) {
                    CardLabel(text: "Device ID")
                    TextField("Device ID", text: $deviceId)
                        .font(.system(size: 15, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                }
            }
        }
    }

    // MARK: - telemetry

    /// The three readings that decide whether this device is allowed to take a
    /// job: charge, heat and what is carrying its traffic. These are the values
    /// from the last beacon, not fresh readings — the point is to show what the
    /// collector believes about this device.
    private var tiles: some View {
        HStack(alignment: .top, spacing: 10) {
            TelemetryTile(
                icon: "bolt.fill", label: "Battery",
                value: batteryText,
                tint: agent.telemetry.map { Fleet.batteryColor(pct: $0.batteryPct, charging: $0.charging) } ?? Fleet.inkFaint
            ) {
                if let t = agent.telemetry, t.batteryPct >= 0 {
                    Meter(fraction: Double(t.batteryPct) / 100,
                          tint: Fleet.batteryColor(pct: t.batteryPct, charging: t.charging))
                }
            }
            TelemetryTile(
                icon: "thermometer.medium", label: "Thermal",
                value: agent.telemetry?.thermal ?? "—",
                tint: Fleet.thermalColor(agent.telemetry?.thermal ?? "")
            ) {
                ThermalSteps(state: agent.telemetry?.thermal ?? "")
            }
            TelemetryTile(
                icon: "wifi", label: "Network",
                value: agent.network,
                tint: Fleet.ink
            ) {
                Text("60s beacon")
                    .font(.system(size: 11))
                    .foregroundStyle(Fleet.inkFaint)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var batteryText: String {
        guard let t = agent.telemetry else { return "—" }
        // A simulator reports -1 rather than a level; showing "-1%" would look
        // like a reading rather than the absence of one.
        return t.batteryPct < 0 ? "n/a" : "\(t.batteryPct)%"
    }

    // MARK: - job

    @ViewBuilder
    private var jobCard: some View {
        if let running = agent.runningJob {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        CardLabel(text: "Running")
                        Spacer()
                        StatusPill(text: "claimed", color: Fleet.warn)
                    }
                    JobLine(workload: running.workload, jobId: running.id)
                    HStack {
                        Text("started")
                        Text(running.since, style: .relative)
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(Fleet.inkDim)
                }
            }
        } else if let last = agent.lastJob {
            Card {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        CardLabel(text: "Last job")
                        Spacer()
                        // No verdict pill: the runner posts its own final row
                        // and never sees the outcome, so anything green here
                        // would be a guess. The dashboard has the verdict.
                        Text(last.at, style: .relative)
                            .font(.system(size: 12))
                            .foregroundStyle(Fleet.inkFaint)
                    }
                    JobLine(workload: last.workload, jobId: last.jobId)
                    Text("took \(formatted(last.elapsed))")
                        .font(.system(size: 12))
                        .foregroundStyle(Fleet.inkDim)
                }
            }
        }
    }

    private func formatted(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }

    // MARK: - controls

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button { agent.stop() } label: {
                    Text("Stop")
                        .font(.system(size: 16, weight: .medium))
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .foregroundStyle(Fleet.ink)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Fleet.panel))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Fleet.line, lineWidth: 1))
                .disabled(agent.phase == .stopped)
                .opacity(agent.phase == .stopped ? 0.45 : 1)

                Button { start() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: agent.phase == .stopped ? "play.fill" : "iphone.gen3")
                        Text(agent.phase == .stopped ? "Start agent" : "Agent running")
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .foregroundStyle(Fleet.onAccent)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Fleet.accent))
            }
            Text("Keeps running with the screen off. Plug in to stay in the pool.")
                .font(.system(size: 12))
                .foregroundStyle(Fleet.inkFaint)
                .multilineTextAlignment(.center)
        }
    }

    private func start() {
        guard let url = URL(string: baseUrl) else { return }
        agent.start(baseURL: url, deviceId: deviceId)
    }

    private static func defaultDeviceId() -> String {
        let suffix = (UIDevice.current.identifierForVendor?.uuidString ?? "0000").suffix(4)
        #if targetEnvironment(simulator)
        return "iphone-sim-\(suffix.lowercased())"
        #else
        return "iphone-\(suffix.lowercased())"
        #endif
    }
}

// MARK: - pieces

/// The header's connection indicator, the same three states and the same
/// colours as the dashboard's live dot — and, like it, only animated while
/// connecting. A dot that pulses forever stops being read.
private struct LiveDot: View {
    let phase: FleetAgent.Phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    private var color: Color {
        switch phase {
        case .polling, .running: return Fleet.ok
        case .stopped: return Fleet.inkFaint
        case .failing: return Fleet.bad
        default: return Fleet.warn
        }
    }

    private var label: String {
        switch phase {
        case .polling, .running: return "live"
        case .stopped: return "stopped"
        case .failing: return "offline"
        default: return "connecting"
        }
    }

    private var pulsing: Bool {
        if reduceMotion { return false }
        switch phase {
        case .starting, .registering: return true
        default: return false
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .opacity(pulsing && dim ? 0.25 : 1)
                // `nil` rather than `.default` off the pulsing path: an implicit
                // animation left armed here also animates the pill's layout when
                // the label changes width ("connecting" → "live"), which slides
                // the dot across its own text on the way.
                .animation(
                    pulsing ? .easeInOut(duration: 0.6).repeatForever(autoreverses: true) : nil,
                    value: dim)
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Fleet.inkDim)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(Fleet.panel))
        .overlay(Capsule().strokeBorder(Fleet.line, lineWidth: 1))
        .onAppear { dim = true }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Collector connection: \(label)")
    }
}

/// The mark's pulse, drawn left to right while the agent is in contact.
///
/// The resting state is the whole trace in the panel's line colour with the
/// amber sitting still on top of it, so with Reduce Motion on — or with the
/// agent stopped — this is a flat, complete drawing rather than an empty box.
private struct PulseLine: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep: CGFloat = 0

    private var animating: Bool { active && !reduceMotion }

    var body: some View {
        ZStack {
            PulseTrace()
                .stroke(Fleet.line, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            PulseTrace()
                .trim(from: 0, to: animating ? sweep : 1)
                .stroke(
                    active ? Fleet.pulse : Fleet.inkFaint,
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
        }
        .onAppear { restart() }
        .onChange(of: animating) { _, _ in restart() }
        .accessibilityHidden(true)
    }

    private func restart() {
        guard animating else {
            sweep = 1
            return
        }
        sweep = 0
        withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: false)) { sweep = 1 }
    }
}

/// One telemetry reading: icon, label, value, and whatever shows its level.
private struct TelemetryTile<Footer: View>: View {
    let icon: String
    let label: String
    let value: String
    let tint: Color
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11, weight: .medium))
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .kerning(0.6)
            }
            .foregroundStyle(Fleet.inkDim)

            Text(value)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            // The footer's row is reserved whether or not there is one to draw:
            // a tile with no meter must still be the same height as its
            // neighbours, and an absent view has no height to give it.
            ZStack(alignment: .leading) {
                Color.clear.frame(height: 12)
                footer
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: Fleet.tileRadius, style: .continuous).fill(Fleet.panel))
        .overlay(
            RoundedRectangle(cornerRadius: Fleet.tileRadius, style: .continuous)
                .strokeBorder(Fleet.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

private struct Meter: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Fleet.panel2)
                Capsule().fill(tint)
                    .frame(width: max(2, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 3)
    }
}

/// Thermal as four steps rather than one word's colour: `serious` is three
/// steps lit, which reads as "most of the way to trouble" at a glance.
private struct ThermalSteps: View {
    let state: String

    private var lit: Int {
        switch state {
        case "nominal": return 1
        case "fair": return 2
        case "serious": return 3
        case "critical": return 4
        default: return 0
        }
    }

    private let colors: [Color] = [Fleet.ok, Fleet.fair, Fleet.warn, Fleet.bad]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(i < lit ? colors[i] : Fleet.panel2)
                    .frame(height: 3)
            }
        }
    }
}

/// A workload and the job it belongs to, on one line — the workload named in
/// words, the id in mono because it is what you paste into a query.
private struct JobLine: View {
    let workload: String
    let jobId: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "circle.dashed")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Fleet.inkDim)
            Text(workload).font(.system(size: 15, weight: .medium))
            Text(jobId)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Fleet.inkDim)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
