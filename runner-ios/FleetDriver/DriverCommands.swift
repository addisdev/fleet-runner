import XCTest
#if canImport(UIKit)
import UIKit
#endif

/// What each endpoint does, as XCUITest calls.
///
/// Everything here runs on the main thread, one command at a time, from the
/// test's loop (see DriverHTTPServer for why not from GCD). A handler either
/// returns a response or throws a DriverError; XCUITest's own complaints --
/// which it records as test issues rather than throwing -- are caught by the
/// test case and turned into an error response there.
///
/// Coordinates are POINTS, from the top-left of the screen, always. The
/// actuator on the Mac converts from screenshot pixels; this side never sees a
/// pixel.
final class DriverCommands {
    /// The app most recently launched or activated. Typing goes to it, and a
    /// tree request that names no bundle reads it.
    private var current: XCUIApplication?
    /// One XCUIApplication per bundle id. Making a new one is cheap, but an
    /// instance carries its launch state, and `terminate()` on a fresh
    /// instance of an app this test launched works only by luck.
    private var apps: [String: XCUIApplication] = [:]
    /// Set by `/quit`; the test's loop exits once the response has gone.
    private(set) var quitRequested = false

    #if os(tvOS)
    static let platformName = "tvos"
    /// tvOS's home screen. Not a public constant anywhere; it is what
    /// `launchctl list` and every crash log on an Apple TV call it.
    static let homeScreenId = "com.apple.PineBoard"
    #else
    static let platformName = "ios"
    static let homeScreenId = "com.apple.springboard"
    #endif

    private func app(_ bundleId: String) -> XCUIApplication {
        if let a = apps[bundleId] { return a }
        let a = XCUIApplication(bundleIdentifier: bundleId)
        apps[bundleId] = a
        return a
    }

    private var homeScreen: XCUIApplication { app(Self.homeScreenId) }

    func handle(_ req: DriverHTTPServer.Request) throws -> DriverHTTPServer.Response {
        switch (req.method, req.path) {
        case ("GET", "/health"): return health()
        case ("POST", "/launch"): return try launch(req.json())
        case ("POST", "/activate"): return try activate(req.json())
        case ("POST", "/terminate"): return try terminate(req.json())
        case ("GET", "/screenshot"): return screenshot()
        case ("GET", "/tree"): return try tree(req.query)
        case ("GET", "/foreground"): return foreground(req.query)
        case ("POST", "/tap"): return try tap(req.json())
        case ("POST", "/long_press"): return try longPress(req.json())
        case ("POST", "/swipe"): return try swipe(req.json())
        case ("POST", "/type"): return try type(req.json())
        case ("POST", "/hide_keyboard"): return try hideKeyboard()
        case ("POST", "/press"): return try press(req.json())
        case ("POST", "/quit"):
            quitRequested = true
            return .json(["ok": true])
        default:
            let known = ["/health", "/launch", "/activate", "/terminate", "/screenshot", "/tree",
                         "/foreground", "/tap", "/long_press", "/swipe", "/type", "/hide_keyboard",
                         "/press", "/quit"]
            if known.contains(req.path) {
                return .error("\(req.method) is not allowed on \(req.path)", status: 405)
            }
            return .error("no such endpoint: \(req.method) \(req.path)", status: 404)
        }
    }

    // MARK: - Device

    private func health() -> DriverHTTPServer.Response {
        #if canImport(UIKit)
        // The screen in points, from the HOME SCREEN's frame, not from UIScreen
        // in this process. The test runner is an app with no launch screen, so
        // iOS runs it in legacy compatibility mode and its UIScreen reports a
        // 320x480 iPhone 4 -- on an iPhone 16, which made every tap land at
        // 0.82 of where it was aimed until this was found. SpringBoard (and
        // PineBoard on a TV) is always running and always the full screen.
        // UIScreen is the fallback for the moment the home screen cannot be
        // asked, and its scale is reported only for the log: the Mac side
        // takes pixels-per-point from the screenshot itself.
        let home = homeScreen.frame
        let bounds = home.width > 0 && home.height > 0 ? home : UIScreen.main.bounds
        let scale = UIScreen.main.scale
        let os = UIDevice.current.systemVersion
        let model = UIDevice.current.model
        #else
        let bounds = CGRect.zero
        let scale: CGFloat = 1
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        let model = "unknown"
        #endif
        return .json([
            "ok": true,
            "platform": Self.platformName,
            "os": os,
            "model": model,
            "scale": Double(scale),
            "size": ["w": Double(bounds.width), "h": Double(bounds.height)],
            "current": currentId.map { $0 as Any } ?? NSNull(),
        ])
    }

