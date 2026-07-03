# Permissions justification — for CWS reviewer notes

Paste this verbatim into the "Single purpose & permissions" section of the CWS submission. Reviewers care about: (a) you only ask for what you use, (b) you can show where each permission is consumed in code, (c) the broad ones have a tight justification.

---

**Single purpose:** Automatically delete browser cookies when the user closes a tab on a non-whitelisted site, replacing the discontinued Cookie AutoDelete (MV2) extension.

## Required permissions

**`cookies`** — read and delete cookies. Called in `background.js` via `chrome.cookies.getAll()` and `chrome.cookies.remove()`. This is the core capability of the extension; no replacement.

**`tabs`** — detect when the user closes or navigates away from a tab so we can clean the matching cookies. Called via `chrome.tabs.onRemoved`, `chrome.tabs.onUpdated`, `chrome.tabs.query()`. We never read tab content; we use `tab.url` solely to extract the hostname.

**`storage`** — persist the user's whitelist, greylist, and preferences in `chrome.storage.sync` (cross-device) and the activity log + counters in `chrome.storage.local` (per-device). No data is sent to any external server.

**`alarms`** — schedule the periodic sweep of cookies for sites with no open tabs, and the daily reset of the toolbar counter. Created via `chrome.alarms.create('scheduled-cleanup', ...)` and `chrome.alarms.create('daily-reset', ...)`.

**`contextMenus`** — provide the right-click "Whitelist this site" and "Clean this site now" entries. Registered in `chrome.contextMenus.create()`.

**`scripting`** — used by `chrome.scripting.executeScript()` in `background.js` (via `lib/rating-widget.js`) to inject a small in-page UI element that asks the user, after a successful manual cleanup, whether they'd like to rate the extension. The widget is rendered inside a Shadow DOM, contains no remote code, and is only injected after explicit user action (force-clean). It does not read page DOM or page data.

## Host permission

**`<all_urls>`** — required by `chrome.cookies.getAll()` and `chrome.cookies.remove()` to access cookies from any visited domain. This permission is **not used to read page content**. The extension contains no content scripts, no `webRequest` listener, and no DOM access.

## Optional permission

**`browsingData`** — listed under `optional_permissions`. Requested at runtime via `chrome.permissions.request()` only when the user explicitly enables LocalStorage, IndexedDB, or cache cleanup in Settings (or accepts the prompt in the welcome flow). Until granted, those features are disabled and the extension cleans cookies only. This gives users a granular consent flow rather than requesting the permission at install time.

## What the extension explicitly does NOT do

- No static content scripts (verify: manifest has no `content_scripts`). The only programmatic injection is the rating widget described above, which contains no remote code and never reads page content.
- No `webRequest` or network interception
- No `history` permission
- No remote code execution; no `<script src="https://...">` anywhere; all code shipped in the package is bundled and inspectable.
- No analytics, telemetry, or third-party calls — verify with the Network tab on the extension's own pages
- No accounts, no auth flow, no remote storage

## Project page

https://extkit.dev/cookieflush
