/**
 * The shelf draws each device as the right object.
 *
 * The first block is the real fleet, copied from what its agents report: kind
 * null, and a `platform` that is the collector's ios/android fallback for
 * agents that predate the field — which is why a Roku arrives as `android` and
 * an Apple TV as `ios`, and why the resolver reads the model first. If one of
 * these regresses, a device on the actual shelf changes shape.
 *
 * The second block reaches every drawing at least once, so none of them is
 * dead art that no device can ever get.
 */
import { deviceArtKind, type DeviceArtKind } from "../dash/src/deviceKind.js";

type Case = [label: string, kind: string | null, platform: string, model: string, os: string, want: DeviceArtKind];

const FLEET: Case[] = [
  ["fleet-host", "laptop", "macos", "MacBook Pro", "macos-12.7.6", "macbook"],
  ["M1 Pro dev laptop", "laptop", "macos", "MacBook Pro", "macos-27.0", "macbook"],
  ["Galaxy S8+", null, "android", "SM-G955U1", "android-9", "galaxy"],
  ["Galaxy S9", null, "android", "SM-G960U1", "android-10", "galaxy"],
  ["Galaxy Tab S9", null, "android", "SM-X930", "android-16", "android-tablet"],
  ["Roku Express 4K+", null, "android", "Roku Express 4K+", "roku-15.3.4", "roku-box"],
  ["Roku found by address", null, "android", "roku", "roku", "roku-box"],
  ["iPhone 17 Pro", null, "ios", "iPhone 17 Pro", "ios-27.0", "iphone"],
  ["iPhone 16", null, "ios", "iPhone 16", "ios-18.4", "iphone"],
  ["iPhone 12 Pro", null, "ios", "iPhone 12 Pro", "ios-18.7.8", "iphone"],
  ["iPhone SE 3", null, "ios", "iPhone SE (3rd generation)", "ios-26.5", "iphone-se"],
  ["Apple TV 4K", null, "ios", "Apple TV 4K", "ios-26.6", "apple-tv"],
  ["Apple Watch Series 11", null, "ios", "Apple Watch Series 11", "ios-26.4", "apple-watch"],
  ["named simulator", null, "ios", "fleet-sim-1", "ios-26.5", "iphone"],
];

const EVERY_DRAWING: Case[] = [
  ["Pixel by kind", "phone", "android", "Pixel 9", "android-16", "android-phone"],
  ["iPad", null, "ios", "iPad Pro (11-inch)", "ios-26.0", "ipad"],
  ["iPhone 8 by id", null, "ios", "iPhone10,4", "ios-16.7", "iphone-se"],
  ["iPhone X by id is not an SE", null, "ios", "iPhone10,3", "ios-16.7", "iphone"],
  ["iPhone 15 is not an SE", null, "ios", "iPhone 15", "ios-26.0", "iphone"],
  ["Roku stick", null, "roku", "Roku Streaming Stick 4K", "roku-15.1", "roku-stick"],
  ["Roku by kind", "tv", "roku", "Roku Ultra", "roku-15.1", "roku-box"],
  ["tvOS by platform", null, "tvos", "", "tvos-26.0", "apple-tv"],
  ["Fire TV by model code", null, "android", "AFTKA", "android-11", "fire-stick"],
  ["Chromecast", null, "android", "Chromecast with Google TV", "android-12", "chromecast"],
  ["Bravia", "tv", "android", "BRAVIA 4K VH2", "android-12", "tv"],
  ["webOS", null, "webos", "OLED55C3", "webos-23", "tv"],
  ["Windows laptop", "laptop", "windows", "ThinkPad X1", "windows-11", "pc-laptop"],
  ["Linux by os only", null, "", "", "linux-6.8", "pc-laptop"],
  ["Mac mini", "desktop", "macos", "Mac mini", "macos-26.0", "desktop"],
  ["CI container", "container", "linux", "", "linux-6.8", "server"],
  ["Galaxy Watch", null, "android", "SM-R960", "android-14", "wear-watch"],
  ["Vision Pro", null, "visionos", "Apple Vision Pro", "visionos-26", "headset"],
  ["Raspberry Pi", "sbc", "linux", "Raspberry Pi 5", "linux-6.6", "board"],
  ["browser tab", "browser", "web", "Chrome 140", "", "browser"],
  ["nothing known", null, "", "", "", "unknown"],
];

let failed = false;
const seen = new Set<DeviceArtKind>();
for (const [label, kind, platform, model, os, want] of [...FLEET, ...EVERY_DRAWING]) {
  const got = deviceArtKind({ kind, platform, descriptor: { model, os } });
  seen.add(got);
  const ok = got === want;
  if (!ok) failed = true;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label} → ${got}${ok ? "" : ` (want ${want})`}`);
}

const ALL: DeviceArtKind[] = [
  "iphone", "iphone-se", "galaxy", "android-phone", "ipad", "android-tablet",
  "roku-box", "roku-stick", "apple-tv", "fire-stick", "chromecast", "tv",
  "macbook", "pc-laptop", "desktop", "server", "apple-watch", "wear-watch",
  "headset", "board", "browser", "unknown",
];
const unreached = ALL.filter((k) => !seen.has(k));
if (unreached.length) {
  failed = true;
  console.log(`  FAIL  no case reaches: ${unreached.join(", ")}`);
}

if (failed) process.exit(1);