    /// The bundle id `current` was made from, for /health and errors.
    private var currentId: String?

    private func launch(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        let id = try string(body, "bundleId")
        let a = app(id)
        a.launchArguments = (body["args"] as? [Any])?.map { "\($0)" } ?? []
        var env: [String: String] = [:]
        for (k, v) in (body["env"] as? [String: Any]) ?? [:] { env[k] = "\(v)" }
        a.launchEnvironment = env
        // launch() terminates a running copy first, which is what "launch"
        // should mean to an explorer that wants a known starting screen.
        a.launch()
        current = a
        currentId = id
        return .json(["ok": true, "state": stateName(a.state)])
    }

    private func activate(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        let id = try string(body, "bundleId")
        let a = app(id)
        a.activate()
        current = a
        currentId = id
        return .json(["ok": true, "state": stateName(a.state)])
    }

    private func terminate(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        let id = try string(body, "bundleId")
        let a = app(id)
        // terminate() on an app that is not running is recorded as a failure
        // by some Xcode versions; asking first keeps that out of the response.
        if a.state != .notRunning && a.state != .unknown { a.terminate() }
        if currentId == id { current = nil; currentId = nil }
        return .json(["ok": true])
    }

    private func screenshot() -> DriverHTTPServer.Response {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        return DriverHTTPServer.Response(status: 200, contentType: "image/png", body: png)
    }

    // MARK: - Looking

    /// The element tree of one app, from a snapshot.
    ///
    /// `snapshot()` asks the accessibility server for the whole subtree in one
    /// round trip and returns plain values -- hundreds of milliseconds on a
    /// busy screen. `debugDescription` builds the same tree and then formats
    /// it, and on a long list it takes seconds; it is only produced when the
    /// snapshot fails or the caller asks with `debug=1`, so the text parser on
    /// the Mac (parseXcuiDebugDescription) still has something to read.
    private func tree(_ query: [String: String]) throws -> DriverHTTPServer.Response {
        let a: XCUIApplication
        if let id = query["bundleId"], !id.isEmpty {
            a = app(id)
        } else if let c = current {
            a = c
        } else {
            a = homeScreen
        }
        var nodes: [[String: Any]] = []
        var snapshotError: String?
        do {
            let root = try a.snapshot()
            walk(root, depth: 0, into: &nodes)
        } catch {
            snapshotError = "\(error)"
        }
        var debug: Any = NSNull()
        if snapshotError != nil || query["debug"] == "1" {
            debug = a.debugDescription
        }
        if let err = snapshotError, debug is NSNull {
            throw DriverError.failed("snapshot failed: \(err)")
        }
        // The soft keyboard, asked separately. On iOS 26 the keyboard is drawn
        // by another process and is NOT in the app's snapshot -- a tree with a
        // search field focused and a keyboard covering half the screen had no
        // Keyboard node in it -- but XCUITest's own keyboards query still
        // finds it. tvOS's keyboard is a screen of the app's own, so the same
        // query answers there too.
        let keyboard = a.keyboards.firstMatch.exists
        return .json([
            "ok": true,
            "nodes": nodes,
            "keyboard": keyboard,
            "debugDescription": debug,
            "snapshotError": snapshotError.map { $0 as Any } ?? NSNull(),
        ])
    }

