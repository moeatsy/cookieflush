# CookieFlush

**Auto-delete cookies when tabs close.** Manifest V3-native replacement for the discontinued Cookie AutoDelete extension.

**[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/auto-delete-cookies-on-ta/pfkgmfddjojnoekblkdgpgmehpagjflg)**

> The store listing is titled *"Auto-Delete Cookies on Tab Close — Cookie AutoDelete Alternative, Whitelist"* — same extension, CookieFlush is the product name.

- ✅ Whitelist trusted sites (banks, email, GitHub)
- ✅ Greylist for temporary protection (default 7 days)
- ✅ Scheduled sweep + cleanup on Chrome startup
- ✅ Optional LocalStorage / IndexedDB / cache cleanup — free, no premium tier, gated by just-in-time Chrome permission
- ✅ Cross-device whitelist sync via Chrome's `storage.sync`
- ✅ Daily counter badge on the toolbar icon
- ✅ Right-click "Whitelist this site"
- ✅ Keyboard shortcuts: <kbd>Alt+Shift+C</kbd> toggle, <kbd>Alt+Shift+W</kbd> whitelist, <kbd>Alt+Shift+X</kbd> force clean
- ✅ Export / import config
- ✅ Light + dark via `prefers-color-scheme`
- ✅ Open source

## Install (developer mode)

1. Clone or download this repository
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and pick the repository folder
5. The welcome page opens — pick 3 sites to whitelist, then optionally grant the LocalStorage permission

## Run the tests

```
npm install
npm test          # unit tests
npx playwright test   # e2e (loads the extension in Chromium)
```

## Design direction

**Forensic** — sober trust-first aesthetic. Off-black canvas + amber accent, system-stack typography, `ui-monospace` numerals with `tabular-nums`. No motion on popup open. Brand mark = three cookies falling into a drain.

Design system lives in `tokens.css` — CSS custom properties applied to popup, options, and welcome pages. Same tokens drive light / dark / reduced-motion via `prefers-color-scheme` and `prefers-reduced-motion`.

## File layout

```
cookieflush-extension/
├── manifest.json
├── background.js          # Service worker — cleanup logic, daily badge counter
├── tokens.css             # Design tokens (single source of truth)
├── popup.{html,js,css}    # 380px popup — hero card + single primary + stats
├── options.{html,js,css}  # Sticky-nav settings (8 sections), autosave + JIT perm gating
├── welcome.{html,js,css}  # 3-step onboarding (whitelist 3 sites → JIT perm → done)
├── icons/
│   └── {16,48,64,128}_{16,48,64,128}.png   # Toolbar / CWS icons (square, named NxN_NxN)
├── _locales/<locale>/messages.json   # en is full; other locales translate store listing only
├── store-assets/          # CWS listing assets (NOT shipped to users)
│   ├── promo_tile_440x280.png
│   ├── SHORT_DESCRIPTION.txt
│   ├── LONG_DESCRIPTION.md
│   ├── SCREENSHOTS.md
│   └── PERMS_JUSTIFICATION.md
├── README.md
└── PRIVACY_POLICY.md
```

## Permissions

| Permission        | When                                                      |
|-------------------|-----------------------------------------------------------|
| `cookies`         | Always — read & delete cookies                            |
| `tabs`            | Always — detect when tabs close / navigate                |
| `storage`         | Always — save whitelist & settings (synced)               |
| `alarms`          | Always — schedule periodic cleanup + daily badge reset    |
| `contextMenus`    | Always — right-click "Whitelist this site"                |
| `scripting`       | Always — inject the in-page rating prompt after a successful cleanup (Shadow-DOM, never reads page content) |
| `<all_urls>`      | Always — required by `chrome.cookies` API                 |
| `browsingData`    | **Optional** — requested only the first time you enable LocalStorage / IndexedDB / cache cleanup |

CookieFlush does **not** read page content, browsing history, or any user data beyond cookies. There is no telemetry, no remote server, no analytics SDK.

## Storage layout

- `chrome.storage.sync` (cross-device, ≤100KB total, 8KB/key): settings, whitelist, greylist.
- `chrome.storage.local` (per-device, no quota issues): deletion log, total cleaned, today's counter.

## Known limitations

- **Closing a tab runs a store-wide sweep (on by default, like Cookie AutoDelete).** When a tab closes, cookies for every site with no open tab and not on your whitelist are cleared — third-party trackers and partitioned (CHIPS) cookies included. **Side effect:** you get signed out of any non-whitelisted site once its tabs are closed, so whitelist anything you want to stay logged into. The whitelist matcher is suffix-based: whitelisting `google.com` protects `mail.google.com` and `accounts.google.com` automatically.
- **Prefer surgical cleanup?** Turn off **Also remove third-party cookies** in Settings. Closing a tab then removes only the closed site's own cookies plus any partitioned cookies scoped to it, leaving other sites alone.
- **Configurable grace period for the sweep.** It runs after a short delay (default 10s, adjustable from Immediately to 2 minutes) so a tab you reopen by accident keeps its cookies, and bulk tab closes coalesce into one sweep.
- **Brave / non-Chrome Chromium browsers:** sync uses the host browser's own account (Brave Sync, etc.) rather than Google's. Settings still sync within that ecosystem.

## Verifying the store build

Each Chrome Web Store release is tagged (`v1.0.10`, …). The tag contains exactly the files shipped in that store version — unpack the CRX and diff if you want to verify.

## License

[GPL-3.0](LICENSE). Forks and derived extensions must stay open source under the same license.
