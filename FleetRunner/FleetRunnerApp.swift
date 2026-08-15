import SwiftUI

@main
struct FleetRunnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var agent = FleetAgent()
    @AppStorage("base_url") private var baseUrl = "http://127.0.0.1:8788"
    @AppStorage("device_id") private var deviceId = Self.defaultDeviceId()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Fleet Runner").font(.title.bold())
            TextField("Collector URL", text: $baseUrl)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)
            TextField("Device ID", text: $deviceId)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
            HStack {
                Button("Start agent") { start() }
                    .buttonStyle(.borderedProminent)
                Button("Stop") { agent.stop() }
                    .buttonStyle(.bordered)
            }
            Text(agent.status).font(.callout).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .onAppear {
            // Headless start for simctl / the host executor:
            //   simctl launch booted com.taylab.fleetrunner -autostart 1
            if UserDefaults.standard.bool(forKey: "autostart") { start() }
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
