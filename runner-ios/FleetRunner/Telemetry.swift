import Foundation
import Network
import UIKit

/// A long-lived `NWPathMonitor`, because there is no way to ask iOS "what is
/// carrying my traffic right now?" without one — the answer only arrives
/// through a monitor that has already been started.
///
/// Started once and kept, rather than spun up per request: a freshly started
/// monitor has no path yet, so a per-request one would report "unknown" for
/// exactly the first row of every vantage run.
private final class NetworkWatcher: @unchecked Sendable {
    static let shared = NetworkWatcher()
    private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { _ in }
        monitor.start(queue: DispatchQueue(label: "com.taylab.fleetrunner.network-watcher"))
    }

    /// wifi / cellular / ethernet / unknown, the same four words the Android
    /// runner reports.
    ///
    /// Wi-Fi is checked before cellular so a phone holding both answers the way
    /// its traffic will actually go, which is also how Android's transport
    /// check reads. "unknown" is a word, not a guess: it covers no active path,
    /// a transport neither platform names, and the moment before the monitor
    /// has heard anything.
    func current() -> String {
        let path = monitor.currentPath
        if path.usesInterfaceType(.wifi) { return "wifi" }
        if path.usesInterfaceType(.cellular) { return "cellular" }
        if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
        return "unknown"
    }
}

enum Telemetry {

    /// What is carrying this device's traffic right now.
    ///
    /// Read per request during a vantage run rather than once per job: a device
    /// can leave wifi mid-run, and the rows on either side of that are honestly
    /// different measurements.
    static func networkType() -> String { NetworkWatcher.shared.current() }


    static func descriptor() -> DeviceDescriptor {
        var uts = utsname()
        uname(&uts)
        let machine = withUnsafeBytes(of: &uts.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return DeviceDescriptor(
            model: machine,
            soc: machine,
            ramMb: Int64(ProcessInfo.processInfo.physicalMemory / (1024 * 1024)),
            os: "\(Self.platform)-\(UIDevice.current.systemVersion)",
            appVer: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            platform: Self.platform,
            kind: Self.formFactor()
        )
    }

    /// Which Apple platform this binary was built for.
    ///
    /// Compile-time, because that is what the question is about: the same
    /// source produces an iOS app, a tvOS app and a watchOS app, and the
    /// numbers they report are only comparable when the table can tell them
    /// apart. `os` is built from this too, so a tvOS runner reports
    /// `tvos-18.2` rather than calling itself iOS with a television's memory.
    ///
    /// visionOS is checked before iOS: a "Designed for iPad" build running on
    /// Vision Pro compiles under `os(iOS)` and would otherwise report itself
    /// as an iPhone with a very unusual amount of RAM.
    static var platform: String {
        #if os(visionOS)
        return "visionos"
        #elseif os(tvOS)
        return "tvos"
        #elseif os(watchOS)
        return "watchos"
        #elseif targetEnvironment(macCatalyst)
        return "catalyst"
        #else
        return "ios"
        #endif
    }

    /// The shape, from the interface idiom the OS hands us.
    ///
    /// `.pad` covers both a real iPad and a "Designed for iPad" build on a
    /// headset, so visionOS is answered from the compile-time platform first —
    /// the same ordering, and the same reason, as `platform` itself.
    static func formFactor() -> String {
        #if os(visionOS)
        return "headset"
        #elseif os(watchOS)
        return "watch"
        #elseif os(tvOS)
        return "tv"
        #elseif targetEnvironment(macCatalyst)
        return "desktop"
        #else
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: return "tablet"
        case .tv: return "tv"
        case .mac: return "desktop"
        case .vision: return "headset"
        default: return "phone"
        }
        #endif
    }

    /// Simulators report battery level -1; treat as 100 so constraints behave.
    static func batteryPct() -> Int {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = UIDevice.current.batteryLevel
        return level < 0 ? 100 : Int(level * 100)
    }

    static func isCharging() -> Bool {
        UIDevice.current.isBatteryMonitoringEnabled = true
        switch UIDevice.current.batteryState {
        case .charging, .full: return true
        default: return false
        }
    }

    /// Shared thermal enum: nominal / fair / serious / critical.
    static func thermal() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "critical"
        }
    }

    /// phys_footprint in MB — labeled "phys_footprint" in results, never
    /// compared to Android PSS.
    static func physFootprintMb() -> Int64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        return Int64(info.phys_footprint) / (1024 * 1024)
    }

    static func beacon() -> BeaconSample {
        BeaconSample(batteryPct: batteryPct(), charging: isCharging(), thermal: thermal())
    }
}
