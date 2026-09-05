/**
 * The display conditions an a11y-audit captures under, and what each one means
 * on each platform.
 *
 * Pure, so the table below is readable and testable without a device -- and
 * more importantly so the REFUSALS are. Half the value of this module is the
 * cases where it says a condition cannot be produced here: a bold-text pass
 * that quietly captured non-bold screenshots is worse than no bold-text pass,
 * because it is a set of images somebody will look at and conclude from.
 *
 * The three conditions are the three that actually break app layouts in the
 * field, in the order they break them:
 *
 *   large-text -- the largest dynamic type the platform offers. Nothing else
 *                 finds a clipped label or a two-line button that was designed
 *                 as one line.
 *   bold-text  -- widens every glyph without changing the point size, which
 *                 finds the truncation that large-text alone does not.
 *   dark       -- catches hardcoded colours: black text painted on a surface
 *                 that went black.
 */
import type { SettingName } from "./device-state.js";

export type VariantId = "baseline" | "large-text" | "bold-text" | "dark";
export const VARIANTS: VariantId[] = ["baseline", "large-text", "bold-text", "dark"];

export function isVariantId(s: string): s is VariantId {
  return (VARIANTS as string[]).includes(s);
}

export type VariantPlan = {
  id: VariantId;
  /** For a log line and the bundle's folder name. */
  label: string;
  /** Empty for the baseline pass, which changes nothing. */
  settings: Partial<Record<SettingName, string>>;
  /** Set when this platform cannot produce the condition. Then `settings` is ignored. */
  unreachable?: string;
};

/** Which platform surface a target presents; a physical iPhone is neither. */
export type DisplayPlatform = "android" | "ios-sim";

/**
 * The largest text scale the platform will actually apply.
 *
 * Android's own Settings UI topped out at 1.3 until Android 14 raised it to
 * 2.0. The framework has always honoured whatever float is in `font_scale`, so
 * writing 2.0 to an Android 13 device "works" -- and produces a condition no
 * user of that device can reach, which makes the screenshots evidence of
 * nothing. Largest means largest a person can choose.
 */
export function androidLargestFontScale(sdk: number | null): string {
  return sdk !== null && sdk >= 34 ? "2.0" : "1.3";
}

/**
 * What one variant means on one platform.
 *
 * `sdk` is the Android API level, or null when it could not be read; it gates
 * the two settings that are writable on every Android and only CONSUMED by
 * some. `settings put secure font_weight_adjustment 300` succeeds on Android
 * 11, reads back as 300, and changes nothing at all, so a read-back check
 * cannot catch it and the version gate has to.
 */
export function planVariant(
  id: VariantId,
  platform: DisplayPlatform,
  opts: { sdk?: number | null; fontScale?: string } = {},
): VariantPlan {
  const sdk = opts.sdk ?? null;

  if (id === "baseline") return { id, label: "baseline", settings: {} };

  if (platform === "android") {
    if (id === "large-text") {
      return {
        id, label: "large-text",
        settings: { "android:system.font_scale": opts.fontScale ?? androidLargestFontScale(sdk) },
      };
    }
    if (id === "bold-text") {
      if (sdk !== null && sdk < 31) {
        return {
          id, label: "bold-text", settings: {},
          unreachable:
            `bold text is Android 12's font_weight_adjustment and this device is API ${sdk}: the setting is ` +
            "writable here and reads back correctly, but nothing on the device consumes it, so the shots " +
            "would be ordinary weight filed as bold",
        };
      }
      if (sdk === null) {
        return {
          id, label: "bold-text", settings: {},
          unreachable:
            "bold text needs Android 12 or later (font_weight_adjustment) and this device's API level could " +
            "not be read; the setting is writable on every version and consumed only from 12, so it cannot " +
            "be verified by reading it back",
        };
      }
      return { id, label: "bold-text", settings: { "android:secure.font_weight_adjustment": "300" } };
    }
    // dark
    if (sdk !== null && sdk < 29) {
      return {
        id, label: "dark", settings: {},
        unreachable: `system dark mode arrived in Android 10 and this device is API ${sdk}`,
      };
    }
    return { id, label: "dark", settings: { "android:uimode.night": "yes" } };
  }

  // iOS simulator
  if (id === "large-text") {
    return {
      id, label: "large-text",
      // The largest value simctl accepts, which is the largest the accessibility
      // text-size slider offers.
      settings: { "ios:ui.content_size": "accessibility-extra-extra-extra-large" },
    };
  }
  if (id === "bold-text") {
    return {
      id, label: "bold-text", settings: {},
      unreachable:
        "simctl ui has no bold-text option -- it exposes appearance, content_size and increase_contrast and " +
        "nothing else -- and the preference lives in the simulator's Accessibility domain, which no supported " +
        "tool writes from outside. The reachable paths are the Simulator's own Settings app (manual, so not a " +
        "nightly) or the app under test honouring a debug override",
    };
  }
  return { id, label: "dark", settings: { "ios:ui.appearance": "dark" } };
}

/**
 * `params.variants` -> the passes to run, defaulting to all of them.
 *
 * The baseline pass is always included and always first: it is the tree dump's
 * pass and the reference every other image is read against, and a job that
 * asked only for `dark` still needs something to compare dark to.
 */
export function parseVariantList(raw: unknown): VariantId[] {
  if (raw === undefined || raw === null) return [...VARIANTS];
  const asked = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  const out: VariantId[] = ["baseline"];
  for (const a of asked) {
    const s = a.trim();
    if (s === "") continue;
    if (!isVariantId(s)) {
      throw new Error(`params.variants has ${JSON.stringify(s)}; the conditions are ${VARIANTS.join(", ")}`);
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** `getprop ro.build.version.sdk` -> 34, or null when it said nothing usable. */
export function parseSdkLevel(out: string): number | null {
  const v = Number(out.replace(/\r/g, "").trim());
  return Number.isInteger(v) && v > 0 ? v : null;
}
