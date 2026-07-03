Cookie AutoDelete stopped working in Chrome in late 2024 — leaving 100,000+ users without a way to automatically clean tracking cookies. CookieFlush is the modern Manifest V3 replacement. Same core idea: when you close a tab, cookies from that site get deleted. Sites you whitelist (banks, email, GitHub) stay logged in.


★ How it works
─────────────

1. Install CookieFlush. The welcome page asks for 3 sites you want to stay signed in to.
2. Browse normally — cookies for every other site get cleaned the moment you close that site's last tab.
3. Need temporary protection? Greylist the site for a few days. Need to clean right now? Click the toolbar icon → "Clean now".

No accounts. No telemetry. No remote servers. Open source.


★ Key features
──────────────

✅ Auto-delete on tab close — the moment a site's last tab is gone, its cookies are too
✅ Whitelist trusted sites — banks, email, code hosts stay logged in
✅ Greylist for temporary protection — auto-expires after 7 days (configurable)
✅ Scheduled sweep — periodically clears closed-but-still-tracking sites
✅ LocalStorage + IndexedDB + cache cleanup — free, no premium tier
✅ Cross-device sync — whitelist syncs via your Chrome account
✅ Right-click whitelist — protect any site in one click
✅ Keyboard shortcuts — Alt+Shift+W whitelist, Alt+Shift+X force clean, Alt+Shift+C toggle
✅ Activity log — see what was cleaned, when, on this device
✅ Daily counter badge — quiet indicator that the extension is working
✅ Dark + light themes via prefers-color-scheme
✅ Export/import config — bring your setup to a new machine in seconds
✅ Open source — fully inspectable


★ Why CookieFlush
─────────────────

Future-proof. Built natively for Manifest V3. Won't get disabled by Chrome the way older MV2 extensions were.

Free, including LocalStorage cleanup. Other cookie cleaners charge for LocalStorage / IndexedDB cleanup as a premium upsell. CookieFlush includes it free, gated behind a just-in-time Chrome permission so you only grant what you need.

Privacy-first. No telemetry, no analytics, no third-party scripts, no servers. CookieFlush itself makes no outbound network requests — it talks to Chrome's local cookie API only. The single exception is fully under your control: if you choose to rate the extension after a successful cleanup, clicking the rating button opens a Chrome Web Store tab.

Settings sync. Whitelist and preferences sync across all your Chrome installations via Chrome's storage.sync API (Google's servers, which you already trust — not ours, because we don't have any).

Minimal, explained permissions. CookieFlush only requests what it needs:
• cookies — to read and auto-delete cookies (the whole point)
• tabs — to know when tabs close or change site
• storage — to save your whitelist and preferences
• alarms — to schedule the periodic sweep
• contextMenus — for the right-click "Whitelist" entry
• scripting — to show an in-page rating prompt after a successful cleanup; never reads page content
• <all_urls> — required by chrome.cookies to touch cookies from any visited site
• browsingData — OPTIONAL, requested only the first time you enable LocalStorage cleanup

We're transparent about <all_urls>: it's needed because cookies live across all sites. CookieFlush does NOT read page content, browsing history, or any other user data. The permission scope is broad; the actual data access is narrow (cookies only). Source code is open — verify it yourself.


★ Who it's for
──────────────

• Cookie AutoDelete refugees needing a working MV3 replacement
• Privacy-conscious users tired of tracking
• Power users who want granular cookie control without the noise
• Developers and security testers who need fast, repeated cookie clearing


★ FAQ
─────

Q: What happened to Cookie AutoDelete?
A: It was Manifest V2. Chrome disabled all MV2 extensions in late 2024. CookieFlush is built for the new MV3 architecture and won't get disabled.

Q: Will this log me out of my sites?
A: Only sites you haven't whitelisted. Whitelist your bank, email, GitHub, etc. — their cookies are preserved. The welcome page walks you through your first three.

Q: Whitelist vs greylist?
A: Whitelist = permanent until you remove. Greylist = temporary protection that auto-expires (7 days by default). Greylist is great for shopping or research you'll abandon.

Q: Does it delete cookies while I'm using the site?
A: No. Cookies only get cleaned when you close the tab (or navigate away, if you turn that mode on). Active sessions are never disturbed.

Q: Why the <all_urls> permission?
A: Cookies can come from any site, so Chrome's cookie API needs access to all URLs. CookieFlush does NOT read page content or browsing history — only cookies. Source code is public.

Q: What's the difference from Chrome's built-in "Clear cookies on exit"?
A: Chrome's option clears everything when you fully quit the browser. CookieFlush deletes per-tab — far more granular. Plus Chrome has no whitelist (all-or-nothing).

Q: Does it work on Edge / Brave / Opera?
A: Yes — all Chromium-based browsers. Brave: sync uses Brave's account instead of Chrome's.

Q: Will you add a paid tier?
A: Not in v1. Everything is free. If a paid tier ever ships, it'll be advanced features (E2E-encrypted sync, etc.) and existing features stay free.


★ Roadmap
─────────

• 52 community-translated languages
• Firefox port
• Per-tab cookie inspector for debug
• Optional cookie consent banner auto-rejection
