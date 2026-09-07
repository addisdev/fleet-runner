# Brand

Two colours, one mark, one type pairing. Written down so the next asset matches
the last one.

## Colour

| | Hex | Where |
|---|---|---|
| **Charcoal** | `#1C2025` | Every ground: the app icon tile, the dashboard, the social card, the diagram |
| **Amber** | `#E3A44A` | The mark's strokes, accents, and links on dark |
| **Amber, dark-on-light** | `#B8791F` | Links and accents on a light ground, where `#E3A44A` fails contrast |

Amber is the only accent. If something needs a second colour, it is either
semantic (a pass, a warning, a failure) or it does not need a second colour.

## The mark

A phone outline with a pulse trace through it, and a home-bar tick below. It
reads at 16 px, which is the constraint it was drawn to — the favicon is the
same line at a quarter of the size, not a different drawing.

| File | What it is | Use for |
|---|---|---|
| `img/mark.svg` | The mark on a rounded charcoal tile | Documents, favicons, anywhere it sits on an unknown ground |
| `img/mark-mono.svg` | Strokes only, `currentColor`, no tile | On a coloured header — it inherits the foreground. This is the docs-site logo |
| `img/icon-source.svg` | Full-bleed square, no rounded corners | The source both app icons are rendered from |
| `collector/dash/public/favicon.svg` | The pulse alone at 16 px | The dashboard tab |

!!! warning "App icons must not round their own corners"

    iOS and Android both apply their own mask. A source that is already rounded
    gets rounded twice and reads as a smaller, oddly inset icon.
    `icon-source.svg` is square and full-bleed for exactly this reason, and the
    rendered PNG carries **no alpha channel**, which iOS rejects outright.

## Type

| Role | Face | Notes |
|---|---|---|
| Display | Bricolage Grotesque | The social card and headings on generated assets |
| Body | IBM Plex Sans | |
| Mono | IBM Plex Mono | Metrics, device ids, hashes, chips |

