/**
 * Checks for every pure parser the device workloads depend on -- app-soak's
 * dumpsys/logcat readers, a11y-audit's three tree parsers, locale-shots' tag
 * vocabulary, and the device-settings read-back parsers -- against captured
 * tool output.
 *
 * `npx tsx src/device-parsers.test.ts` -- no collector, no phone, no simulator.
 *
 * These live in a module rather than inside scripts/smoke.ts (where the
 * collector's other pure-function checks sit, alongside `evalMatch`,
 * `parseAmStart` and `parseNetworkProfile`) only because that file was not mine
 * to edit in this change. `runDeviceParserChecks` takes the same
 * `check(name, cond, detail)` shape smoke.ts uses, so it folds in there with one
 * import and one call.
 *
 * The samples below are real shapes:
 * `dumpsys` from an Android 14 Pixel and from an older column-format build,
 * `logcat -b crash` carrying somebody else's crash alongside ours, a
 * uiautomator dump that is only the receipt, a `simctl ui` usage message where
 * a value should be, and CRLF throughout -- because adb's shell transport
 * converts every LF and every one of these parsers is anchored.
 *
 * The through-line: each parser must answer "I have no measurement" distinctly
 * from "the measurement is zero". 0 MB, 0% jank, 0 crashes and 0 findings are
 * all plausible-looking values for a tool that printed a warning nobody read,
 * and a green app-soak that sampled nothing is the worst result this workload
 * can produce.
 */
import { parseMeminfo, parseGfxinfo, parseCrashLogcat, parseSimCrashLog } from "./soak-samples.js";
import {
  a11yFindings, parseAndroidDensity, parseMaestroHierarchy, parseUiautomatorDump,
  parseXcuiDebugDescription,
} from "./a11y-tree.js";
import { appleLocaleOf, coversRtl, parseLocaleList, parseLocaleTag } from "./locale.js";
import {
  parseAndroidSettingValue, parseDefaultsArray, parseDefaultsString, parseSimctlUiValue,
  parseUiModeNight, unmanageableReason,
} from "./device-state.js";
import { parseSdkLevel, parseVariantList, planVariant } from "./display-settings.js";
import { contactSheetHtml } from "./contact-sheet.js";
import { pathToFileURL } from "node:url";

type Check = (name: string, cond: boolean, detail?: string) => void;

/** adb's shell transport hands everything back with CRLF; so does this. */
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

// --- captured samples -------------------------------------------------------

const MEMINFO_PIXEL = `Applications Memory Usage (in Kilobytes):
Uptime: 84032891 Realtime: 84032891

** MEMINFO in pid 8123 [com.taylab.aliquant] **
                   Pss  Private  Private  SwapPss      Rss     Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty    Total     Size    Alloc     Free
                ------   ------   ------   ------   ------   ------   ------   ------
  Native Heap    24560    24500        0      112    26880    40960    31220     9740
  Dalvik Heap    18204    18100        0       48    20480    24576    16332     8244

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:    18204                          20480
         Native Heap:    24560                          26880
                Code:     9812                          41220
               Stack:      620                            640
            Graphics:     6144                           6144
       Private Other:     3120
              System:    11540
             Unknown:                                    9008

               TOTAL:    73200                        104372       TOTAL SWAP PSS:      160
`;

/** An older build with no App Summary block at all; the column table is the only source. */
const MEMINFO_LEGACY = `** MEMINFO in pid 4242 [com.taylab.aliquant] **
                   Pss  Private  Private  SwapPss      Rss
                 Total    Dirty    Clean    Dirty    Total
                ------   ------   ------   ------   ------
  Native Heap    41200    41100        0      900    52100
            TOTAL    93052    91392      132     1528   129892
`;

const MEMINFO_GONE = `Applications Memory Usage (in Kilobytes):
Uptime: 84033012 Realtime: 84033012

No process found for: com.taylab.aliquant
`;

const GFXINFO = `Applications Graphics Acceleration Info:
Uptime: 84033012 Realtime: 84033012

** Graphics info for pid 8123 [com.taylab.aliquant] **

Stats since: 84021455018884ns
Total frames rendered: 1842
Janky frames: 93 (5.05%)
Janky frames (legacy): 61 (3.31%)
50th percentile: 7ms
90th percentile: 14ms
95th percentile: 21ms
99th percentile: 63ms
Number Missed Vsync: 4
`;

