/**
 * The locale half of locale-shots: which locales a job asked for, and what each
 * one means on each platform. (The review page the bundle carries is in
 * contact-sheet.ts, which a11y-audit produces too.)
 *
 * Pure, and its own module, for the reason am-start.ts states: the executor is a
 * long-running process with a main() loop and cannot be imported, so anything
 * only reachable from inside it is only ever tested by plugging in a phone.
 *
 * The one judgement encoded here is that an unrecognisable locale tag is
 * refused rather than passed through. `settings put system system_locales
 * ar_EG` succeeds -- the settings provider stores any string it is given -- and
 * then the framework ignores it, because the separator is a hyphen. The run
 * that follows captures a full set of English screenshots and files them in a
 * folder named ar_EG, which is a worse outcome than the job failing, and it is
 * indistinguishable from success at every point downstream.
 */

/**
 * Languages written right-to-left, by ISO-639 subtag.
 *
 * Deliberately conservative: a language is on this list only when its standard
 * orthography is RTL. Kurdish is not, because Kurmanji is Latin script and
 * Sorani is Arabic script, and the bare tag `ku` does not say which. Getting
 * this wrong in the permissive direction is what puts a "RTL COVERED" note on a
 * run that never rendered a mirrored layout.
 */
const RTL_LANGUAGES = new Set([
  "ar", "arc", "ckb", "dv", "fa", "ha", "he", "iw", "ji", "ps", "sd", "ug", "ur", "yi",
]);

/** Scripts that are RTL regardless of the language written in them. */
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "syrc", "nkoo", "adlm", "rohg", "yezi"]);

/**
 * BCP-47 as much of it as a device will honour: language, optional script,
 * optional region. Extensions and variants are refused rather than passed on,
 * because no platform path below does anything useful with them.
 */
const TAG = /^([a-z]{2,3})(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|\d{3}))?$/;

export type Locale = {
  /** The tag as it will be given to the device, canonically cased. */
  tag: string;
  language: string;
  script?: string;
  region?: string;
  rtl: boolean;
};

/**
 * Canonicalise one tag, or throw naming what is wrong with it.
 *
 * Case is normalised rather than rejected -- `ar-eg`, `AR-EG` and `ar-EG` are
 * the same request and a person typing a job spec should not have to know that
 * Android cares -- but an underscore is NOT silently converted, because
 * `ar_EG` is what someone writes when they are thinking of a Java Locale, and
 * accepting it here hides that the thing they will read in the results was
 * produced by a different convention.
 */
export function parseLocaleTag(raw: string): Locale {
  const s = raw.trim();
  if (s === "") throw new Error("params.locales contains an empty locale");
  if (s.includes("_")) {
    throw new Error(
      `locale "${s}" uses an underscore; BCP-47 tags are hyphenated (${s.replace(/_/g, "-")}), ` +
      "and Android's system_locales silently ignores the underscored form",
    );
  }
  const parts = s.split("-");
  const cased = [
    parts[0].toLowerCase(),
    ...parts.slice(1).map((p) =>
      p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()),
  ].join("-");
  const m = TAG.exec(cased);
  if (!m) {
    throw new Error(
      `locale "${raw}" is not a language[-Script][-REGION] tag (e.g. fr, ar-EG, zh-Hant-TW). ` +
      "A tag the device does not understand is stored anyway and then ignored, so the run would " +
      "capture one language under every folder name",
    );
  }
  const [, language, script, region] = m;
  return {
    tag: cased,
    language,
    ...(script ? { script } : {}),
    ...(region ? { region } : {}),
    rtl: RTL_LANGUAGES.has(language) || (script ? RTL_SCRIPTS.has(script.toLowerCase()) : false),
  };
}

/**
 * `params.locales` -> the list to run, refusing the shapes that would produce a
 * green run covering one language.
 */
export function parseLocaleList(raw: unknown): Locale[] {
  const asked = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === "string"
      ? raw.split(",")
      : null;
  if (asked === null) {
    throw new Error("locale-shots needs params.locales: an array of BCP-47 tags, or a comma-separated string");
  }
  const out: Locale[] = [];
  for (const a of asked) {
    if (a.trim() === "") continue;
    const l = parseLocaleTag(a);
    if (!out.some((x) => x.tag === l.tag)) out.push(l);
  }
  if (out.length === 0) throw new Error("params.locales is empty; there is nothing to capture");
  return out;
}

/** Whether the list covers a right-to-left language at all. */
export const coversRtl = (locales: Locale[]): boolean => locales.some((l) => l.rtl);

/** `ar-EG` -> `ar_EG`, which is the only form AppleLocale accepts. */
export const appleLocaleOf = (l: Locale): string => l.tag.replace(/-/g, "_");

/** Safe as a directory name inside the bundle, and stable across platforms. */
export const localeDirName = (l: Locale): string => l.tag.replace(/[^A-Za-z0-9-]/g, "_");
