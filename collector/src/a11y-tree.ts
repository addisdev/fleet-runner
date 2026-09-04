/**
 * Reading an accessibility tree out of whatever the platform will print, and
 * judging it.
 *
 * A sibling of xcparse.ts and am-start.ts, and pure for the same reason: the
 * executor is a long-running process with a main() loop and cannot be imported,
 * so a parser only reachable from inside it is only ever tested by plugging in
 * a phone. Everything an a11y-audit stores comes out of these functions, so
 * they are the ones that have to be checkable without hardware.
 *
 * Three sources, because no two platforms will print the same thing:
 *
 *   uiautomator dump      -- Android's own XML. Bounds in PIXELS.
 *   maestro hierarchy     -- Maestro's normalised JSON, Android and iOS
 *                            simulators alike. Bounds in pixels or points
 *                            depending on which driver produced them, so the
 *                            caller says which.
 *   XCUIApplication.debugDescription -- the element subtree an XCUITest helper
 *                            prints. Frames are already in POINTS.
 *
 * The judging is deliberately small and deliberately honest. Two checks:
 *
 *   unlabelled tappables  -- an error. A control a screen reader announces as
 *                            "button" and nothing else is unusable, and it is
 *                            the single most common real defect.
 *   small touch targets   -- a warning, and ONLY where the tree gives bounds AND
 *                            the caller can say what a bound means. An Android
 *                            tree measures in pixels; comparing 40 pixels to 44
 *                            points calls every control on a 3x phone a failure
 *                            and every control on a 1x phone a pass. Without a
 *                            density the check does not run, and the run says so
 *                            rather than reporting a number it cannot support.
 */

import type { Finding } from "./web/shared.js";

/** One element, whatever printed it. */
export type A11yNode = {
  /** Widget class or XCUIElement type, verbatim. */
  cls: string;
  /** Visible text, if the tree distinguishes it from the label. */
  text: string;
  /** What a screen reader would announce: content-desc, accessibilityText, label. */
  label: string;
  /** A programmatic id -- resource-id, accessibility identifier. NOT announced. */
  id: string;
  /** Current value, which some controls use instead of a label. */
  value: string;
  tappable: boolean;
  enabled: boolean;
  /** In the tree's own units; see A11yGeometry. */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** Depth in the subtree, for naming a finding usefully. */
  depth: number;
};

/**
 * What one unit of `bounds` means.
 *
 * "unknown" is a first-class answer, not a failure mode: it is what an Android
 * tree is until somebody reads the device's density, and the size check is
 * skipped rather than guessed.
 */
export type A11yGeometry =
  | { unit: "points" }
  | { unit: "pixels"; densityDpi: number }
  | { unit: "unknown" };

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

const unescapeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** `[0,0][1080,2400]` -> a rect, or null for anything else. */
export function parseBoundsRect(s: string | undefined): A11yNode["bounds"] {
  if (!s) return null;
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------------
// uiautomator dump
// ---------------------------------------------------------------------------

/**
 * Android's own hierarchy XML.
 *
 * `uiautomator dump` writes the XML to the device and prints only a receipt --
 * "UI hierchary dumped to: /sdcard/window_dump.xml", misspelled in AOSP since
 * 2012 -- so the text handed to this function is whatever the caller cat'ed
 * back. Feeding it the receipt by mistake is a realistic error, and it produces
 * zero nodes rather than a parse failure, which would then read as a screen with
 * nothing wrong on it. That is what `problem` is for.
 */
export function parseUiautomatorDump(xml: string): { nodes: A11yNode[]; problem: string | null } {
  const text = xml.replace(/\r/g, "");
  if (text.trim() === "") return { nodes: [], problem: "uiautomator printed nothing" };
  // The receipt, or the failure it prints instead of one.
  if (!/<hierarchy\b/.test(text)) {
    return {
      nodes: [],
      problem: `no <hierarchy> in the dump (${text.trim().split("\n")[0].slice(0, 140)})`,
    };
  }

  const nodes: A11yNode[] = [];
  let depth = 0;
  // Walk the tags in order so nesting depth is tracked without building a tree:
  // depth is only ever used to name a finding, and a tree would be a second
  // representation to keep correct.
  for (const m of text.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
    if (m[0] === "</node>") { depth = Math.max(0, depth - 1); continue; }
    const a = attrs(m[1]);
    nodes.push({
      cls: a["class"] ?? "",
      text: unescapeXml(a["text"] ?? ""),
      label: unescapeXml(a["content-desc"] ?? ""),
      id: a["resource-id"] ?? "",
      value: "",
      // long-clickable alone is not a tap target; checkable controls are.
      tappable: a["clickable"] === "true" || a["checkable"] === "true",
      enabled: a["enabled"] !== "false",
      bounds: parseBoundsRect(a["bounds"]),
      depth,
    });
    if (m[2] !== "/") depth += 1;
  }
  if (nodes.length === 0) return { nodes, problem: "the dump has a <hierarchy> but no nodes" };
  return { nodes, problem: null };
}

// ---------------------------------------------------------------------------
// maestro hierarchy
// ---------------------------------------------------------------------------

type MaestroNode = { attributes?: Record<string, unknown>; children?: MaestroNode[] };

/**
 * Maestro's normalised JSON tree.
 *
 * Maestro prints a banner before the JSON on some versions, so the object is
 * located rather than assumed to start at character zero -- the same defence
 * runWebProject already applies to Playwright's JSON reporter.
 *
 * `accessibilityText` is Maestro's name for the announced label on both
 * platforms; on iOS it carries the accessibility label, on Android the
 * content-desc. `hintText` deliberately does NOT count as a label: a text field
 * whose only description is its placeholder announces nothing once it has
 * content in it.
 */
export function parseMaestroHierarchy(out: string): { nodes: A11yNode[]; problem: string | null } {
  const text = out.replace(/\r/g, "");
  const start = text.indexOf("{");
  if (start < 0) {
    return {
      nodes: [],
      problem: text.trim() === ""
        ? "maestro hierarchy printed nothing"
        : `maestro hierarchy printed no JSON (${text.trim().split("\n")[0].slice(0, 140)})`,
    };
  }
  let root: MaestroNode;
  try {
    root = JSON.parse(text.slice(start)) as MaestroNode;
  } catch (e) {
    return { nodes: [], problem: `maestro hierarchy is not JSON: ${(e as Error).message.slice(0, 120)}` };
  }

  const nodes: A11yNode[] = [];
  const str = (a: Record<string, unknown>, k: string): string => {
    const v = a[k];
    return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  };
  const walk = (n: MaestroNode, depth: number) => {
    const a = n.attributes ?? {};
    // A node with no attributes at all is a container Maestro emits for
    // structure; it is not an element and must not be judged as one.
    if (Object.keys(a).length > 0) {
      nodes.push({
        cls: str(a, "class") || str(a, "elementType") || "",
        text: str(a, "text"),
        label: str(a, "accessibilityText") || str(a, "label") || str(a, "title"),
        id: str(a, "resource-id") || str(a, "resourceId") || str(a, "accessibilityIdentifier"),
        value: str(a, "value"),
        tappable: str(a, "clickable") === "true" || str(a, "checkable") === "true" ||
          isTappableType(str(a, "elementType") || str(a, "class")),
        enabled: str(a, "enabled") !== "false",
        bounds: parseBoundsRect(str(a, "bounds")) ?? rectFromNumbers(a),
        depth,
      });
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  if (nodes.length === 0) return { nodes, problem: "maestro hierarchy has no elements" };
  return { nodes, problem: null };
}

/** Maestro's iOS driver sometimes gives x/y/width/height as numbers instead of a bounds string. */
function rectFromNumbers(a: Record<string, unknown>): A11yNode["bounds"] {
  const n = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : Number(a[k]));
  const [x, y, w, h] = ["x", "y", "width", "height"].map(n);
  if ([x, y, w, h].some((v) => !Number.isFinite(v))) return null;
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// XCUIApplication.debugDescription
// ---------------------------------------------------------------------------

/** XCUIElement types a person is expected to tap. Everything else is chrome. */
const TAPPABLE_IOS = new Set([
  "button", "cell", "link", "menuitem", "tab", "tabbar", "switch", "toggle",
  "slider", "stepper", "segmentedcontrol", "textfield", "securetextfield",
  "searchfield", "textview", "checkbox", "radiobutton", "popupbutton",
  "datepicker", "picker", "pickerwheel", "icon", "image",
]);

function isTappableType(t: string): boolean {
  return TAPPABLE_IOS.has(t.replace(/^XCUIElementType/, "").toLowerCase());
}

/**
 * The element subtree XCUITest prints for an application.
 *
 * The shape, one element per line, indentation carrying the nesting:
 *
 *     →Application, 0x600001, {{0.0, 0.0}, {390.0, 844.0}}, label: 'Aliquant'
 *        Window (Main), 0x600002, {{0.0, 0.0}, {390.0, 844.0}}
 *          Button, 0x600004, {{16.0, 100.0}, {40.0, 40.0}}, label: 'Close'
 *          Button, 0x600006, {{16.0, 200.0}, {30.0, 30.0}}
 *
 * Frames are in POINTS, which is the whole reason this source is worth having:
 * it is the only one of the three where a 44 in the tree and a 44 in the
 * guideline are the same 44.
 *
 * The `, Disabled` suffix and the `(Main)` qualifier after a type are both
 * ordinary, and both broke the obvious "split on comma, field 0 is the type"
 * parse -- a window came out as type "Window (Main)" and a disabled button's
 * label was read as the string "Disabled".
 */
export function parseXcuiDebugDescription(out: string): { nodes: A11yNode[]; problem: string | null } {
  const text = out.replace(/\r/g, "");
  if (text.trim() === "") return { nodes: [], problem: "the XCUITest helper printed nothing" };

  const nodes: A11yNode[] = [];
  let indents: number[] = [];
  for (const raw of text.split("\n")) {
    // The subtree's arrow marks the queried element; it is part of the
    // indentation, not of the type name.
    const line = raw.replace(/→/g, " ");
    const m = /^(\s*)([A-Z][A-Za-z]*)(?:\s+\([^)]*\))?,\s*0x[0-9a-f]+,\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const cls = m[2];
    const rest = m[3];

    // {{x, y}, {w, h}} -- floats, and the frame may be absent on some elements.
    const f = /\{\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\},\s*\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}\}/.exec(rest);
    const quoted = (key: string): string =>
      new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(rest)?.[1]?.replace(/\\'/g, "'") ?? "";

    // Depth from indentation, without assuming a fixed step: Xcode's is two
    // spaces at the top and three deeper in, which a divide-by-two read as a
    // tree that alternately deepened and flattened.
    while (indents.length > 0 && indent <= indents[indents.length - 1]) indents.pop();
    indents.push(indent);
    const depth = indents.length - 1;

    nodes.push({
      cls,
      text: quoted("value"),
      label: quoted("label"),
      id: quoted("identifier"),
      value: quoted("value"),
      tappable: isTappableType(cls),
      enabled: !/,\s*Disabled\b/.test(rest),
      bounds: f ? { x: Number(f[1]), y: Number(f[2]), w: Number(f[3]), h: Number(f[4]) } : null,
      depth,
    });
  }
  indents = [];
  if (nodes.length === 0) {
    return { nodes, problem: `no elements in the XCUITest dump (${text.trim().split("\n")[0].slice(0, 140)})` };
  }
  return { nodes, problem: null };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** How a node reads in a finding, when it has no label to name it by. */
function nameOf(n: A11yNode): string {
  const cls = n.cls.replace(/^XCUIElementType/, "").split(".").pop() || "element";
  const where = n.bounds ? ` at ${n.bounds.x},${n.bounds.y} (${n.bounds.w}x${n.bounds.h})` : "";
  const id = n.id ? ` id=${n.id.split("/").pop()}` : "";
  return `${cls}${id}${where}`;
}

export type A11yCheckOptions = {
  /** Where these findings were observed, e.g. "home" or "checkout". */
  step: string;
  /** The minimum touch target, in points. 44 is Apple's; Android's own is 48dp. */
  minTargetPt?: number;
  /** Cap per check, so one pathological screen cannot fill a report. */
  cap?: number;
};

/**
 * Judge one tree.
 *
 * Severity follows the fleet's red-means-something rule, the same one
 * web-audit states: `error` fails the run, `warn` is recorded and does not.
 * An unlabelled control is an error because it is unusable and unambiguous; a
 * small touch target is a warning because the measurement is a heuristic --
 * a 30x30 icon inside a 48x48 padded row is a real pattern and reads as a
 * violation here.
 *
 * The size check is skipped entirely, with a finding saying so, when the
 * geometry is unknown. That is the point of the function taking geometry at
 * all: an Android tree is in pixels, and 40 pixels on a 3x phone is 13 points.
 * Reporting that as a violation, or converting it with an assumed density,
 * would produce a number that means nothing on the device it came from.
 */
export function a11yFindings(
  nodes: A11yNode[],
  geometry: A11yGeometry,
  opts: A11yCheckOptions,
): Finding[] {
  const minPt = opts.minTargetPt ?? 44;
  const cap = opts.cap ?? 25;
  const found: Finding[] = [];

  const toPoints = (px: number): number | null => {
    if (geometry.unit === "points") return px;
    if (geometry.unit === "pixels") {
      if (!Number.isFinite(geometry.densityDpi) || geometry.densityDpi <= 0) return null;
      return (px * 160) / geometry.densityDpi;
    }
    return null;
  };

  let unlabelled = 0;
  let tiny = 0;
  let sized = 0;
  const seen = new Set<string>();

  for (const n of nodes) {
    if (!n.tappable || !n.enabled) continue;
    // A zero-area node is not on screen; judging it produces findings nobody
    // can act on, because there is nothing there to look at.
    if (n.bounds && (n.bounds.w <= 0 || n.bounds.h <= 0)) continue;

    const announced = [n.label, n.text, n.value].some((s) => s.trim() !== "");
    if (!announced) {
      unlabelled++;
      const key = `unlabelled:${nameOf(n)}`;
      if (!seen.has(key) && found.filter((f) => f.check === "a11y-label").length < cap) {
        seen.add(key);
        found.push({
          severity: "error",
          check: "a11y-label",
          page: opts.step,
          // Say what a screen reader gets, because "add a label" is only
          // actionable once you know the id it is missing from.
          detail: `${nameOf(n)} is tappable but announces nothing (no label, text or value)`,
        });
      }
    }

    if (n.bounds) {
      const w = toPoints(n.bounds.w);
      const h = toPoints(n.bounds.h);
      if (w !== null && h !== null) {
        sized++;
        // Both dimensions have to be short. A 320x30 row is a perfectly
        // reachable target; a 30x30 icon is the one worth flagging.
        if (w < minPt && h < minPt) {
          tiny++;
          const key = `tiny:${nameOf(n)}`;
          if (!seen.has(key) && found.filter((f) => f.check === "a11y-target-size").length < cap) {
            seen.add(key);
            found.push({
              severity: "warn",
              check: "a11y-target-size",
              page: opts.step,
              detail: `${n.label || n.text || nameOf(n)} is ${w.toFixed(0)}x${h.toFixed(0)}pt, under the ${minPt}pt minimum`,
            });
          }
        }
      }
    }
  }

  if (sized === 0 && nodes.some((n) => n.tappable && n.bounds)) {
    // Not a silent skip. A run that judged no sizes and said nothing is
    // indistinguishable from one where every target was big enough.
    found.push({
      severity: "warn",
      check: "a11y-coverage",
      page: opts.step,
      detail: geometry.unit === "unknown"
        ? "touch-target sizes were not judged: the tree's bounds are in an unknown unit " +
          "(an Android dump is in pixels, and converting needs the device's density)"
        : "touch-target sizes were not judged: no element carried usable bounds",
    });
  }

  if (unlabelled > cap) {
    found.push({
      severity: "warn",
      check: "a11y-coverage",
      page: opts.step,
      detail: `${unlabelled} unlabelled tappables on this screen; the first ${cap} are listed`,
    });
  }
  if (tiny > cap) {
    found.push({
      severity: "warn",
      check: "a11y-coverage",
      page: opts.step,
      detail: `${tiny} undersized targets on this screen; the first ${cap} are listed`,
    });
  }
  return found;
}

/** `Physical density: 420` / `420` out of `wm density` or `getprop`. */
export function parseAndroidDensity(out: string): number | null {
  const text = out.replace(/\r/g, "");
  // `Override density:` wins when present -- it is what is actually in effect,
  // and a device with a display-size override set (an accessibility setting in
  // its own right) reports both.
  const override = /Override density:\s*(\d+)/.exec(text);
  const physical = /Physical density:\s*(\d+)/.exec(text);
  const bare = /^\s*(\d{2,4})\s*$/m.exec(text);
  const v = Number((override ?? physical ?? bare)?.[1] ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}
