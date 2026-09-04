import XCTest

/// Generic fleet UI smoke: launches the app named by FLEET_APP_ID and asserts
/// each |-separated string in FLEET_ASSERTS is visible. The executor passes
/// both via xcodebuild's TEST_RUNNER_ env passthrough, so one test bundle
/// serves every iOS app in the fleet — the iOS counterpart of a Maestro flow.
final class FleetSmokeUITests: XCTestCase {

    func testSmoke() throws {
        let env = ProcessInfo.processInfo.environment
        let appId = env["FLEET_APP_ID"] ?? "com.taylab.fleetrunner"
        let asserts = (env["FLEET_ASSERTS"] ?? "Fleet Runner")
            .split(separator: "|").map(String.init).filter { !$0.isEmpty }

        let app = XCUIApplication(bundleIdentifier: appId)
        app.launch()

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
