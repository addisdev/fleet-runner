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
what its layout is tuned for. Generated assets use the pairing above.

Numbers that line up in a column get `font-variant-numeric: tabular-nums`. A
benchmark table where the digits do not align is harder to read than one with
fewer digits in it.

## The assets, and how they are made

Everything is rendered from source rather than drawn by hand, so it can be
regenerated when the mark changes.

| Asset | Size | Source |
|---|---|---|
| `img/social-preview.png` | 2560×1280 (2× of GitHub's 1280×640) | An HTML page rendered headless |
| `img/architecture.svg` | 1364×450 | The mermaid source in `index.md`, exported and given its own charcoal ground |
| `img/banner.png` | | The README banner |
| `img/first-result.png` | | The Results screen after one synthetic benchmark on a laptop |
| `img/overview.png`, `devices.png`, `jobs.png`, `results.png` | | Dashboard pages, captured with Playwright against a running collector |
| `runner-ios/.../AppIcon.appiconset/icon-1024.png` | 1024×1024, no alpha | `img/icon-source.svg` |
| `runner-android/.../mipmap*/ic_launcher.xml` | vector | Drawn as Android vector drawables from the same geometry |

**`architecture.svg` carries its own background** because it is meant to be
dropped onto surfaces this repository does not control — a portfolio page, a
blog post, a slide. Its labels are light, so without a ground it would be
invisible on white. The mermaid source in the docs stays a mermaid block, which
the site themes correctly on its own.

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
