// Empty-state drawings.
//
// A panel with nothing in it is a state worth drawing, not a gap to apologise
// for — and the four that matter are different states, not one "no data":
// the fleet being idle is good news, no results yet is a beginning, and no
// device matching a filter is a filter problem. Each gets its own picture and
// keeps the sentence the dashboard already printed underneath it.
//
// Same drawing language as icons.tsx: stroke on a flat ground, theme colours
// through CSS classes (never a hard-coded fill except the brand amber, which
// is a brand colour rather than a theme one), and no illustration bigger than
// the paragraph it introduces.
import type { ComponentChildren } from "preact";

function Art({ children, caption }: { children: ComponentChildren; caption: ComponentChildren }) {
  return (
    <div class="empty-art">
      {children}
      <p>{caption}</p>
    </div>
  );
}

/**
 * Nothing claimed — the shelf is powered and waiting.
 *
 * The middle phone's pulse draws every few seconds. Idle is not the same as
 * dead, and a completely still drawing would say the wrong one.
 */
export function ArtIdle({ caption }: { caption: ComponentChildren }) {
  return (
    <Art caption={caption}>
      <svg viewBox="0 0 260 150" role="img" aria-label="Three phones on a shelf, waiting for work">
        <path class="art-shelf" d="M24 126h212" />
        <rect class="art-body" x="52" y="52" width="40" height="72" rx="6" />
        <rect class="art-screen" x="58" y="59" width="28" height="52" rx="2" />
        <path class="art-flat" d="M60 85h24" />
        <rect class="art-body" x="110" y="44" width="40" height="80" rx="6" />
        <rect class="art-screen" x="116" y="51" width="28" height="60" rx="2" />
        <path class="art-flat" d="M118 81h26" />
        <path class="art-pulse blip" d="M118 81h6l3-8 5 16 3-8h9" />
        <rect class="art-body" x="168" y="58" width="40" height="66" rx="6" />
        <rect class="art-screen" x="174" y="65" width="28" height="46" rx="2" />
        <path class="art-flat" d="M176 88h24" />
      </svg>
    </Art>
  );
}

/**
 * No device here — either the shelf is empty or the filters exclude everything.
 * The enrolment QR pointing at an outline is the actual fix in both cases.
 */
export function ArtNoDevices({ caption }: { caption: ComponentChildren }) {
  return (
    <Art caption={caption}>
      <svg viewBox="0 0 260 150" role="img" aria-label="An enrolment code beside an empty device outline">
        <path class="art-shelf" d="M24 126h212" />
        <rect class="art-body ghost" x="150" y="46" width="42" height="78" rx="6" />
        <path class="art-flat" d="M165 118h12" stroke-dasharray="4 3" />
        <g>
          <rect x="62" y="62" width="52" height="52" rx="4" fill="#f7f8fa" />
          <g fill="#1c2025">
            <rect x="68" y="68" width="12" height="12" />
            <rect x="96" y="68" width="12" height="12" />
            <rect x="68" y="96" width="12" height="12" />
            <rect x="84" y="70" width="3" height="3" />
            <rect x="89" y="74" width="3" height="3" />
            <rect x="84" y="80" width="3" height="3" />
            <rect x="86" y="86" width="3" height="3" />
            <rect x="92" y="88" width="3" height="3" />
            <rect x="98" y="86" width="3" height="3" />
            <rect x="103" y="92" width="3" height="3" />
            <rect x="96" y="98" width="3" height="3" />
            <rect x="100" y="104" width="3" height="3" />
            <rect x="90" y="100" width="3" height="3" />
            <rect x="86" y="106" width="3" height="3" />
            <rect x="72" y="86" width="3" height="3" />
            <rect x="78" y="90" width="3" height="3" />
          </g>
          <g fill="#f7f8fa">
            <rect x="71" y="71" width="6" height="6" />
            <rect x="99" y="71" width="6" height="6" />
            <rect x="71" y="99" width="6" height="6" />
          </g>
        </g>
        <path class="art-flat" d="M122 88h20" />
        <path class="art-flat" d="M138 83l5 5-5 5" />
      </svg>
    </Art>
  );
}

/**
 * Nothing failed. A flat trace running into a tick — the same pulse the mark
 * uses, ending well.
 */
export function ArtAllClear({ caption }: { caption: ComponentChildren }) {
  return (
    <Art caption={caption}>
      <svg viewBox="0 0 260 150" role="img" aria-label="A steady trace ending in a tick">
        <path class="art-pulse" d="M28 86h58l10-26 16 52 10-26h34" />
        <circle cx="186" cy="86" r="22" class="art-ok" />
        <path class="art-ok check" d="M176 86.5l7 7 13-14" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </Art>
  );
}

/**
 * No results yet. Dotted bars in the accent: the chart that will be here, not
 * a chart of nothing — a solid empty chart would read as a measurement of zero.
 */
export function ArtNoResults({ caption }: { caption: ComponentChildren }) {
  return (
    <Art caption={caption}>
      <svg viewBox="0 0 260 150" role="img" aria-label="Outlined bars waiting to be filled by results">
        <path class="art-flat" d="M40 122h180" />
        <path class="art-flat" d="M40 92h180M40 62h180" stroke-dasharray="2 4" stroke-width="1" />
        <rect class="art-bar" x="64" y="70" width="26" height="52" rx="3" />
        <rect class="art-bar" x="104" y="52" width="26" height="70" rx="3" />
        <rect class="art-bar" x="144" y="84" width="26" height="38" rx="3" />
        <rect class="art-bar" x="184" y="66" width="26" height="56" rx="3" />
      </svg>
    </Art>
  );
}
