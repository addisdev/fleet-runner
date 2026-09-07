// The device outlines every figure shares, drawn in the mark's language: a
// rounded outline, the pulse trace, and nothing else. Each symbol is 64×72
// and is used with <use href="#dev-…">. Injected as a hidden <svg> so the
// figures are plain HTML files with no build step.
//
// The pulse is the mark's own path, translated so its bounding box is 11×11
// starting at the origin, then scaled per device.
const PULSE = "M0 5.4h2.6l1.9-5.4 2.9 11 2-5.6h1.6";

function pulse(x, y, s) {
  return `<path class="l-pulse" transform="translate(${x} ${y}) scale(${s})" d="${PULSE}" vector-effect="non-scaling-stroke"/>`;
}

const symbols = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <!-- A phone running the Android runner: a camera dot, square-ish corners. -->
    <symbol id="dev-android" viewBox="0 0 64 72">
      <rect class="l-device" x="14" y="4" width="36" height="64" rx="6"/>
      <circle cx="32" cy="10" r="1.6" fill="var(--muted)"/>
      ${pulse(21, 30, 2)}
      <path class="l-device" d="M27 61h10"/>
    </symbol>
    <!-- A phone running the iOS runner: the notch, rounder corners. -->
    <symbol id="dev-iphone" viewBox="0 0 64 72">
      <rect class="l-device" x="14" y="4" width="36" height="64" rx="9"/>
      <rect x="26" y="8" width="12" height="3" rx="1.5" fill="var(--muted)"/>
      ${pulse(21, 30, 2)}
      <path class="l-device" d="M25 62h14"/>
    </symbol>
    <symbol id="dev-tablet" viewBox="0 0 64 72">
      <rect class="l-device" x="6" y="4" width="52" height="64" rx="6"/>
      ${pulse(19.5, 29, 2.3)}
      <circle cx="32" cy="62" r="1.8" fill="var(--muted)"/>
    </symbol>
    <!-- A TV stick: what a headless Android device on the shelf looks like. -->
    <symbol id="dev-tv" viewBox="0 0 64 72">
      <rect class="l-device" x="4" y="26" width="48" height="20" rx="6"/>
      <path class="l-device" d="M52 36h6"/>
      ${pulse(16, 30.5, 1)}
      <path class="l-device" d="M34 36h10"/>
    </symbol>
    <symbol id="dev-watch" viewBox="0 0 64 72">
      <rect class="l-device" x="16" y="18" width="32" height="36" rx="8"/>
      <path class="l-device" d="M24 18v-8h16v8M24 54v8h16v-8"/>
      ${pulse(23.5, 28, 1.55)}
    </symbol>
    <!-- A laptop: the machine runner, and also the host executor's Mac. -->
    <symbol id="dev-laptop" viewBox="0 0 64 72">
      <rect class="l-device" x="10" y="16" width="44" height="30" rx="3"/>
      <path class="l-device" d="M4 52h56M4 52a3 3 0 0 0 3 3h50a3 3 0 0 0 3-3"/>
      ${pulse(23, 24, 1.6)}
    </symbol>
    <!-- A browser window: the runner-web tab. -->
    <symbol id="dev-browser" viewBox="0 0 64 72">
      <rect class="l-device" x="6" y="14" width="52" height="44" rx="4"/>
      <path class="l-device" d="M6 24h52"/>
      <circle cx="12" cy="19" r="1.5" fill="var(--muted)"/>
      <circle cx="17.5" cy="19" r="1.5" fill="var(--muted)"/>
      <circle cx="23" cy="19" r="1.5" fill="var(--muted)"/>
      ${pulse(23, 34, 1.6)}
    </symbol>
    <!-- Arrowheads in the two line colours. -->
    <marker id="arrow-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="var(--amber)"/>
    </marker>
    <marker id="arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="var(--muted)"/>
    </marker>
  </defs>
</svg>`;

document.body.insertAdjacentHTML("afterbegin", symbols);
