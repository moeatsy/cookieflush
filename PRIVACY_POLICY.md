# CookieFlush Privacy Policy

_Last updated: 2026-05-17_

CookieFlush is a Chrome extension that auto-deletes cookies when you close
tabs. **It collects no personal data, runs no analytics, and contacts no
remote servers.**

## What data CookieFlush stores

CookieFlush stores **only** the following, locally on your device, with
optional sync via Chrome's `storage.sync` (Google's infrastructure — never
ours):

- Your whitelist & greylist of domains
- Your preferences (cleanup intervals, what extra data to clean, etc.)
- A local deletion log (capped at 200 entries) of `{ timestamp, domain, count }`
- Aggregate counter of total cookies cleaned

No URLs you visit, page contents, search queries, form data, or identifiable
information are ever read, stored, or transmitted.

## Permissions

CookieFlush requests these Chrome permissions:

- **cookies** — read & delete cookies (the whole point of the extension)
- **tabs** — detect tab open/close/navigation events
- **storage** — persist your whitelist and settings
- **alarms** — schedule periodic cleanup
- **contextMenus** — provide the right-click "Whitelist this site" entry
- **scripting** — used once, after a successful manual cleanup, to display a small in-page rating prompt. The prompt is rendered in an isolated Shadow DOM, contains no remote code, and never reads page content
- **browsingData** — optional LocalStorage / IndexedDB / cache cleanup
- **`<all_urls>` (host permission)** — required by the `chrome.cookies` API
  to access cookies from any visited domain. CookieFlush does **not** read
  page content, history, or any other user data with this permission.

## Third-party services

None. CookieFlush has no backend, no analytics SDKs, and no third-party
scripts. The extension itself makes no outbound network requests; the only
network activity it can cause is opening a new tab to the Chrome Web Store
review page if you choose to leave a rating after a successful cleanup —
and only when you explicitly click that button.

## Sync

If you are signed into Chrome and have sync enabled, your whitelist and
preferences sync across devices via Chrome's built-in `storage.sync` API.
This is the same mechanism Chrome uses to sync your bookmarks; the data
flows through Google's servers, never through CookieFlush servers (we have
none).

## Changes

If this policy changes materially, the new version will be published at
https://extkit.dev/cookieflush/policy with a new "Last updated" date.

## Contact

Contact us via the project's support page at https://extkit.dev/cookieflush.