    private func walk(_ s: XCUIElementSnapshot, depth: Int, into out: inout [[String: Any]]) {
        let f = s.frame
        var focused = false
        #if os(tvOS)
        focused = s.hasFocus
        #endif
        out.append([
            "type": Self.typeName(s.elementType),
            "label": s.label,
            "identifier": s.identifier,
            "value": s.value.map { "\($0)" } ?? "",
            "placeholder": s.placeholderValue ?? "",
            "frame": ["x": Double(f.origin.x), "y": Double(f.origin.y),
                      "w": Double(f.size.width), "h": Double(f.size.height)],
            "enabled": s.isEnabled,
            // A snapshot carries no isHittable -- that is a live query per
            // element, and asking it of every node would cost more than the
            // snapshot itself. This is the cheap stand-in: the element has an
            // area and is enabled. It does not know about an overlay covering
            // the element, which is what isHittable would have caught.
            "hittable": s.isEnabled && f.width > 0 && f.height > 0,
            "focused": focused,
            "selected": s.isSelected,
            "depth": depth,
        ])
        for c in s.children { walk(c, depth: depth + 1, into: &out) }
    }

    /// Which of the named apps is in front.
    ///
    /// XCUITest cannot NAME the foreground app: there is no public "which app
    /// is active" call, only `state` on an app you already know the id of. So
    /// the caller lists the ones it cares about (the app under test, plus the
    /// home screen this always adds) and gets back whichever of those is
    /// `.runningForeground`, or null when none of them is -- which means
    /// "something else", not "nothing".
    private func foreground(_ query: [String: String]) -> DriverHTTPServer.Response {
        var ids = (query["bundleIds"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
        if !ids.contains(Self.homeScreenId) { ids.append(Self.homeScreenId) }
        for id in ids where app(id).state == .runningForeground {
            return .json(["ok": true, "bundleId": id, "checked": ids])
        }
        return .json(["ok": true, "bundleId": NSNull(), "checked": ids])
    }

    // MARK: - Touching (iOS only: an Apple TV has no touch screen)

    #if os(iOS)
    /// A screen point as an XCUICoordinate.
    ///
    /// Based on the home screen's origin rather than the app's: SpringBoard is
    /// always running and always covers the whole screen, so the same (x, y)
    /// means the same place whether the app under test is in front, a system
    /// alert is, or the explorer has wandered into another app entirely. It
    /// also means XCUITest waits for SpringBoard to be idle before the event
    /// rather than for the app, so an app that animates forever (a visualiser,
    /// a spinner that never stops) does not stall every tap for the idle
    /// timeout.
    private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        homeScreen.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: x, dy: y))
    }
    #endif

    private func tap(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        #if os(iOS)
        point(try number(body, "x"), try number(body, "y")).tap()
        return .json(["ok": true])
        #else
        throw DriverError.badRequest("\(Self.platformName) has no touch screen; use /press with a remote button")
        #endif
    }

    private func longPress(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        #if os(iOS)
        let ms = (try? number(body, "ms")) ?? 800
        point(try number(body, "x"), try number(body, "y")).press(forDuration: ms / 1000)
        return .json(["ok": true])
        #else
        throw DriverError.badRequest("\(Self.platformName) has no touch screen; use /press with a remote button")
        #endif
    }

    private func swipe(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        #if os(iOS)
        let x1 = try number(body, "x1"), y1 = try number(body, "y1")
        let x2 = try number(body, "x2"), y2 = try number(body, "y2")
        let ms = max(50, (try? number(body, "ms")) ?? 300)
        let dist = hypot(x2 - x1, y2 - y1)
        // The velocity is what makes a swipe a fling or a drag. Derived from
        // the requested duration so `ms` means what it says; the 0.05 s press
        // at the start is short enough not to read as a long-press.
        let velocity = XCUIGestureVelocity(rawValue: max(1, dist / (ms / 1000)))
        point(x1, y1).press(forDuration: 0.05, thenDragTo: point(x2, y2),
                            withVelocity: velocity, thenHoldForDuration: 0)
        return .json(["ok": true])
        #else
        throw DriverError.badRequest("\(Self.platformName) has no touch screen; use /press with a remote button")
        #endif
    }

    // MARK: - Typing

    /// Type into whatever has keyboard focus in the app.
    ///
    /// `clear: true` deletes what is there first, by sending one delete key per
    /// character of the focused field's current value. It is the dull way and
    /// it is the reliable one: select-all goes through an edit menu whose
    /// items, timing and very existence vary by OS version and field type. A
    /// field showing only its placeholder reports the placeholder as its
    /// value, so it gets a few deletes too many, which do nothing. When no
    /// focused element can be found the fallback is 64 deletes, and a longer
    /// value keeps its head -- said here because it is a real limit.
    private func type(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        let text = try string(body, "text", allowEmpty: true)
        let a: XCUIApplication
        if let id = body["bundleId"] as? String, !id.isEmpty { a = app(id) } else if let c = current { a = c } else {
            throw DriverError.badRequest("no app to type into: /launch or /activate one first, or pass bundleId")
        }
        var deletes = 0
        if (body["clear"] as? Bool) == true {
            let focused = a.descendants(matching: .any)
                .matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
            if focused.exists, let v = focused.value as? String {
                deletes = v.count
            } else {
                deletes = 64
            }
            if deletes > 0 {
                a.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: deletes))
            }
        }
        if !text.isEmpty { a.typeText(text) }
        return .json(["ok": true, "deleted": deletes])
    }

    /// Put the soft keyboard away.
    ///
    /// In order of how little each one does to the app: an iPad's own "Hide
    /// keyboard" key; a "Done" button on an input accessory toolbar; and last
    /// the keyboard's Return key. Return is last because in a form it can
    /// SUBMIT -- it is still better than tapping a "neutral" area, which on a
    /// screen the driver has not seen is wherever a button happens to be. On
    /// tvOS the keyboard is a screen of its own and Menu leaves it.
    private func hideKeyboard() throws -> DriverHTTPServer.Response {
        #if os(tvOS)
        XCUIRemote.shared.press(.menu)
        return .json(["ok": true, "how": "menu"])
        #else
        let a = current ?? homeScreen
        let kb = a.keyboards.firstMatch
        if !kb.exists { return .json(["ok": true, "how": "no keyboard"]) }
        let hide = kb.buttons["Hide keyboard"]
        if hide.exists { hide.tap(); return .json(["ok": true, "how": "hide key"]) }
        let done = a.toolbars.buttons["Done"]
        if done.exists && done.isHittable { done.tap(); return .json(["ok": true, "how": "toolbar Done"]) }
        for name in ["Return", "return", "Done", "done", "Go", "go", "Search", "search", "Next", "next"] {
            let key = kb.buttons[name]
            if key.exists { key.tap(); return .json(["ok": true, "how": "key \(name)"]) }
        }
        throw DriverError.failed("the keyboard has no hide, Done or Return key to press")
        #endif
    }

    // MARK: - Buttons

    private func press(_ body: [String: Any]) throws -> DriverHTTPServer.Response {
        let button = try string(body, "button")
        #if os(tvOS)
        let map: [String: XCUIRemote.Button] = [
            "up": .up, "down": .down, "left": .left, "right": .right,
            "select": .select, "menu": .menu, "home": .home, "play_pause": .playPause,
        ]
        guard let b = map[button] else {
            throw DriverError.badRequest(
                "tvOS has no remote button \"\(button)\"; it has \(map.keys.sorted().joined(separator: ", "))")
        }
        XCUIRemote.shared.press(b)
        return .json(["ok": true])
        #else
        if button == "home" {
            XCUIDevice.shared.press(.home)
            return .json(["ok": true])
        }
        throw DriverError.badRequest(
            "iOS has no \"\(button)\" button the driver can press; the only one is home " +
            "(directions, select and menu exist on a TV remote, not a phone)")
        #endif
    }

    // MARK: - Helpers

    private func string(_ body: [String: Any], _ key: String, allowEmpty: Bool = false) throws -> String {
        guard let s = body[key] as? String, allowEmpty || !s.isEmpty else {
            throw DriverError.badRequest("\"\(key)\" (a string) is required")
        }
        return s
    }

    private func number(_ body: [String: Any], _ key: String) throws -> Double {
        if let n = body[key] as? NSNumber { return n.doubleValue }
        throw DriverError.badRequest("\"\(key)\" (a number) is required")
    }

    private func stateName(_ s: XCUIApplication.State) -> String {
        switch s {
        case .unknown: return "unknown"
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "backgroundSuspended"
        case .runningBackground: return "background"
        case .runningForeground: return "foreground"
        @unknown default: return "unknown"
        }
    }

    /// XCUIElement.ElementType as the name debugDescription prints for it.
    ///
    /// The enum is an Objective-C integer enum, so `String(describing:)` gives
    /// "XCUIElementType(rawValue: 9)" -- useless to a model and to the
    /// a11y checks, which match on these names. The names are the ones the
    /// text dump uses, so a node reads the same whichever path produced it.
    static func typeName(_ t: XCUIElement.ElementType) -> String {
        switch t {
        case .any: return "Any"
        case .other: return "Other"
        case .application: return "Application"
        case .group: return "Group"
        case .window: return "Window"
        case .sheet: return "Sheet"
        case .drawer: return "Drawer"
        case .alert: return "Alert"
        case .dialog: return "Dialog"
        case .button: return "Button"
        case .radioButton: return "RadioButton"
        case .radioGroup: return "RadioGroup"
        case .checkBox: return "CheckBox"
        case .disclosureTriangle: return "DisclosureTriangle"
        case .popUpButton: return "PopUpButton"
        case .comboBox: return "ComboBox"
        case .menuButton: return "MenuButton"
        case .toolbarButton: return "ToolbarButton"
        case .popover: return "Popover"
        case .keyboard: return "Keyboard"
        case .key: return "Key"
        case .navigationBar: return "NavigationBar"
        case .tabBar: return "TabBar"
        case .tabGroup: return "TabGroup"
        case .toolbar: return "Toolbar"
        case .statusBar: return "StatusBar"
        case .table: return "Table"
        case .tableRow: return "TableRow"
        case .tableColumn: return "TableColumn"
        case .outline: return "Outline"
        case .outlineRow: return "OutlineRow"
        case .browser: return "Browser"
        case .collectionView: return "CollectionView"
        case .slider: return "Slider"
        case .pageIndicator: return "PageIndicator"
        case .progressIndicator: return "ProgressIndicator"
        case .activityIndicator: return "ActivityIndicator"
        case .segmentedControl: return "SegmentedControl"
        case .picker: return "Picker"
        case .pickerWheel: return "PickerWheel"
        case .switch: return "Switch"
        case .toggle: return "Toggle"
        case .link: return "Link"
        case .image: return "Image"
        case .icon: return "Icon"
        case .searchField: return "SearchField"
        case .scrollView: return "ScrollView"
        case .scrollBar: return "ScrollBar"
        case .staticText: return "StaticText"
        case .textField: return "TextField"
        case .secureTextField: return "SecureTextField"
        case .datePicker: return "DatePicker"
        case .textView: return "TextView"
        case .menu: return "Menu"
        case .menuItem: return "MenuItem"
        case .menuBar: return "MenuBar"
        case .menuBarItem: return "MenuBarItem"
        case .map: return "Map"
        case .webView: return "WebView"
        case .incrementArrow: return "IncrementArrow"
        case .decrementArrow: return "DecrementArrow"
        case .timeline: return "Timeline"
        case .ratingIndicator: return "RatingIndicator"
        case .valueIndicator: return "ValueIndicator"
        case .splitGroup: return "SplitGroup"
        case .splitter: return "Splitter"
        case .relevanceIndicator: return "RelevanceIndicator"
        case .colorWell: return "ColorWell"
        case .helpTag: return "HelpTag"
        case .matte: return "Matte"
        case .dockItem: return "DockItem"
        case .ruler: return "Ruler"
        case .rulerMarker: return "RulerMarker"
        case .grid: return "Grid"
        case .levelIndicator: return "LevelIndicator"
        case .cell: return "Cell"
        case .layoutArea: return "LayoutArea"
        case .layoutItem: return "LayoutItem"
        case .handle: return "Handle"
        case .stepper: return "Stepper"
        case .tab: return "Tab"
        case .touchBar: return "TouchBar"
        case .statusItem: return "StatusItem"
        @unknown default: return "Other"
        }
    }
}
