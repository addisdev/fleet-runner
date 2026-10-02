import XCTest

/// Generic fleet UI smoke: launches the app named by FLEET_APP_ID and asserts
/// each |-separated string in FLEET_ASSERTS is visible. The executor passes
/// both via xcodebuild's TEST_RUNNER_ env passthrough, so one test bundle
/// serves every iOS app in the fleet — the iOS counterpart of a Maestro flow.
///
/// With FLEET_A11Y_DUMP=1 it is also the a11y-audit's XCUITest tree source:
/// after launch it prints the app's `debugDescription` between the lines
/// FLEET-A11Y-DUMP-BEGIN and FLEET-A11Y-DUMP-END, which `xcuitestA11yTree` in
/// the executor cuts out of xcodebuild's output and hands to
/// parseXcuiDebugDescription. In that mode the asserts run only if the job
/// named some: the default "Fleet Runner" assert is about this app, and a dump
/// of somebody else's app should not fail for not containing it.
final class FleetSmokeUITests: XCTestCase {

    func testSmoke() throws {
        let env = ProcessInfo.processInfo.environment
        let appId = env["FLEET_APP_ID"] ?? "com.taylab.fleetrunner"
        let dump = env["FLEET_A11Y_DUMP"] == "1"
        let asserts = (env["FLEET_ASSERTS"] ?? (dump ? "" : "Fleet Runner"))
            .split(separator: "|").map(String.init).filter { !$0.isEmpty }

        let app = XCUIApplication(bundleIdentifier: appId)
        app.launch()

        if dump {
            // launch() returns once the app is idle, which is usually the
            // first screen drawn; a short wait more covers a splash that hands
            // over to the real screen. The dump is the launch screen only --
            // the executor's row says so.
            _ = app.wait(for: .runningForeground, timeout: 15)
            Thread.sleep(forTimeInterval: 2)
            // print() from the runner reaches xcodebuild's stdout, which is
            // where the executor reads it. One print, so another thread's
            // output cannot land between the markers.
            print("FLEET-A11Y-DUMP-BEGIN\n\(app.debugDescription)\nFLEET-A11Y-DUMP-END")
        }

        for text in asserts {
            // Match like Maestro does: labels, placeholders, titles — a text
            // field's placeholder is not a staticText.
            let predicate = NSPredicate(
                format: "label == %@ OR placeholderValue == %@ OR title == %@", text, text, text)
            let element = app.descendants(matching: .any).matching(predicate).firstMatch
            XCTAssertTrue(
                element.waitForExistence(timeout: 15),
                "\"\(text)\" not visible in \(appId)"
            )
        }
    }
}