The docs site uses Inter and JetBrains Mono, which is what Material ships and
what its layout is tuned for. Generated assets use the pairing above, from the
copies in `assets/fonts/` — both families are SIL OFL, and
[`assets/fonts/NOTICE.md`](https://github.com/addisdev/fleet-runner/blob/main/docs/assets/fonts/NOTICE.md)
says so properly.

Numbers that line up in a column get `font-variant-numeric: tabular-nums`. A
benchmark table where the digits do not align is harder to read than one with
fewer digits in it.

## The assets, and how they are made

Everything is rendered from source rather than drawn by hand, so it can be
regenerated when the mark changes.

The figures — the banner, the social card, the architecture diagram — are
HTML files in [`docs/assets/`](https://github.com/addisdev/fleet-runner/tree/main/docs/assets),
one per figure, each an inline SVG on the brand's tokens from `assets/brand.css`
with the device outlines from `assets/symbols.js`. `npm run assets` in
`collector/` opens each one in headless Chromium and screenshots it at 2× into
`docs/img/`; `-- --only banner` does one. Playwright is already a collector
dependency, so nothing new is installed.

| Asset | Size | Source |
|---|---|---|
| `img/banner.png` | 2560×1280 | `assets/banner.html` |
| `img/social-preview.png` | 2560×1280 (2× of GitHub's 1280×640) | `assets/social-preview.html` |
| `img/architecture.png` | 2560×1280 | `assets/architecture.html` |
| `img/lifecycle.png` | 2560×1360 | `assets/lifecycle.html` |
| `img/protocol.png` | 2560×1120 | `assets/protocol.html` |
| `img/workloads.png` | 2560×1200 | `assets/workloads.html` |
| `img/platforms.png` | 2560×1400 | `assets/platforms.html` |
| `img/first-result.png`, `alerts.png`, `visual.png` | 1440 wide | `npm run shoot:dash` |
| `img/fanout.gif` | 1280 wide, 18 s | `npm run shoot:motion` |
| `img/shelf-banner.jpg`, `shelf-social.jpg` | 2560×1280, JPEG | `assets/shelf-banner.html`, `assets/shelf-social.html` — **skipped until [the photograph](#the-shelf-photograph) exists** |
| `img/overview.png`, `devices.png`, `jobs.png`, `results.png` | | Dashboard pages, captured with Playwright against a running collector |
| `img/runner-web.png` | | `npm run shoot:runner-web`, against a throwaway collector |
| `runner-ios/.../AppIcon.appiconset/icon-1024.png` | 1024×1024, no alpha | `img/icon-source.svg` |
| `runner-android/.../mipmap*/ic_launcher.xml` | vector | Drawn as Android vector drawables from the same geometry |

**Every figure carries its own charcoal ground** because it is meant to be
dropped onto surfaces this repository does not control — the README in
GitHub's light theme, a portfolio page, a slide. That is also why they are PNG
rather than SVG: GitHub serves an SVG through a proxy as an image, so its web
fonts never load and the text falls back to whatever the reader has installed.
A PNG rendered with the self-hosted faces in `assets/fonts/` is the same on
every machine and in CI.

**Nothing in a figure is smaller than 14 px at 1×.** GitHub shows the README
column at about a third of the rendered width, and 14 px doubled is the floor
for reading it there. A figure that needs more words than fit at that size is
two figures.

The diagrams are placed by hand rather than generated by mermaid because a
layout engine is for people who do not want to place boxes, and a diagram
somebody will look at for ten seconds is placed boxes. Mermaid also renders in
GitHub's own theme, which is the one thing on the page that cannot be made to
match the rest.

### The live captures

`npm run shoot:dash` and `npm run shoot:motion` in `collector/` each start a
collector on a spare port with its own data directory, start the real agents
against it, and photograph what happens. Nothing in either is seeded:

- **`first-result.png`** runs the job `getting-started.md` tells you to run,
  byte for byte, and opens the screen it tells you to open. If that guide's
  spec changes, the script has to change with it or the picture stops being of
  the thing the reader just did.
- **`alerts.png`** comes from a `self-check` that fails honestly — it asks
  whether the agent is loaded under launchd, and an agent started by hand is
  not. That is the same failure the live overview caught on 2026-09-05.
- **`visual.png`** shoots this project's own built documentation site, accepts
  those shots as the baseline, then serves the same site with a theme colour
  changed and shoots it again. The percentages on that grid are measured from
  pixels that really differ. The regression is colour-only on purpose: captures
  are full-page, so anything that changes the document's height short-circuits
  the diff to 100% with a size-changed note instead of measuring drift.
- **`fanout.gif`** records the Overview at 4 frames a second while the machine
  agent and two browser runners claim a fan-out and report back. Screenshots
  rather than a video capture, so every frame is what a viewer would have seen.

The spec `visual.png` uses is committed at
`collector/examples/web-specs/fleet-docs/shots.json`. It has to live under the
directory `playwright.config.ts` names as its `testDir`; a manifest anywhere
else means `playwright test` finds no tests and every page reports `missing`.

## The shelf photograph

Every image in this project is drawn or captured from software. The one it does
not have is a picture of the actual shelf, which is the thing the tagline
promises and the one a stranger would remember. Nothing rendered replaces it,
and nothing generated may stand in for it — an invented photograph of hardware
that does not exist would be the same lie as an invented benchmark, and this
project's whole argument is that it does not tell those.

So the file is missing on purpose, and the pipeline is built to receive it.
`assets/shelf-banner.html` and `assets/shelf-social.html` both declare
`data-requires="photo/shelf.jpg"`, so `npm run assets` skips them with a message
until the photograph exists rather than rendering a hole.

### Taking it

- **Landscape, 3:2.** Shoot at full resolution and export 2560 px wide.
- **One soft light from the side**, not from the front. Phone screens are
  mirrors, and a light in front of them photographs itself. A window at the side
  during the day is enough.
- **Expose for the screens, not for the room.** They are the brightest thing in
  the frame and the only thing that has to survive. A dark shelf with readable
  screens is the picture; a well-lit shelf with six white rectangles is not.
- **Every device on, every agent on its status screen**, with the pulse trace
  visible. All of them registered with the same collector, so if the dashboard
  is in the frame behind them, its device count agrees with what is on the
  shelf. That agreement is the kind of detail somebody checks.
- **Leave room at the bottom left.** That is where the mark, the name and the
  tagline go, over a gradient. Anything important there gets covered.
- A dark wall or a dark background suits the palette, but the figure dims and
  scrims the photograph anyway, so a plain room is fine.

### Using it

1. Save it as `docs/assets/photo/shelf.jpg`.
2. `npm run assets` in `collector/`, which now also writes
   `img/shelf-banner.jpg` and `img/shelf-social.jpg`.
3. In `README.md`, point the first image at `docs/img/shelf-banner.jpg`.
   The drawn `banner.png` stays where it is and becomes the documentation
   site's own header image.
4. Decide about the social card. `shelf-social.jpg` is the photographic version
   of `social-preview.png`; the drawn one stays the default until you prefer the
   photograph. Whichever wins has to be uploaded by hand under
   **Settings → Social preview**, because there is no API for it.

Both photographic figures render as **JPEG at quality 82**, not PNG. A drawing
is flat colour and compresses to nothing in PNG; a photograph in PNG is several
megabytes for no difference a reader can see. `data-format="jpeg"` on the figure
is what selects that.

If the type does not read against your photograph, the number to change is the
`brightness()` in each figure's `.shelf img` rule — it is doing the work that
lets off-white and amber sit on a picture at the contrast the rest of the brand
holds.

!!! warning "Two images this must never be pointed at"

    **`results.png`** shows stored llama.cpp history from a real Android phone,
    and **the Evals screen** shows the plant-ID accuracy rows. Neither can exist
    in a fresh database, so a throwaway collector would replace real
    measurements with synthetic ones. There is no Evals screenshot for exactly
    this reason: producing one would mean seeding numbers, and a number that
    gets believed and turns out to be invented costs more than a missing
    picture.

!!! note "Two of these were captured against different fleets, on purpose"

    `overview.png`, `devices.png` and `jobs.png` show a **live** two-device
    fleet — a laptop and an iPhone simulator, both running the real agents,
    with a thermal run in progress and a `self-check` correctly failing because
    the agent was started by hand rather than by launchd. They were captured
    against a throwaway collector with a fresh database, which is why the queue
    is small and the history is minutes old.

    They replaced a set showing six offline devices and a twenty-day-old queue,
    captured while the laptop was on a different network from the shelf. That
    set was honest and read as abandoned.

    **`results.png` is deliberately not from that fleet.** It shows real
    llama.cpp measurements from an SM-X930 — 125.0 prefill and 47.4 decode
    tok/s on a Dimensity 9400 — which is stored history a fresh database cannot
    have, and it is the front-page image. Do not regenerate it against a
    throwaway collector.

    To retake the live three, run a collector on a spare port with its own data
    directory, point the machine runner and a simulator at it, enqueue a
    fan-out benchmark and a `thermal` job, and capture `/dash`,
    `/dash/devices` and `/dash/jobs` at 1440×900 with `colorScheme: "dark"`.

## Voice

The project's writing has one rule that matters more than any style guide:
**say what is not true yet.** Every workload page ends with what that workload
refuses to do, every README has a "what works and what does not", and the
integration guide says on its first screen that the GitHub Actions path has
never run on a real runner.

That is not modesty. A number that gets believed and turns out to be wrong
costs more than one that was never reported.