const GFXINFO_IDLE = `** Graphics info for pid 8123 [com.taylab.aliquant] **

Stats since: 1802331ns
Total frames rendered: 0
Janky frames: 0 (0.00%)
`;

const CRASH_JAVA = `--------- beginning of crash
09-04 02:14:07.881  8123  8123 E AndroidRuntime: FATAL EXCEPTION: main
09-04 02:14:07.881  8123  8123 E AndroidRuntime: Process: com.taylab.aliquant, PID: 8123
09-04 02:14:07.881  8123  8123 E AndroidRuntime: java.lang.IllegalStateException: cursor is closed
09-04 02:14:07.881  8123  8123 E AndroidRuntime: \tat com.taylab.aliquant.Sync.run(Sync.java:88)
09-04 03:41:22.104  9001  9001 E AndroidRuntime: FATAL EXCEPTION: main
09-04 03:41:22.104  9001  9001 E AndroidRuntime: Process: com.android.launcher3, PID: 9001
09-04 03:41:22.104  9001  9001 E AndroidRuntime: java.lang.NullPointerException: not ours
`;

const CRASH_NATIVE = `--------- beginning of crash
09-04 04:02:11.700  9412  9412 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** ***
09-04 04:02:11.700  9412  9412 F DEBUG   : Build fingerprint: 'google/panther:14/UQ1A/1:user/release-keys'
09-04 04:02:11.701  9412  9412 F DEBUG   : pid: 8123, tid: 8140, name: RenderThread  >>> com.taylab.aliquant <<<
09-04 04:02:11.701  9412  9412 F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
`;

const SIM_CRASH = `Filtering the log data using "process == \\"ReportCrash\\""
Timestamp                       Thread     Type        Activity             PID    TTL
2026-09-04 02:14:07.881233+0100 0x1a2b3    Default     0x0                  4711   0    ReportCrash: (CrashReporterSupport) Saved crash report for Aliquant[8123] version 3.1 (410) to Aliquant_2026-09-04-021407_sim.ips
`;

const SIM_CRASH_OTHER = `Timestamp                       Thread     Type        Activity             PID    TTL
2026-09-04 02:19:41.100011+0100 0x1a2b7    Default     0x0                  4711   0    ReportCrash: (CrashReporterSupport) Saved crash report for Photos[9002] version 1.0 (1) to Photos_2026-09-04-021941_sim.ips
`;

const UIAUTOMATOR = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.taylab.aliquant" content-desc="" checkable="false" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="0" text="Save" resource-id="com.taylab.aliquant:id/save" class="android.widget.Button" package="com.taylab.aliquant" content-desc="" checkable="false" clickable="true" enabled="true" bounds="[40,1200][320,1332]" />
<node index="1" text="" resource-id="com.taylab.aliquant:id/close" class="android.widget.ImageButton" package="com.taylab.aliquant" content-desc="" checkable="false" clickable="true" enabled="true" bounds="[960,80][1050,170]" />
<node index="2" text="" resource-id="com.taylab.aliquant:id/help" class="android.widget.ImageButton" package="com.taylab.aliquant" content-desc="Help" checkable="false" clickable="true" enabled="true" bounds="[900,2280][960,2340]" />
</node>
</hierarchy>
`;

/** What uiautomator prints on stdout -- the misspelling is AOSP's, not ours. */
const UIAUTOMATOR_RECEIPT = "UI hierchary dumped to: /sdcard/window_dump.xml\n";

const MAESTRO_TREE = `Running on 8A2C6F11-3D50-4B2E-9F0A-1C6B7E2D4A88
{"attributes":{"bounds":"[0,0][390,844]","clickable":"false"},"children":[
  {"attributes":{"elementType":"Button","accessibilityText":"","bounds":"[16,100][56,140]"},"children":[]},
  {"attributes":{"elementType":"StaticText","text":"Hello","bounds":"[16,160][374,182]"},"children":[]}
]}
`;

const XCUI_TREE = `Attributes: Application, pid: 8123, label: 'Aliquant'
Element subtree:
 →Application, 0x600001, {{0.0, 0.0}, {390.0, 844.0}}, label: 'Aliquant'
    Window (Main), 0x600002, {{0.0, 0.0}, {390.0, 844.0}}
      Other, 0x600003, {{0.0, 0.0}, {390.0, 844.0}}
        Button, 0x600004, {{16.0, 100.0}, {40.0, 40.0}}, label: 'Close'
        StaticText, 0x600005, {{16.0, 160.0}, {358.0, 22.0}}, label: 'Hello'
        Button, 0x600006, {{344.0, 100.0}, {30.0, 30.0}}, identifier: 'help'
        Button, 0x600007, {{16.0, 700.0}, {358.0, 50.0}}, label: 'Save', Disabled
