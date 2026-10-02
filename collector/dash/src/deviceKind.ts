/**
 * Which drawing a device gets on the shelf.
 *
 * Kept free of imports and JSX so scripts/check-device-art.ts can run it under
 * plain node against the model strings the real fleet reports.
 *
 * The model string comes first, because it is the one field that is right
 * about every device on the shelf today. `platform` is not: agents that
 * predate the field are reported as ios/android by the collector's fallback,
 * so a Roku arrives as `android` and an Apple TV or Apple Watch as `ios`.
 * `kind` is the agent naming its own shape and is believed — but only to pick
 * the family; the model still chooses which member of it (a `tv` that says
 * "Roku Streaming Stick" is drawn as the stick, not a bare panel).
 */

export type DeviceArtKind =
  | "iphone" | "iphone-se" | "galaxy" | "android-phone"
  | "ipad" | "android-tablet"
  | "roku-box" | "roku-stick" | "apple-tv" | "fire-stick" | "chromecast" | "tv"
  | "macbook" | "pc-laptop" | "desktop" | "server"
  | "apple-watch" | "wear-watch"
  | "headset" | "board" | "browser" | "unknown";

export type ArtInput = {
  kind: string | null;
  platform: string | null;
  descriptor: Record<string, unknown>;
};

/**
 * Model string (and OS, for the few devices whose OS names the box) → drawing.
 * First match wins, so the specific patterns sit above the general ones:
 * "Galaxy Tab" before "Galaxy", "iPhone SE" before "iPhone".
 */
const BY_MODEL: [RegExp, DeviceArtKind][] = [
  [/stick.*\broku\b|\broku\b.*stick/i, "roku-stick"],
  [/\broku\b|^roku-/i, "roku-box"],
  [/apple ?tv|^appletv\d|^tvos/i, "apple-tv"],
  [/apple watch|^watch\d+,|^watchos/i, "apple-watch"],
  [/vision pro|^realitydevice|quest|^visionos/i, "headset"],
  [/ipad/i, "ipad"],
  // Home-button iPhones, by name or by hardware id: 6s/SE (iPhone8,x), 7
  // (iPhone9,x), 8 (iPhone10,1/2/4/5 — 10,3 and 10,6 are the X), SE 2 and 3.
  [/^iphone ?(se\b|[5-8]\b|[5-6]s\b)|^iphone(8|9),\d|^iphone10,[1245]$|^iphone12,8$|^iphone14,6$/i, "iphone-se"],
  [/^iphone/i, "iphone"],
  // Amazon's model codes all start AFT (AFTMM, AFTKA…).
  [/^aft[a-z]|fire ?tv/i, "fire-stick"],
  [/chromecast|google tv/i, "chromecast"],
  // Samsung: SM-T/X/P are tablets, SM-R watches, everything else a phone.
  [/^sm-[txp]\d|galaxy tab/i, "android-tablet"],
  [/^sm-r\d|galaxy watch|pixel watch|wear ?os/i, "wear-watch"],
  [/^sm-|galaxy/i, "galaxy"],
  [/\btab\b|tablet/i, "android-tablet"],
  [/bravia|shield|android tv|tizen|webos|smart ?tv/i, "tv"],
  [/macbook/i, "macbook"],
  [/mac ?mini|imac|mac ?studio|mac ?pro\b/i, "desktop"],
  [/raspberry|jetson|esp32|arduino|beaglebone/i, "board"],
];

/** The drawings each self-declared `kind` may resolve to; the first is its default. */
const FAMILY: Record<string, DeviceArtKind[]> = {
  phone: ["android-phone", "iphone", "iphone-se", "galaxy"],
  tablet: ["android-tablet", "ipad"],
  tv: ["tv", "roku-box", "roku-stick", "apple-tv", "fire-stick", "chromecast"],
  laptop: ["pc-laptop", "macbook"],
  desktop: ["desktop"],
  ci: ["server"],
  container: ["server"],
  watch: ["wear-watch", "apple-watch"],
  headset: ["headset"],
  sbc: ["board"],
  mcu: ["board"],
  board: ["board"],
  browser: ["browser"],
};

/** What a platform alone says, for a device whose model names nothing we draw. */
const BY_PLATFORM: Record<string, DeviceArtKind> = {
  web: "browser",
  tvos: "apple-tv",
  watchos: "apple-watch",
  visionos: "headset",
  macos: "macbook",
  windows: "pc-laptop",
  linux: "pc-laptop",
  roku: "roku-box",
  ios: "iphone",
  ipados: "ipad",
  android: "android-phone",
};

/** The Apple member of a family, for a `kind` on an Apple platform with an unhelpful model. */
const APPLE: Record<string, DeviceArtKind> = {
  phone: "iphone",
  tablet: "ipad",
  tv: "apple-tv",
  laptop: "macbook",
  watch: "apple-watch",
};

function byModel(model: string, os: string): DeviceArtKind | null {
  for (const [re, art] of BY_MODEL) if (re.test(model)) return art;
  // A few boxes are only identifiable by their OS string (a Roku found by
  // address reports model "roku", but one found before discovery named it may
  // report nothing but `roku-15.x`).
  for (const [re, art] of BY_MODEL) if (os && re.test(os)) return art;
  return null;
}

export function deviceArtKind(d: ArtInput): DeviceArtKind {
  const model = String(d.descriptor.model ?? "").trim();
  const os = String(d.descriptor.os ?? "").trim().toLowerCase();
  const platform = String(d.platform ?? "").toLowerCase();
  const kind = String(d.kind ?? "").toLowerCase();
  const fromModel = byModel(model, os);

  const family = FAMILY[kind];
  if (family) {
    if (fromModel && family.includes(fromModel)) return fromModel;
    const apple = /^(ios|ipados|tvos|watchos|macos)$/.test(platform) || /^(ios|tvos|watchos|macos|darwin)/.test(os);
    return (apple && APPLE[kind]) || family[0];
  }

  if (fromModel) return fromModel;
  if (BY_PLATFORM[platform]) return BY_PLATFORM[platform];
  if (/^(macos|darwin)/.test(os)) return "macbook";
  if (/^(linux|windows|win32)/.test(os)) return "pc-laptop";
  if (/^android/.test(os)) return "android-phone";
  if (/^ios/.test(os)) return "iphone";
  return "unknown";
}
