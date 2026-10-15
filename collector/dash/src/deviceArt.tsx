// A device, drawn as the object it is.
//
// The shelf shows machines, not rows, so each one is a small picture of the
// thing on the shelf: an iPhone has its island, a Galaxy its curved edges, a
// Roku sits in front of the television it drives. The screen carries the live
// facts, as the plain silhouettes before these did — green with a pulse when
// online, amber when stale, dark when offline, breathing while a job runs —
// and a simulator's outline is dashed, because it is not a real object.
//
// Every drawing shares one 96×96 box, so a phone and a television line up on
// the shelf without per-kind sizing. Colours come from classes (style.css,
// "device art"), so both themes and every status reuse the same markup; the
// only literal fills are the few marks that identify a brand's hardware by
// colour alone (Roku's purple tag, the Fire TV stripe, a board's gold pins).
import type { JSX } from "preact";
import type { DeviceArtKind } from "./deviceKind.js";

export type { DeviceArtKind } from "./deviceKind.js";

const PURPLE = "#8b5cf6";
const ORANGE = "#ff8a1f";
const GOLD = "#c9a227";
const PCB = "#1c332c";

/** A television, drawn behind a streaming box or stick so the box has a screen to carry status on. */
const Telly = () => (
  <>
    <rect class="bz e" x="8.5" y="6" width="79" height="50" rx="3" />
    <rect class="sc" x="11" y="8.5" width="74" height="43" rx="1.5" />
  </>
);
const TELLY_PULSE = "M30 30h8l4-10 8 20 4-10h12";

