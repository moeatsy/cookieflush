# Chrome Web Store screenshots — spec

5 screenshots, each **1280 × 800 px** PNG, ≤ 5 MB. Shown left-to-right in CWS listing. First one is the hero (also rendered as preview in search/category grids — design accordingly).

## #1 — Popup hero shot (the one users see in their browser)

**Goal:** "this is what one click looks like."

```
┌─────────────────────────────────────────────────┐
│  (mock Chrome browser chrome, dark bg)         │
│                                                 │
│         ┌─ POPUP (380px) ──────────┐            │
│         │ Brand        [toggle]   │            │
│         │ ─────────────────────── │            │
│         │ WILL CLEAN ON CLOSE     │            │
│         │ gmail.com               │            │
│         │ [Whitelist this site]   │            │
│         │ [Greylist] [Clean now]  │            │
│         │ 1,247  cleaned  12 ...  │            │
│         └─────────────────────────┘            │
│                                                 │
│  ┌─ Overlay text top-left (32px, white, bold) ┐│
│  │ ONE CLICK.                                  ││
│  │ TRUSTED SITES STAY LOGGED IN.               ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

Composition tips:
- Browser chrome on dark — popup pops on light, sells the design
- Toolbar icon visible (with a "12" badge counter — proves the daily-counter feature exists)
- Slight perspective tilt (~5°) optional — Raycast-style

## #2 — Before / After cookies

**Goal:** "what actually happens."

```
LEFT half (label: "Without CookieMaid") — Chrome devtools cookies tab
   with ~80 rows of tracking cookies (mock data: doubleclick, _ga, ...).
RIGHT half (label: "After 1 hour with CookieMaid") — same tab, 6 rows
   left (whitelisted sites only).

Overlay text bottom: "Cookies clear themselves. You don't think about it."
```

## #3 — Settings page

**Goal:** "full control if you want it."

```
Options page screenshot showing:
- Sidebar nav visible (Behavior / Storage / Whitelist / ...)
- Behavior section open with the 3 toggles
- Whitelist section partially visible with 6-8 mock domains

Overlay top: "Granular control. Sync across devices."
```

## #4 — Privacy diagram

**Goal:** "nothing leaves your machine."

```
Diagram (vector, not screenshot):
  Browser → CookieMaid (inside dashed "your device" box) → drain
  NO arrow to any cloud / server. Mark a faded silhouette of a cloud
  with strikethrough.

Overlay center: "100% local. No servers. No telemetry."
Below: small caption "Open source — verify yourself."
```

## #5 — Comparison table

**Goal:** "why pick this one."

```
2-column table:
                       | CookieMaid | Chrome built-in |
Auto-clean on tab close|    ✓        |        —        |
Per-domain trigger     |    ✓        |  on browser quit|
LocalStorage cleanup   |    Free     |        —        |
Cross-device sync      |    ✓        |        ✓        |
Per-site whitelist     |    ✓        |        —        |
Open source            |    ✓        |        —        |
MV3 native             |    ✓        |        ✓        |

Overlay top: "What you get free."
```

## Style guidance for overlays

- Font: SF Pro Display / system-ui, weight 700, 32–48px
- Color: --text-strong (#0c0d0e light bg, #f8f6f1 dark bg)
- Accent on key words via --accent
- Place in safe-zone, avoid edges 60px in
- One line ideal, two lines max

## Mockup recipe

1. Open the actual extension popup in a dark-mode Chrome
2. Screenshot at 2× (Retina) → crop to popup bounds with ~80px Chrome chrome around it
3. Place on dark canvas (1280×800, bg #0c0d0e)
4. Add overlay text in Figma / Inkscape
5. Export PNG via Squoosh.app (mozjpeg or oxipng) under 5 MB
