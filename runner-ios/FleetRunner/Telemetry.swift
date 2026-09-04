import Foundation
import UIKit

enum Telemetry {

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
            os: "ios-\(UIDevice.current.systemVersion)",
            appVer: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        )
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
