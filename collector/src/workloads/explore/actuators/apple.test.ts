/**
 * The Apple actuator's decisions, without an Apple device.
 *
 * Nothing here starts xcodebuild or talks to a FleetDriver. What is pinned is
 * everything that turns one unit into another or one name into another --
 * pixels and points, a tree and a focus line, a devicectl JSON blob and a URL,
 * a contract Key and a remote button -- because those are the parts that can
 * be wrong in a way a simulator run would not show (a 3x phone and a 2x TV
 * disagree about scale; a device route that has never carried a request).
 */
import type { A11yNode } from "../../../a11y-tree.js";
import { ALL_KEYS } from "../types.js";
import {
  FOREGROUND_OTHER, buildDestinationFor, capsFor, destinationFor, dpadPressesForScroll, driverTestFor,
  focusLine, keyboardShown, logStartArg, nodesFromDriver, pixelsPerPoint, pngSize, pressButtonFor,
  pxToPt, scrollSwipe, sourceHash, tunnelAddressFromDevicectl, urlHost, type DriverNode,
} from "./apple.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

/** A PNG header (signature + IHDR) for a w x h image; enough for pngSize. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const dn = (over: Partial<DriverNode>): DriverNode => ({
  type: "Other", label: "", identifier: "", value: "",
  frame: { x: 0, y: 0, w: 10, h: 10 },
  enabled: true, hittable: true, focused: false, selected: false, depth: 0, ...over,
});

const node = (over: Partial<A11yNode>): A11yNode => ({
  cls: "Other", text: "", label: "", id: "", value: "", tappable: false, enabled: true,
  bounds: { x: 0, y: 0, w: 10, h: 10 }, depth: 0, ...over,
});

export async function runAppleActuatorChecks(check: Check): Promise<void> {
  // --- destinations and schemes -------------------------------------------
  check("apple: an iOS simulator is an iOS Simulator destination",
    destinationFor({ id: "AB-12", platform: "ios", kind: "simulator" }) === "platform=iOS Simulator,id=AB-12");
  check("apple: a tvOS simulator is a tvOS Simulator destination",
    destinationFor({ id: "TV-1", platform: "tvos", kind: "simulator" }) === "platform=tvOS Simulator,id=TV-1");
  check("apple: an iPhone is a plain iOS destination",
    destinationFor({ id: "00008130-001", platform: "ios", kind: "device" }) === "platform=iOS,id=00008130-001");
  check("apple: an Apple TV is a plain tvOS destination",
    destinationFor({ id: "00008110-0A", platform: "tvos", kind: "device" }) === "platform=tvOS,id=00008110-0A");
  check("apple: a target with no kind is treated as a device, not guessed a simulator",
    destinationFor({ id: "X", platform: "ios" }) === "platform=iOS,id=X");
  check("apple: builds are generic so one serves every simulator",
    buildDestinationFor({ platform: "tvos", kind: "simulator" }) === "generic/platform=tvOS Simulator");
  check("apple: tvOS runs its own driver target",
    driverTestFor({ platform: "tvos" }).onlyTesting === "FleetDriverUITestsTV/FleetDriverUITests/testDrive" &&
      driverTestFor({ platform: "tvos" }).scheme === "FleetDriverTV");
  check("apple: iOS runs the iOS driver target",
    driverTestFor({ platform: "ios" }).onlyTesting === "FleetDriverUITests/FleetDriverUITests/testDrive");

  // --- caps and keys ------------------------------------------------------
  const phone = capsFor({ platform: "ios" });
  const tv = capsFor({ platform: "tvos" });
  check("apple: a phone is touch with home only", phone.surface === "touch" && phone.keys.join() === "home");
  check("apple: a TV is a D-pad", tv.surface === "dpad" && ["up", "down", "left", "right", "select", "back", "menu", "home", "play_pause"]
    .every((k) => tv.keys.includes(k as never)));
  // Every key the caps offer must map to a button, and every key they do not
  // offer must be refused -- otherwise the loop offers the model a tool that
  // throws, or the actuator quietly does something with a key nobody offered.
  for (const [platform, caps] of [["ios", phone], ["tvos", tv]] as const) {
    const offered = ALL_KEYS.filter((k) => caps.keys.includes(k));
    const mapped = ALL_KEYS.filter((k) => "button" in pressButtonFor(k, platform));
    check(`apple: ${platform} caps and the button map agree`, offered.join() === mapped.join(),
      `offered ${offered.join()} / mapped ${mapped.join()}`);
  }
  check("apple: back on tvOS is Menu", JSON.stringify(pressButtonFor("back", "tvos")) === '{"button":"menu"}');
  check("apple: play_pause keeps its driver name", JSON.stringify(pressButtonFor("play_pause", "tvos")) === '{"button":"play_pause"}');
  const iosBack = pressButtonFor("back", "ios");
  check("apple: back on iOS is refused with a reason", "error" in iosBack && /home/.test(iosBack.error));
  const tvSearch = pressButtonFor("search", "tvos");
  check("apple: a key the remote lacks is refused by name", "error" in tvSearch && tvSearch.error.includes('"search"'));

  // --- pixels and points --------------------------------------------------
  check("apple: PNG size from the header", JSON.stringify(pngSize(pngHeader(1179, 2556))) === '{"width":1179,"height":2556}');
  let notPng = "";
  try { pngSize(Buffer.from("GIF89a-------------------------")); } catch (e) { notPng = (e as Error).message; }
  check("apple: a non-PNG is an error, not a 0x0 screen", notPng.startsWith("not a PNG"), notPng);
  check("apple: a 3x phone", pixelsPerPoint({ width: 1179, height: 2556 }, { w: 393, h: 852 }) === 3);
  check("apple: a 2x Apple TV 4K", pixelsPerPoint({ width: 3840, height: 2160 }, { w: 1920, h: 1080 }) === 2);
  check("apple: a landscape capture of a portrait-reported phone still scales by 3",
    pixelsPerPoint({ width: 2556, height: 1179 }, { w: 393, h: 852 }) === 3);
  let zero = "";
  try { pixelsPerPoint({ width: 10, height: 10 }, { w: 0, h: 0 }); } catch (e) { zero = (e as Error).message; }
  check("apple: a 0x0 screen from the driver is an error", zero.includes("0x0"), zero);
  check("apple: pixels to points", pxToPt(600, 3) === 200 && pxToPt(100, 3) === 33.3);

  // --- the tree -----------------------------------------------------------
  const nodes = nodesFromDriver([
    dn({ type: "Application", label: "Settings", frame: { x: 0, y: 0, w: 393, h: 852 } }),
    dn({ type: "Button", label: "General", identifier: "com.apple.settings.general", frame: { x: 16, y: 100, w: 361, h: 44 }, depth: 1 }),
    dn({ type: "StaticText", label: "General", frame: { x: 60, y: 110, w: 80, h: 22 }, depth: 2 }),
    dn({ type: "Table", frame: { x: 0, y: 0, w: 393, h: 852 }, depth: 1 }),
    dn({ type: "TextField", value: "hello", enabled: false, depth: 1 }),
  ], 3);
  check("apple: frames are scaled from points to pixels",
    JSON.stringify(nodes[1].bounds) === '{"x":48,"y":300,"w":1083,"h":132}', JSON.stringify(nodes[1].bounds));
  check("apple: a Button is tappable, a StaticText is not", nodes[1].tappable && !nodes[2].tappable);
  check("apple: identifier and label land where the a11y parser puts them",
    nodes[1].id === "com.apple.settings.general" && nodes[1].label === "General");
  check("apple: value is the text, as in the debugDescription parse", nodes[4].text === "hello" && nodes[4].value === "hello");
  check("apple: disabled stays disabled", nodes[4].enabled === false);
  check("apple: a table scrolls", nodes[3].scrollable === true && nodes[1].scrollable === undefined);
  check("apple: unfocused nodes carry no focused field", nodes.every((n) => n.focused === undefined));

  // --- focus --------------------------------------------------------------
  const tvTree: A11yNode[] = [
    node({ cls: "Application", label: "Dozehound", depth: 0 }),
    node({ cls: "Window", depth: 1 }),
    node({ cls: "Other", label: "Sounds", depth: 2 }),
    node({ cls: "CollectionView", depth: 3 }),
    node({ cls: "Cell", label: "Rain on the porch", depth: 4, focused: true }),
    node({ cls: "StaticText", label: "Rain on the porch", depth: 5 }),
    node({ cls: "Other", label: "Settings", depth: 2 }),
  ];
  check("apple: focus line names the cell behind its labelled containers",
    focusLine(tvTree) === "Dozehound > Sounds > Cell 'Rain on the porch' (focused)", String(focusLine(tvTree)));
  const nested = tvTree.map((n) => (n.cls === "CollectionView" ? { ...n, label: "Row 2", focused: true } : n));
  check("apple: the deepest focused node wins over a focused container",
    focusLine(nested) === "Dozehound > Sounds > Row 2 > Cell 'Rain on the porch' (focused)", String(focusLine(nested)));
  check("apple: a tree with no focus says so in words",
    focusLine(tvTree.map((n) => ({ ...n, focused: false }))) === "(nothing reports focus)");
  check("apple: no tree, no focus line", focusLine(null) === null && focusLine([]) === null);
  const unnamed = [node({ cls: "Application", label: "TV", depth: 0 }), node({ cls: "Button", depth: 1, focused: true })];
  check("apple: an unlabelled focused element is named by its type", focusLine(unnamed) === "TV > Button (focused)");
  const sameName = [node({ cls: "Other", label: "Play", depth: 0 }), node({ cls: "Button", label: "Play", depth: 1, focused: true })];
  check("apple: a container named like its focused child is said once", focusLine(sameName) === "Button 'Play' (focused)",
    String(focusLine(sameName)));

  // --- keyboard -----------------------------------------------------------
  check("apple: a Keyboard element means a keyboard",
    keyboardShown([node({ cls: "Keyboard", bounds: { x: 0, y: 500, w: 393, h: 300 } })]) === true);
  check("apple: a zero-sized Keyboard is a keyboard on its way out",
    keyboardShown([node({ cls: "Keyboard", bounds: { x: 0, y: 852, w: 0, h: 0 } })]) === false);
  check("apple: no tree, no keyboard answer", keyboardShown(null) === null);

  // --- scroll -------------------------------------------------------------
  const down = scrollSwipe("down", 0.5, { w: 400, h: 800 });
  check("apple: scroll down moves the finger up across the middle",
    down.y1 === 600 && down.y2 === 200 && down.x1 === 200 && down.x2 === 200, JSON.stringify(down));
  const right = scrollSwipe("right", 0.5, { w: 400, h: 800 });
  check("apple: scroll right moves the finger left", right.x1 > right.x2 && right.y1 === right.y2);
  const huge = scrollSwipe("up", 5, { w: 400, h: 800 });
  check("apple: a scroll never starts at the edge, where the system takes the swipe",
    huge.y1 >= 80 && huge.y2 <= 720, JSON.stringify(huge));
  check("apple: D-pad scroll is presses", dpadPressesForScroll(undefined) === 2 && dpadPressesForScroll(0.01) === 1 &&
    dpadPressesForScroll(10) === 8);

  // --- the device route ---------------------------------------------------
  const details = {
    info: { outcome: "success" },
    result: {
      connectionProperties: {
        tunnelIPAddress: "fd7a:115c:a1e0::1a2b",
        tunnelState: "connected",
        transportType: "wired",
      },
      deviceProperties: { name: "iPhone" },
    },
  };
  check("apple: tunnel address from devicectl's documented shape",
    tunnelAddressFromDevicectl(details) === "fd7a:115c:a1e0::1a2b");
  check("apple: tunnel address found if the key moves",
    tunnelAddressFromDevicectl({ result: { device: { connection: { tunnelIPAddress: "fdab::2" } } } }) === "fdab::2");
  check("apple: a disconnected device has no tunnel address",
    tunnelAddressFromDevicectl({ result: { connectionProperties: { tunnelState: "disconnected" } } }) === null);
  check("apple: garbage in, null out", tunnelAddressFromDevicectl(null) === null && tunnelAddressFromDevicectl("x") === null);
  check("apple: IPv6 is bracketed in a URL", urlHost("fd7a:115c:a1e0::1a2b") === "[fd7a:115c:a1e0::1a2b]");
  check("apple: a zone id is percent-encoded", urlHost("fe80::1%utun4") === "[fe80::1%25utun4]");
  check("apple: IPv4 is left alone", urlHost("10.0.0.5") === "10.0.0.5");
  check("apple: the other-app marker is not a bundle id", !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(FOREGROUND_OTHER));

  // --- the build cache and the log window ---------------------------------
  const a = sourceHash([{ name: "a.swift", content: "x" }, { name: "b.swift", content: "y" }], "Xcode 27.0");
  const b = sourceHash([{ name: "b.swift", content: "y" }, { name: "a.swift", content: "x" }], "Xcode 27.0");
  const c = sourceHash([{ name: "a.swift", content: "x!" }, { name: "b.swift", content: "y" }], "Xcode 27.0");
  const d = sourceHash([{ name: "a.swift", content: "x" }, { name: "b.swift", content: "y" }], "Xcode 27.1");
  check("apple: source hash ignores file order", a === b);
  check("apple: an edited source rebuilds", a !== c);
  check("apple: a new Xcode rebuilds", a !== d);
  check("apple: log show start is local wall-clock time",
    logStartArg(new Date(2026, 9, 2, 7, 5, 9)) === "2026-10-02 07:05:09");
}
