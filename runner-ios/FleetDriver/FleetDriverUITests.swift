import XCTest

/// FleetDriver: a UI test that never finishes on its own, and takes orders.
///
/// The fleet's explore workload needs to tap, swipe, type and press remote
/// buttons on Apple devices, and to screenshot and read the element tree of a
/// physical iPhone. Only one process on an Apple device is allowed to do all of
/// that: an XCUITest runner. So this test starts a small HTTP server inside the
/// runner and turns requests into XCUITest calls, until `/quit` or until nobody
/// has asked for anything in FLEET_DRIVER_IDLE_S seconds -- the second so a
/// driver whose Mac-side owner died does not hold the device forever.
///
/// It is the same idea as WebDriverAgent, cut down to what the explorer uses
/// and with no dependency to vet. The Mac side is
/// collector/src/workloads/explore/actuators/apple.ts, which builds this bundle,
/// starts it with `xcodebuild test-without-building`, and talks to it.
///
/// Environment (passed through xcodebuild with the TEST_RUNNER_ prefix, which
/// xcodebuild strips before the runner sees it):
///
///   FLEET_DRIVER=1          required; without it the test skips, so running
///                           the scheme's tests by hand does not hang a terminal
///   FLEET_DRIVER_PORT       default 8123
///   FLEET_DRIVER_IDLE_S     default 900
///   FLEET_DRIVER_TOKEN      optional; when set, every request must carry it in
///                           X-Fleet-Driver-Token
///
/// Built for iOS (FleetDriverUITests) and tvOS (FleetDriverUITestsTV) from this
/// one directory; the differences are `#if os(...)` in DriverCommands.swift.
final class FleetDriverUITests: XCTestCase {
    /// Issues XCUITest recorded while a command ran. XCUITest reports most of
    /// its failures -- "no element has keyboard focus", "failed to synthesize
    /// event" -- by recording a test issue rather than throwing, and by
    /// default the next thing it does is abort the test. For a driver that
    /// would mean one bad tap kills the session, so issues are collected here
    /// and returned as that command's error instead.
    private var captured: [String] = []
    private var capturing = false

    override func setUp() {
        super.setUp()
        // Without this, the first recorded issue raises inside XCTest and the
        // test -- and with it the server -- stops.
        continueAfterFailure = true
    }

    override func record(_ issue: XCTIssue) {
        if capturing {
            captured.append(issue.compactDescription)
            return
        }
        // Outside a command: something XCUITest noticed on its own, such as an
        // app it launched having crashed. Logged, and kept out of the test's
        // result, because a failed driver test would read in xcodebuild's
        // output as the driver having broken.
        print("FLEET-DRIVER-ISSUE \(issue.compactDescription)")
    }

    func testDrive() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["FLEET_DRIVER"] == "1" else {
            throw XCTSkip("FleetDriver runs only when FLEET_DRIVER=1 (TEST_RUNNER_FLEET_DRIVER=1 through xcodebuild)")
        }
        let port = UInt16(env["FLEET_DRIVER_PORT"] ?? "") ?? 8123
        let idleLimit = TimeInterval(env["FLEET_DRIVER_IDLE_S"] ?? "") ?? 900

        #if targetEnvironment(simulator)
        let loopbackOnly = true
        #else
        let loopbackOnly = false
        #endif
        let server = try DriverHTTPServer(port: port, loopbackOnly: loopbackOnly, token: env["FLEET_DRIVER_TOKEN"])
        let commands = DriverCommands()
        server.start()

        // Wait for the listener to say yes or no before claiming to be up. A
        // port already taken by another simulator's driver fails here, by name,
        // instead of looking like a driver that never answers.
        let startDeadline = Date().addingTimeInterval(10)
        while Date() < startDeadline {
            let st = server.state()
            if st.ready || st.failure != nil { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        let st = server.state()
        guard st.ready else {
            server.stop()
            XCTFail("FleetDriver could not listen on port \(port): \(st.failure ?? "timed out")")
            return
        }
        // The Mac side polls /health rather than reading this, but it is the
        // line to look for in an xcodebuild log when the driver did not answer.
        print("FLEET-DRIVER-READY port=\(port) loopbackOnly=\(loopbackOnly) idle=\(Int(idleLimit))s")

        var lastCommand = Date()
        while !commands.quitRequested {
            guard let job = server.next() else {
                if Date().timeIntervalSince(lastCommand) > idleLimit {
                    print("FLEET-DRIVER-IDLE no command for \(Int(idleLimit))s, stopping")
                    break
                }
                // Short enough that a command waits at most this long to
                // start; the run loop has to turn anyway for XCUITest's own
                // bookkeeping to happen between commands.
                RunLoop.current.run(until: Date().addingTimeInterval(0.01))
                continue
            }
            lastCommand = Date()
            job.respond(run(job.request, with: commands))
        }

        // Give the /quit response a moment to leave before the listener goes.
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        server.stop()
        print("FLEET-DRIVER-STOPPED")
    }

    /// One command, with XCUITest's recorded issues turned into its answer.
    private func run(_ req: DriverHTTPServer.Request, with commands: DriverCommands) -> DriverHTTPServer.Response {
        captured = []
        capturing = true
        defer { capturing = false }
        let started = Date()
        var resp: DriverHTTPServer.Response
        do {
            resp = try commands.handle(req)
        } catch let e as DriverError {
            resp = .error(e.description, status: e.status)
        } catch {
            resp = .error("\(error)", status: 500)
        }
        if !captured.isEmpty && resp.status == 200 {
            // XCUITest said no while the handler carried on: the tap did not
            // land, the text was not typed. 422 rather than 500, because the
            // driver is fine and the action was what could not be done.
            resp = .error("XCUITest: " + captured.joined(separator: " | "), status: 422)
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        if req.path != "/health" {
            print("FLEET-DRIVER \(req.method) \(req.path) -> \(resp.status) in \(ms) ms")
        }
        return resp
    }
}