/** The drawing, minus the pulse, and where the pulse goes on its screen. */
const ART: Record<DeviceArtKind, { body: () => JSX.Element; pulse: string }> = {
  iphone: {
    body: () => (
      <>
        <rect class="bt" x="24.6" y="22" width="2.4" height="5" rx="1" />
        <rect class="bt" x="24.6" y="31" width="2.4" height="8" rx="1" />
        <rect class="bt" x="24.6" y="42" width="2.4" height="8" rx="1" />
        <rect class="bt" x="69" y="33" width="2.4" height="13" rx="1" />
        <rect class="bz e" x="26.5" y="4" width="43" height="88" rx="11.5" />
        <rect class="sc" x="29.5" y="7" width="37" height="82" rx="8.5" />
        <rect class="bz" x="41" y="10.5" width="14" height="5" rx="2.5" />
      </>
    ),
    pulse: "M36 49h5l3-8 6 16 3-8h7",
  },
  "iphone-se": {
    body: () => (
      <>
        <rect class="bt" x="25.6" y="20" width="2.4" height="5" rx="1" />
        <rect class="bt" x="25.6" y="29" width="2.4" height="7" rx="1" />
        <rect class="bt" x="25.6" y="39" width="2.4" height="7" rx="1" />
        <rect class="bt" x="68" y="29" width="2.4" height="10" rx="1" />
        <rect class="bz e" x="27.5" y="4" width="41" height="88" rx="9" />
        <rect class="sc" x="31" y="17" width="34" height="59" rx="1.5" />
        <rect class="sn" x="43" y="9.6" width="10" height="2" rx="1" />
        <circle class="sn" cx="38.5" cy="10.6" r="1.1" />
        <circle class="e thin" cx="48" cy="84" r="4.4" fill="none" />
      </>
    ),
    pulse: "M37.5 46.5h4.5l3-7.5 5.5 15 3-7.5h5",
  },
  galaxy: {
    body: () => (
      <>
        <rect class="bt" x="25.6" y="24" width="2.4" height="12" rx="1" />
        <rect class="bt" x="25.6" y="40" width="2.4" height="7" rx="1" />
        <rect class="bt" x="68" y="34" width="2.4" height="9" rx="1" />
        <rect class="bz e" x="27.5" y="3" width="41" height="90" rx="9" />
        <rect class="sc" x="28.6" y="9.5" width="38.8" height="77" rx="6" />
        {/* The curved edges: light catching the glass where it wraps. */}
        <rect class="glint" x="28.6" y="13" width="2.6" height="70" rx="1.3" />
        <rect class="glint" x="64.8" y="13" width="2.6" height="70" rx="1.3" />
        <rect class="sn" x="44.5" y="5.6" width="7" height="1.6" rx="0.8" />
        <circle class="sn" cx="40" cy="6.4" r="0.9" />
        <circle class="sn" cx="56" cy="6.4" r="0.9" />
      </>
    ),
    pulse: "M36 48h5l3-8 6 16 3-8h7",
  },
  "android-phone": {
    body: () => (
      <>
        <rect class="bt" x="69" y="24" width="2.4" height="8" rx="1" />
        <rect class="bt" x="69" y="36" width="2.4" height="15" rx="1" />
        <rect class="bz e" x="26.5" y="4" width="43" height="88" rx="8" />
        <rect class="sc" x="29.5" y="7" width="37" height="82" rx="5" />
        <circle class="bz" cx="48" cy="12.5" r="2.1" />
      </>
    ),
    pulse: "M36 49h5l3-8 6 16 3-8h7",
  },
  ipad: {
    body: () => (
      <>
        <rect class="mt" x="64" y="3.4" width="9" height="2.4" rx="1" />
        <rect class="mt" x="80.6" y="14" width="2.4" height="7" rx="1" />
        <rect class="mt" x="80.6" y="24" width="2.4" height="7" rx="1" />
        <rect class="bz em" x="15" y="5.5" width="66" height="85" rx="7.5" />
        <rect class="sc" x="19.5" y="10" width="57" height="76" rx="3.5" />
        <circle class="sn" cx="48" cy="7.8" r="0.9" />
      </>
    ),
    pulse: "M32 48h7l4.5-11 9 22 4.5-11h7",
  },
  "android-tablet": {
    body: () => (
      <>
        <rect class="bt" x="60" y="15.4" width="7" height="2.4" rx="1" />
        <rect class="bt" x="70" y="15.4" width="12" height="2.4" rx="1" />
        <rect class="bz e" x="4.5" y="17.5" width="87" height="61" rx="6" />
        <rect class="sc" x="9" y="22" width="78" height="52" rx="2.5" />
        <circle class="sn" cx="48" cy="19.8" r="0.9" />
      </>
    ),
    pulse: "M31 48h8l4-10 8 20 4-10h10",
  },
  tv: {
    body: () => (
      <>
        <path class="strap ln" d="M27 71l-5 9M69 71l5 9" />
        <rect class="bz e" x="4.5" y="15" width="87" height="55" rx="3" />
        <rect class="sc" x="7" y="17.5" width="82" height="48" rx="1.5" />
        <rect class="sn" x="45" y="67" width="6" height="1.4" rx="0.7" />
      </>
    ),
    pulse: "M28 42h9l4.5-11 9 22 4.5-11h13",
  },
  "roku-box": {
    body: () => (
      <>
        <Telly />
        <rect x="71" y="72" width="9" height="7" rx="1" fill={PURPLE} />
        <path class="bx e" d="M22 86v-7a13 13 0 0 1 13-13h26a13 13 0 0 1 13 13v7a2 2 0 0 1-2 2H24a2 2 0 0 1-2-2z" />
        <circle class="sc" cx="48" cy="80" r="1.7" />
      </>
    ),
    pulse: TELLY_PULSE,
  },
  "roku-stick": {
    body: () => (
      <>
        <Telly />
        <rect class="mt" x="14" y="73.5" width="11" height="8" rx="1" />
        <rect x="72" y="74" width="8" height="7" rx="1" fill={PURPLE} />
        <rect class="bx e" x="23.5" y="70" width="50" height="15" rx="4" />
        <circle class="sc" cx="64" cy="77.5" r="1.7" />
      </>
    ),
    pulse: TELLY_PULSE,
  },
  "apple-tv": {
    body: () => (
      <>
        <Telly />
        <rect class="bz e" x="27" y="65" width="42" height="23" rx="7" />
        <path class="groove ln" d="M32 71.5h32" />
        <circle class="sc" cx="62" cy="80" r="1.5" />
      </>
    ),
    pulse: TELLY_PULSE,
  },
  "fire-stick": {
    body: () => (
      <>
        <Telly />
        <rect class="mt" x="8" y="74" width="11" height="8" rx="1" />
        <rect class="bx e" x="17.5" y="69.5" width="68" height="17" rx="2.5" />
        <rect x="62" y="77" width="14" height="2" rx="1" fill={ORANGE} />
        <circle class="sc" cx="27" cy="78" r="1.7" />
      </>
    ),
    pulse: TELLY_PULSE,
  },
  chromecast: {
    body: () => (
      <>
        <path class="cable ln" d="M48 57v9" />
        <Telly />
        <ellipse class="puck em" cx="48" cy="77" rx="19" ry="12" />
        <circle class="pl" cx="48" cy="78" r="2.8" />
        <circle class="sc" cx="48" cy="78" r="1.6" />
      </>
    ),
    pulse: TELLY_PULSE,
  },
  macbook: {
    body: () => (
      <>
        <rect class="bz em" x="13.5" y="20" width="69" height="48" rx="4.5" />
        <rect class="sc" x="16.5" y="23" width="63" height="41" rx="2" />
        <path class="bz" d="M43 23h10v2.2a1.4 1.4 0 0 1-1.4 1.4h-7.2a1.4 1.4 0 0 1-1.4-1.4z" />
        <path class="mt" d="M5 69h86v2.5a4.5 4.5 0 0 1-4.5 4.5h-77A4.5 4.5 0 0 1 5 71.5z" />
        <path class="bt" d="M41 69h14v1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 41 70z" />
      </>
    ),
    pulse: "M30 44h8l4-10 8 20 4-10h12",
  },
  "pc-laptop": {
    body: () => (
      <>
        <rect class="pl e" x="14.5" y="20" width="67" height="46" rx="3" />
        <rect class="sc" x="18.5" y="24.5" width="59" height="35" rx="1.5" />
        <circle class="bt" cx="48" cy="22.2" r="0.8" />
        <path class="pl e" stroke-linejoin="round" d="M12 68h72l7 7.5a1.5 1.5 0 0 1-1.1 2.5H6.1A1.5 1.5 0 0 1 5 75.5z" />
        <path class="keys ln" d="M17 71.3h62" />
        <rect class="sn" x="41" y="73.8" width="14" height="2.2" rx="1" />
      </>
    ),
    pulse: "M31 42h8l3.5-9 7 18 3.5-9h11",
  },
  desktop: {
    body: () => (
      <>
        <path class="bt" d="M43 58h10l1.5 8.5h-13z" />
        <rect class="bt" x="34" y="66" width="28" height="2.6" rx="1.3" />
        <rect class="bz e" x="9.5" y="8" width="77" height="50" rx="3.5" />
        <rect class="sc" x="12.5" y="11" width="71" height="42" rx="1.5" />
        <rect class="bz" x="33" y="88.5" width="30" height="2" rx="1" />
        <rect class="mt" x="27" y="73.5" width="42" height="15" rx="5" />
        <circle class="pl" cx="61.5" cy="81" r="2.6" />
        <circle class="sc" cx="61.5" cy="81" r="1.5" />
      </>
    ),
    pulse: "M30 32h8l4-10 8 20 4-10h12",
  },
  server: {
    body: () => (
      <>
        <rect class="pl e" x="11.5" y="14" width="73" height="15" rx="3.5" />
        <rect class="pl e" x="11.5" y="33" width="73" height="30" rx="3.5" />
        <rect class="pl e" x="11.5" y="67" width="73" height="15" rx="3.5" />
        <circle class="sc" cx="19.5" cy="21.5" r="1.8" />
        <circle class="sc" cx="19.5" cy="41" r="1.8" />
        <circle class="sc" cx="19.5" cy="74.5" r="1.8" />
        <circle class="sn" cx="19.5" cy="48" r="1.8" />
        <path class="vent ln" d="M56 19h22M56 24h22M71 41h8M71 48h8M71 55h8M56 72h22M56 77h22" />
        <rect class="sc" x="28" y="38" width="38" height="20" rx="2.5" />
      </>
    ),
    pulse: "M33.5 48h5.5l2.5-6 5 12 2.5-6h8",
  },
  "apple-watch": {
    body: () => (
      <>
        <rect class="sn" x="36.5" y="3" width="23" height="24" rx="5" />
        <rect class="sn" x="36.5" y="69" width="23" height="24" rx="5" />
        <rect class="mt" x="66.5" y="35" width="4" height="9" rx="1.8" />
        <rect class="bt" x="66.5" y="49" width="2.6" height="10" rx="1.2" />
        <rect class="bz em" x="29.5" y="21" width="37" height="54" rx="12" />
        <rect class="sc" x="33" y="24.5" width="30" height="47" rx="9" />
      </>
    ),
    pulse: "M38.5 48h4l2.5-7 5 14 2.5-7h5",
  },
  "wear-watch": {
    body: () => (
      <>
        <rect class="sn" x="37" y="3" width="22" height="26" rx="5" />
        <rect class="sn" x="37" y="67" width="22" height="26" rx="5" />
        <rect class="bt" x="72" y="44.5" width="4.4" height="7" rx="1.6" />
        <circle class="bz e" cx="48" cy="48" r="25" />
        <circle class="sc" cx="48" cy="48" r="20.5" />
      </>
    ),
    pulse: "M37.5 48h4.5l2.5-7 5 14 2.5-7h6",
  },
  headset: {
    body: () => (
      <>
        <path class="strap ln" d="M11 42c-7 2-7 14 0 16M85 42c7 2 7 14 0 16" />
        <rect class="pl em" x="9.5" y="31" width="77" height="36" rx="18" />
        <rect class="sc" x="14.5" y="36" width="67" height="26" rx="13" />
        <path class="pl" d="M41 68q7-12 14 0z" />
      </>
    ),
    pulse: "M34 48h6l3-7 6 14 3-7h8",
  },
  board: {
    body: () => (
      <>
        <rect class="mt" x="78" y="29" width="11" height="11" rx="1" />
        <rect class="mt" x="78" y="43" width="11" height="11" rx="1" />
        <rect class="bt" x="78" y="58" width="11" height="12" rx="1" />
        <rect class="e" x="8.5" y="21" width="74" height="54" rx="4" fill={PCB} />
        <rect class="bz" x="18" y="25.5" width="46" height="6" rx="1" />
        <path d="M20 28.5h42" fill="none" stroke={GOLD} stroke-width="2.2" stroke-dasharray="2 2.2" />
        {[[13.5, 26], [13.5, 70], [71, 26], [71, 70]].map(([cx, cy]) => (
          <circle class="bz" cx={cx} cy={cy} r="1.6" stroke={GOLD} stroke-width="0.8" />
        ))}
        <rect class="sc" x="22" y="38" width="32" height="26" rx="2" />
        <rect class="bz" x="60" y="40" width="11" height="8" rx="1" />
        <rect class="bz" x="60" y="53" width="11" height="8" rx="1" />
      </>
    ),
    pulse: "M27 51h5l2.5-6 5 12 2.5-6h7",
  },
  browser: {
    body: () => (
      <>
        <rect class="pl e" x="5.5" y="15" width="85" height="66" rx="6" />
        <circle class="bt" cx="13.5" cy="22.5" r="1.9" />
        <circle class="bt" cx="19.5" cy="22.5" r="1.9" />
        <circle class="bt" cx="25.5" cy="22.5" r="1.9" />
        <path class="sn" d="M33 29v-6a3 3 0 0 1 3-3h20a3 3 0 0 1 3 3v6z" />
        <rect class="sn" x="9.5" y="29" width="77" height="9" rx="2" />
        <rect class="bz" x="14" y="31.2" width="58" height="4.6" rx="2.3" />
        <rect class="sc" x="9.5" y="41" width="77" height="36" rx="3" />
      </>
    ),
    pulse: "M30 59h8l4-9 8 18 4-9h12",
  },
  unknown: {
    body: () => (
      <>
        <rect class="pl e" x="26.5" y="6" width="43" height="84" rx="9" />
        <rect class="sc" x="31" y="13" width="34" height="64" rx="3" />
        <rect class="bt" x="43" y="82.5" width="10" height="2" rx="1" />
      </>
    ),
    pulse: "M37.5 45h4.5l3-7.5 5.5 15 3-7.5h5",
  },
};

export function DeviceArt({
  kind,
  status,
  busy,
  simulator,
  size = 76,
}: {
  kind: DeviceArtKind;
  status: "online" | "stale" | "offline";
  busy?: boolean;
  simulator?: boolean;
  size?: number;
}) {
  const art = ART[kind] ?? ART.unknown;
  const cls = ["dev-art", status, busy ? "busy" : "", simulator ? "simulator" : ""].filter(Boolean).join(" ");
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      {art.body()}
      {status === "online" && <path class="pulse" d={art.pulse} />}
    </svg>
  );
}
