/**
 * The conditions a mission can run under (D7): dark mode, the largest text,
 * another language, no network or a slow one, a rotated screen, and a trip to
 * the background and back.
 *
 * Nothing new is invented for the settings. Display and locale go through
 * device-state.ts and network through network-shape.ts, which journal every
 * change before making it and restore it in a finally, with a sweep at
 * executor startup behind that. A phone left at 2x text in Spanish by a night
 * of exploring is not obviously broken, which is exactly why it would go
 * unnoticed. Rotation is the one condition those modules do not cover; it is
 * restored in a finally here and is cheap to undo by hand if a crash beats it.
 */
import { exec } from "../../fleet-client.js";
import { planVariant, androidLargestFontScale, isVariantId, parseSdkLevel, type VariantId } from "../../display-settings.js";
import { withState, type SettingName } from "../../device-state.js";
import { appleLocaleOf, parseLocaleTag } from "../../locale.js";
import { parseNetworkProfile, withNetwork } from "../../network-shape.js";
import { ADB } from "../device.js";
import type { Target } from "../types.js";

export type Condition = {
  id: string;
  /** Said to the model, so it knows why the screen looks the way it does. */
  hint: string | null;
  /** The language the judge should expect, for the untranslated check. */
  language: string | null;
  /** Extra launch arguments (iOS languages ride on these). */
  launchArgs: string[];
  /** Put the app in the background once, at this share of the budget. */
  backgroundAt: number | null;
  /** Wrap a mission in the setting. */
  around<T>(fn: () => Promise<T>): Promise<T>;
};

const LANGUAGES: Record<string, string> = { en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian", pt: "Portuguese", ja: "Japanese", ar: "Arabic" };

export function parseConditions(raw: unknown): string[] {
  if (raw === undefined) return ["baseline"];
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string")) throw new Error("params.conditions must be a list of names");
  for (const c of raw as string[]) conditionProblem(c, true);
  return raw as string[];
}

function conditionProblem(c: string, throwIt = false): string | null {
  const ok = c === "baseline" || c === "rotate" || c === "background" || isVariantId(c)
    || /^locale:/.test(c) || /^network:/.test(c);
  const problem = ok ? null : `unknown condition ${JSON.stringify(c)}: use baseline, dark, large-text, bold-text, locale:<tag>, network:<offline|3g|lossy|offline-after-Ns>, rotate or background`;
  if (problem && throwIt) throw new Error(problem);
  if (/^network:/.test(c)) parseNetworkProfile(c.slice(8));
  if (/^locale:/.test(c)) parseLocaleTag(c.slice(7));
  return problem;
}

async function sdkOf(t: Target): Promise<number | null> {
  try {
    return parseSdkLevel((await exec(ADB, ["-s", t.id, "shell", "getprop", "ro.build.version.sdk"], { timeout: 10_000 })).stdout);
  } catch {
    return null;
  }
}

export async function conditionFor(c: string, t: Target, baseLanguage = "English"): Promise<Condition> {
  const plain = { id: c, hint: null, language: baseLanguage, launchArgs: [] as string[], backgroundAt: null, around: <T>(fn: () => Promise<T>) => fn() };
  if (c === "baseline") return plain;

  if (isVariantId(c)) {
    const platform = t.platform === "android" ? "android" : "ios-sim";
    if (t.kind === "device" && t.platform !== "android") throw new Error(`${c} cannot be set on a physical Apple device from this host`);
    const sdk = t.platform === "android" ? await sdkOf(t) : null;
    const plan = planVariant(c as VariantId, platform, { sdk, fontScale: t.platform === "android" ? androidLargestFontScale(sdk) : undefined });
    if (plan.unreachable) throw new Error(`${c}: ${plan.unreachable}`);
    return {
      ...plain,
      hint: `The device is set to ${plan.label}. Look for anything that does not fit or cannot be read under it.`,
      around: (fn) => withState(t, "display", plan.settings, fn),
    };
  }

  if (c.startsWith("locale:")) {
    const l = parseLocaleTag(c.slice(7));
    const settings: Partial<Record<SettingName, string>> = t.platform === "android"
      ? { "android:system.system_locales": l.tag }
      : { "ios:defaults.AppleLanguages": l.tag, "ios:defaults.AppleLocale": appleLocaleOf(l) };
    const language = LANGUAGES[l.language] ?? l.tag;
    return {
      ...plain,
      language,
      hint: `The device language is ${language}. Every label should be in ${language}; English or raw keys are defects.`,
      launchArgs: t.platform === "android" ? [] : ["-AppleLanguages", `(${l.tag})`, "-AppleLocale", appleLocaleOf(l)],
      around: (fn) => withState(t, "locale", settings, fn),
    };
  }

  if (c.startsWith("network:")) {
    const profile = c.slice(8);
    parseNetworkProfile(profile);
    return {
      ...plain,
      hint: profile.startsWith("offline")
        ? "The device is offline. Screens should say so and keep working with what they have; spinners that never end and raw errors are defects."
        : `The network is ${profile}. Slow loading is expected; hangs, duplicate submissions and raw errors are defects.`,
      around: (fn) => withNetwork({ params: { network: profile } }, t, fn),
    };
  }

  if (c === "rotate") {
    if (t.platform !== "android") throw new Error("rotate is implemented for Android only (simctl has no rotation command)");
    return {
      ...plain,
      hint: "The screen is in landscape.",
      around: async (fn) => {
        const get = async (k: string) => (await exec(ADB, ["-s", t.id, "shell", "settings", "get", "system", k], { timeout: 10_000 })).stdout.trim();
        const put = (k: string, v: string) => exec(ADB, ["-s", t.id, "shell", "settings", "put", "system", k, v], { timeout: 10_000 });
        const before = { acc: await get("accelerometer_rotation"), rot: await get("user_rotation") };
        await put("accelerometer_rotation", "0");
        await put("user_rotation", "1");
        try {
          return await fn();
        } finally {
          await put("user_rotation", before.rot === "null" ? "0" : before.rot).catch(() => {});
          await put("accelerometer_rotation", before.acc === "null" ? "1" : before.acc).catch(() => {});
        }
      },
    };
  }

  if (c === "background") {
    return { ...plain, hint: "Midway through, the harness will send the app to the background and bring it back. Check nothing was lost.", backgroundAt: 0.5 };
  }

  throw new Error(conditionProblem(c) ?? `unknown condition ${c}`);
}