Path to element:
 →Application, 0x600001
`;

const DEFAULTS_LANGUAGES = `(
    "en-US",
    fr
)
`;

const DEFAULTS_MISSING =
  "2026-09-04 11:02:14.881 defaults[4711:88213] \n" +
  "The domain/default pair of (kCFPreferencesAnyApplication, AppleLanguages) does not exist\n";

/** simctl's help, which lists option names one per line -- each value-shaped. */
const SIMCTL_UI_USAGE = `Usage: simctl ui <device> <option> [<arguments>]
Supported options:
    appearance
    content_size
    increase_contrast
`;

// ---------------------------------------------------------------------------

export function runDeviceParserChecks(check: Check) {
  // --- app-soak: dumpsys meminfo ---
  {
    const m = parseMeminfo(crlf(MEMINFO_PIXEL));
    check("meminfo: the App Summary total is the PSS, not the swap total on the same line",
      m.pssKb === 73200 && m.problem === null, JSON.stringify(m));
    check("meminfo: the pid is read through CRLF", m.pid === 8123, JSON.stringify(m));

    const legacy = parseMeminfo(crlf(MEMINFO_LEGACY));
    check("meminfo: a build with no App Summary still reports from the column table",
      legacy.pssKb === 93052 && legacy.problem === null, JSON.stringify(legacy));

    const gone = parseMeminfo(crlf(MEMINFO_GONE));
    check("meminfo: a dead app is a named problem, not 0 MB",
      gone.pssKb === null && (gone.problem ?? "").includes("no process found"), JSON.stringify(gone));

    const empty = parseMeminfo("");
    check("meminfo: empty output is refused rather than read as zero",
      empty.pssKb === null && empty.problem !== null, JSON.stringify(empty));
  }

  // --- app-soak: dumpsys gfxinfo ---
  {
    const g = parseGfxinfo(crlf(GFXINFO));
    check("gfxinfo: the modern Janky frames line wins over the legacy one",
      g.jankyFrames === 93 && g.totalFrames === 1842, JSON.stringify(g));
    check("gfxinfo: the percentage is computed from the counts, not read from the parentheses",
      g.jankPct !== null && Math.abs(g.jankPct - (93 / 1842) * 100) < 1e-9, JSON.stringify(g));

    const idle = parseGfxinfo(crlf(GFXINFO_IDLE));
    check("gfxinfo: zero frames rendered is no reading, not 0% jank",
      idle.jankPct === null && (idle.problem ?? "").includes("no frames"), JSON.stringify(idle));

    const none = parseGfxinfo(crlf("No process found for: com.taylab.aliquant\n"));
    check("gfxinfo: a dead app is a named problem", none.jankPct === null && none.problem !== null, JSON.stringify(none));

    const noisy = parseGfxinfo(crlf("Applications Graphics Acceleration Info:\nUptime: 12 Realtime: 12\n"));
    check("gfxinfo: a header with no counts is refused",
      noisy.jankPct === null && noisy.problem !== null, JSON.stringify(noisy));
  }

  // --- app-soak: logcat -b crash ---
  {
    const c = parseCrashLogcat(crlf(CRASH_JAVA), "com.taylab.aliquant");
    check("logcat: another app's FATAL EXCEPTION is not our crash",
      c.count === 1, JSON.stringify(c));
    check("logcat: the exception line becomes the signature",
      (c.signatures[0] ?? "").includes("IllegalStateException"), JSON.stringify(c.signatures));

    const n = parseCrashLogcat(crlf(CRASH_NATIVE), "com.taylab.aliquant");
    check("logcat: a tombstone counts as a crash and keeps its signal",
      n.count === 1 && (n.signatures[0] ?? "").includes("SIGSEGV"), JSON.stringify(n));

    const quiet = parseCrashLogcat(crlf("--------- beginning of crash\n"), "com.taylab.aliquant");
    check("logcat: an empty crash buffer is zero crashes, not a problem",
      quiet.count === 0 && quiet.problem === null, JSON.stringify(quiet));

    const broken = parseCrashLogcat("error: device 'ZY22HXXXXX' not found\n", "com.taylab.aliquant");
    check("logcat: a buffer that could not be read is a problem, never 0 crashes",
      broken.problem !== null, JSON.stringify(broken));
  }

  // --- app-soak: simulator crash reports ---
  {
    const s = parseSimCrashLog(SIM_CRASH, "com.taylab.aliquant");
    check("sim log: a saved crash report matches the bundle id by its executable leaf",
      s.count === 1 && s.problem === null, JSON.stringify(s));

    const other = parseSimCrashLog(SIM_CRASH_OTHER, "com.taylab.aliquant");
    check("sim log: another app's crash report is not ours", other.count === 0, JSON.stringify(other));

    const bad = parseSimCrashLog("log: Invalid predicate: unexpected token\n", "com.taylab.aliquant");
    check("sim log: a failed log show is a problem, not zero crashes",
      bad.problem !== null, JSON.stringify(bad));

    const empty = parseSimCrashLog("", "com.taylab.aliquant");
    check("sim log: an empty log is zero crashes with no problem",
      empty.count === 0 && empty.problem === null, JSON.stringify(empty));
  }

  // --- a11y: uiautomator ---
  {
    const t = parseUiautomatorDump(crlf(UIAUTOMATOR));
    check("uiautomator: the dump parses through CRLF", t.problem === null && t.nodes.length === 4, JSON.stringify(t.problem));

    // 420dpi: 90px -> 34pt and 60px -> 23pt are both under 44; 280px -> 107pt is not.
    const f = a11yFindings(t.nodes, { unit: "pixels", densityDpi: 420 }, { step: "home" });
    const errors = f.filter((x) => x.severity === "error");
    const warns = f.filter((x) => x.severity === "warn");
    check("a11y: an unlabelled tappable is one error",
      errors.length === 1 && errors[0].check === "a11y-label", JSON.stringify(errors));
    check("a11y: the unlabelled finding names the element that has no label",
      (errors[0]?.detail ?? "").includes("close"), JSON.stringify(errors[0]));
    check("a11y: pixel bounds converted at 420dpi flag both small targets and neither big one",
      warns.filter((w) => w.check === "a11y-target-size").length === 2, JSON.stringify(warns));

    const unknown = a11yFindings(t.nodes, { unit: "unknown" }, { step: "home" });
    check("a11y: without a density no size is judged, and the run says so",
      unknown.filter((x) => x.check === "a11y-target-size").length === 0 &&
      unknown.some((x) => x.check === "a11y-coverage" && x.detail.includes("unknown unit")),
      JSON.stringify(unknown));
    check("a11y: an unjudgeable size does not hide the label error",
      unknown.filter((x) => x.severity === "error").length === 1, JSON.stringify(unknown));

    const receipt = parseUiautomatorDump(UIAUTOMATOR_RECEIPT);
    check("uiautomator: the stdout receipt is not an empty screen with nothing wrong",
      receipt.nodes.length === 0 && receipt.problem !== null, JSON.stringify(receipt.problem));
    check("uiautomator: empty output is refused", parseUiautomatorDump("").problem !== null);
  }

  // --- a11y: maestro hierarchy ---
  {
    const t = parseMaestroHierarchy(MAESTRO_TREE);
    check("maestro: the JSON is found past the banner Maestro prints first",
      t.problem === null && t.nodes.length === 3, JSON.stringify(t.problem));
    const f = a11yFindings(t.nodes, { unit: "points" }, { step: "home" });
    check("maestro: an unlabelled Button is an error and its 40pt box is a warning",
      f.filter((x) => x.severity === "error").length === 1 &&
      f.filter((x) => x.check === "a11y-target-size").length === 1, JSON.stringify(f));
    check("maestro: non-JSON output is refused rather than read as an empty screen",
      parseMaestroHierarchy("command not found: maestro\n").problem !== null);
  }

  // --- a11y: XCUITest debugDescription ---
  {
    const t = parseXcuiDebugDescription(XCUI_TREE);
    check("xcui: the element subtree parses and the Path section is not read as elements",
      t.problem === null && t.nodes.length === 7, `${t.nodes.length} nodes`);
    check("xcui: `Window (Main)` is a Window, not a type called 'Window (Main)'",
      t.nodes.some((n) => n.cls === "Window"), JSON.stringify(t.nodes.map((n) => n.cls)));
    check("xcui: a disabled element is marked disabled rather than labelled 'Disabled'",
      t.nodes.some((n) => n.label === "Save" && !n.enabled), JSON.stringify(t.nodes.find((n) => n.label === "Save")));

    const f = a11yFindings(t.nodes, { unit: "points" }, { step: "home" });
    check("xcui: an identifier is not a label -- the help button is unlabelled",
      f.filter((x) => x.severity === "error").length === 1 &&
      (f.find((x) => x.severity === "error")?.detail ?? "").includes("help"), JSON.stringify(f));
    check("xcui: frames are already points, so 40pt and 30pt are both under the minimum",
      f.filter((x) => x.check === "a11y-target-size").length === 2, JSON.stringify(f));
    check("xcui: a disabled control is not judged at all",
      !JSON.stringify(f).includes("Save"), JSON.stringify(f));
    check("xcui: empty output is refused", parseXcuiDebugDescription("").problem !== null);
  }

  // --- a11y: density ---
  {
    check("density: the override wins over the physical density",
      parseAndroidDensity(crlf("Physical density: 420\nOverride density: 560\n")) === 560);
    check("density: a bare getprop value is read",
      parseAndroidDensity(crlf("420\n")) === 420);
    check("density: nothing usable is null, so the size check skips itself",
      parseAndroidDensity("") === null && parseAndroidDensity(crlf("Physical density: unknown\n")) === null);
  }

  // --- locale-shots: the tag vocabulary ---
  {
    const ar = parseLocaleTag("ar-eg");
    check("locale: case is normalised and Arabic is RTL",
      ar.tag === "ar-EG" && ar.rtl, JSON.stringify(ar));
    const zh = parseLocaleTag("zh-hant-tw");
    check("locale: a script subtag is title-cased and is not RTL",
      zh.tag === "zh-Hant-TW" && !zh.rtl, JSON.stringify(zh));
    check("locale: Hebrew is RTL", parseLocaleTag("he").rtl);
    check("locale: AppleLocale takes the underscored form", appleLocaleOf(ar) === "ar_EG");

    let threw = false;
    try { parseLocaleTag("ar_EG"); } catch { threw = true; }
    check("locale: an underscored tag is refused rather than stored and ignored", threw);

    threw = false;
    try { parseLocaleTag("english"); } catch { threw = true; }
    check("locale: a non-tag is refused", threw);

    const list = parseLocaleList("en,EN,fr,ar-EG");
    check("locale: the list dedupes case-insensitively and keeps order",
      list.length === 3 && list[0].tag === "en" && list[2].tag === "ar-EG", JSON.stringify(list.map((l) => l.tag)));
    check("locale: a list with an RTL member is detectable", coversRtl(list));
    check("locale: an all-LTR list is detectable", !coversRtl(parseLocaleList(["en", "fr"])));

    threw = false;
    try { parseLocaleList(undefined); } catch { threw = true; }
    check("locale: a missing params.locales throws rather than capturing one language", threw);

    threw = false;
    try { parseLocaleList([]); } catch { threw = true; }
    check("locale: an empty params.locales throws", threw);
  }

  // --- device settings: reading a value back ---
  {
    check("settings: the literal null means unset, not the string 'null'",
      parseAndroidSettingValue(crlf("null\n")) === null);
    check("settings: a value survives CRLF", parseAndroidSettingValue(crlf("ar-EG\n")) === "ar-EG");
    check("settings: empty output is unset", parseAndroidSettingValue("") === null);
    check("settings: uimode reports its state", parseUiModeNight(crlf("Night mode: yes\n")) === "yes");
    check("settings: an unparseable uimode answer is null", parseUiModeNight("") === null);

    check("defaults: a plist array parses with mixed quoting",
      JSON.stringify(parseDefaultsArray(DEFAULTS_LANGUAGES)) === JSON.stringify(["en-US", "fr"]),
      JSON.stringify(parseDefaultsArray(DEFAULTS_LANGUAGES)));
    check("defaults: an absent domain is null, so a restore deletes rather than writes an empty list",
      parseDefaultsArray(DEFAULTS_MISSING) === null);
    check("defaults: a scalar is unquoted", parseDefaultsString(crlf('"ar_EG"\n')) === "ar_EG");
    check("defaults: an absent scalar is null", parseDefaultsString(DEFAULTS_MISSING) === null);

    check("simctl ui: a current value is read", parseSimctlUiValue("light\n") === "light");
    check("simctl ui: a usage message is not read as a value -- its option names are value-shaped",
      parseSimctlUiValue(SIMCTL_UI_USAGE) === null, String(parseSimctlUiValue(SIMCTL_UI_USAGE)));
  }

  // --- device settings: what cannot be managed at all ---
  {
    check("state: a physical iPhone is refused by name",
      (unmanageableReason({ id: "00008130-001", platform: "ios", kind: "device" }) ?? "").includes("launchArguments"));
    check("state: a simulator is manageable",
      unmanageableReason({ id: "AB06-37DA", platform: "ios", kind: "simulator" }) === null);
    check("state: an Android device is manageable",
      unmanageableReason({ id: "ZY22HXXXXX", platform: "android", kind: "device" }) === null);
  }

  // --- a11y-audit: which display conditions each platform can actually produce ---
  {
    check("display: Android 14 offers a 2.0 text scale",
      planVariant("large-text", "android", { sdk: 34 }).settings["android:system.font_scale"] === "2.0");
    check("display: an older Android tops out where its own UI does",
      planVariant("large-text", "android", { sdk: 33 }).settings["android:system.font_scale"] === "1.3");

    const bold11 = planVariant("bold-text", "android", { sdk: 30 });
    check("display: bold text on Android 11 is refused -- the setting writes and nothing reads it",
      (bold11.unreachable ?? "").includes("consumes"), JSON.stringify(bold11));
    const bold12 = planVariant("bold-text", "android", { sdk: 31 });
    check("display: bold text on Android 12 is a real setting",
      !bold12.unreachable && bold12.settings["android:secure.font_weight_adjustment"] === "300", JSON.stringify(bold12));
    const boldUnknown = planVariant("bold-text", "android", { sdk: null });
    check("display: an unreadable API level refuses bold text rather than guessing",
      boldUnknown.unreachable !== undefined, JSON.stringify(boldUnknown));

    const boldIos = planVariant("bold-text", "ios-sim");
    check("display: bold text on a simulator is refused, naming simctl's actual options",
      (boldIos.unreachable ?? "").includes("increase_contrast"), JSON.stringify(boldIos));

    check("display: dark mode is reachable on both platforms",
      planVariant("dark", "ios-sim").settings["ios:ui.appearance"] === "dark" &&
      planVariant("dark", "android", { sdk: 33 }).settings["android:uimode.night"] === "yes");
    check("display: dark mode before Android 10 is refused",
      planVariant("dark", "android", { sdk: 28 }).unreachable !== undefined);
    check("display: the baseline pass changes nothing",
      Object.keys(planVariant("baseline", "android", { sdk: 34 }).settings).length === 0);

    check("display: the default is every condition", parseVariantList(undefined).length === 4);
    const one = parseVariantList("dark");
    check("display: asking for one condition still captures the baseline to compare it to",
      one.length === 2 && one[0] === "baseline" && one[1] === "dark", JSON.stringify(one));
    let threw = false;
    try { parseVariantList("huge"); } catch { threw = true; }
    check("display: an unknown condition throws rather than being skipped", threw);

    check("display: an API level parses, and nonsense is null",
      parseSdkLevel(crlf("34\n")) === 34 && parseSdkLevel("") === null && parseSdkLevel(crlf("REL\n")) === null);
  }

  // --- the contact sheet ---
  {
    const html = contactSheetHtml("locale-shots · com.x", [
      { column: "en", device: "ZY22H", shot: "home", file: "en/ZY22H/home.png" },
      { column: "ar-EG", rtl: true, device: "ZY22H", shot: "home", file: "ar-EG/ZY22H/home.png" },
      { column: "fr", device: "ZY22H", shot: "home", file: null, note: "flow failed: timed out" },
    ]);
    check("sheet: an RTL column is marked and its cells are rendered right-to-left",
      html.includes(">RTL<") && html.includes('<td dir="rtl">'), "");
    check("sheet: a missing shot is a visible labelled hole, not an empty cell",
      html.includes("no shot") && html.includes("flow failed: timed out"), "");
    check("sheet: the note is escaped into the page rather than injected",
      !contactSheetHtml("t", [{ column: "en", device: "d", shot: "s", file: null, note: "<script>x</script>" }])
        .includes("<script>x"), "");
  }
}

// Run standalone: `npx tsx src/device-parsers.test.ts`. pathToFileURL, not a
// template string: this repo lives under a path with a space in it, and
// `file://${path}` does not percent-encode it, so the comparison silently fails
// and the checks never run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failures = 0;
  runDeviceParserChecks((name, cond, detail = "") => {
    if (cond) console.log(`  ok    ${name}`);
    else {
      failures++;
      console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
  });
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
