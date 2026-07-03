import './lib/rating-widget.js';
import { registrableDomain } from './lib/registrable-domain.js';
import { isHostWhitelisted, planAddWildcard, planAddExact, planRemove } from './lib/whitelist.js';
import { stripWww, safeHostname } from './lib/domains.js';
import { cookiePartitionSite, cookieGoverningHost, isFirstPartyPartitioned } from './lib/cookies.js';
import { GLOBAL_RULES_KEY, rulesForHost, ruleVerdict } from './lib/cookie-rules.js';

// === STORAGE LAYOUT ===
// storage.sync  — settings + whitelist + greylist (cross-device, low write rate)
// storage.local — deletionLog + totalCleaned + cleanedToday + dayKey
// storage.local — rwUseCount + rwDone (rating widget — see lib/rating-widget.js)

const SYNC_DEFAULTS = {
  enabled: true,
  whitelist: [],       // wildcard entries: cover the host AND all its subdomains
  whitelistExact: [],  // exact entries: cover ONLY that host, not its subdomains
  greylist: {},
  greylistDurationDays: 7,
  cleanOnTabClose: true,
  cleanOnNavigation: false,
  cleanOnStartup: false,
  cleanThirdParty: true,      // default: store-wide sweep on close (3rd-party cookies, CAD-style)
  scheduledCleanupMinutes: 0,
  cleanupDelaySeconds: 10,    // debounce before the third-party sweep
  cleanLocalStorage: false,   // off by default — JIT permission in welcome flow
  cleanIndexedDB: false,
  cleanCache: false,
  cleanServiceWorkers: false, // off by default — JIT browsingData permission like the others
  enableCookieRules: false,   // advanced opt-in: per-cookie keep/delete rules (see rulesForHost)
  cookieRules: {},            // { domain: [{ name: '<pattern>', keep: true|false }] }
};

const LOCAL_DEFAULTS = {
  deletionLog: [],
  totalCleaned: 0,
  cleanedToday: 0,
  dayKey: '',                  // YYYY-MM-DD for badge reset
};

const LOG_MAX_ENTRIES = 200;
// chrome.storage.sync caps a single key at ~8 KB. Each greylist entry is
// roughly 30–40 bytes (domain + expiry timestamp), so 150 entries stay
// comfortably within the limit.
const GREYLIST_MAX_ENTRIES = 150;
// Whitelist domains are ~12–25 bytes each; 500 keeps the key well under 8 KB
// and matches the import sanitizer. Enforced at every write site.
const WHITELIST_MAX_ENTRIES = 500;
const BADGE_DISABLED_COLOR = '#dc2626';

// === RATING WIDGET ===

function ratingMsg(key, fallback) {
  try { return chrome.i18n.getMessage(key) || fallback; } catch { return fallback; }
}

const RATING_OPTS = {
  appName: ratingMsg('shortName', 'CookieFlush'),
  threshold: 5,
  scale: 'emoji',
  i18n: {
    prompt: ratingMsg('ratingPrompt', 'How is {app} working out?'),
    five: ratingMsg('ratingFive', 'Glad to hear it. A quick rating helps others find {app}.'),
    fivePrimary: ratingMsg('ratingFivePrimary', 'Leave a quick review'),
    four: ratingMsg('ratingFour', 'Thanks for the kind word.'),
    low: ratingMsg('ratingLow', 'Thanks for letting us know.'),
    thanks: ratingMsg('ratingThanks', 'Thanks for letting us know!'),
    notNow: ratingMsg('ratingNotNow', 'Maybe later'),
  },
};

async function maybeShowRating(tabId) {
  try {
    if (!globalThis.RatingWidget) return;
    let id = tabId;
    if (!id) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      id = tab?.id;
    }
    if (!id) return;
    await globalThis.RatingWidget.bg.maybeShowAfterUse(id, RATING_OPTS);
  } catch { /* tab gone, no perm, etc. */ }
}

// === UTILS ===
// stripWww / safeHostname live in lib/domains.js (imported above) so they can be
// unit-tested and reused by the cookie/whitelist modules.

// Origin-keyed storage (service workers, Cache API, IndexedDB, LocalStorage,
// FileSystem) is NOT cookie-keyed. chrome.browsingData.remove({origins}) matches
// each origin EXACTLY — no www-folding, no subdomain rollup. Cookies, by
// contrast, are keyed by registrable domain, so a `.google.com` cookie tells us
// nothing about the `https://www.google.com` origin that actually holds the
// service worker, and a `.vivaldi.net` cookie can't point us at
// `https://forum.vivaldi.net`. Clearing storage for the folded host therefore
// silently misses the real origin (the bug Stian reported). For every host we
// know was touched we expand to its bare, www., and as-seen forms in both
// schemes; the most reliable origins come from the REAL tab hostnames captured
// at close/navigation time (see pendingStorageHosts), which carry the subdomain.
function storageOrigins(hosts) {
  const out = new Set();
  for (const raw of hosts) {
    const host = (raw || '').replace(/^\./, '');
    if (!host) continue;
    const bare = stripWww(host);
    for (const h of new Set([host, bare, 'www.' + bare])) {
      out.add(`https://${h}`);
      out.add(`http://${h}`);
    }
  }
  return [...out];
}

// Maps the user's storage toggles to chrome.browsingData data types. "Cache"
// covers the HTTP cache (cache), the Cache API service workers use (cacheStorage),
// and the FileSystem API (fileSystems) — sites like mega.nz stash large blobs
// there and never clean up, so it's all "cached data" a non-whitelisted site has
// no business keeping.
function browsingDataTypes(settings) {
  const dataTypes = {};
  if (settings.cleanLocalStorage) dataTypes.localStorage = true;
  if (settings.cleanIndexedDB) dataTypes.indexedDB = true;
  if (settings.cleanCache) {
    dataTypes.cache = true;
    dataTypes.cacheStorage = true;
    dataTypes.fileSystems = true;
  }
  if (settings.cleanServiceWorkers) dataTypes.serviceWorkers = true;
  return dataTypes;
}

function anyStorageToggleOn(settings) {
  return !!(settings.cleanLocalStorage || settings.cleanIndexedDB ||
            settings.cleanCache || settings.cleanServiceWorkers);
}

// === PARTITIONED-COOKIE GOVERNANCE ===
//
// A partitioned (CHIPS) cookie only exists inside ONE top-level site's browsing
// context. A youtube.com cookie set by an embed on whosampled.com is stored with
// host_key=.youtube.com but partition (top_frame_site) https://whosampled.com.
// For whitelist + open-tab decisions that cookie belongs to whosampled, NOT
// youtube: it must be cleaned when the last whosampled tab closes, and
// whitelisting youtube.com must NOT protect it. Only when partition === host
// (youtube embedded in youtube) does the whitelist for youtube keep it.
// Unpartitioned cookies are governed by their own host, as before.
//
// cookiePartitionSite / cookieGoverningHost / isFirstPartyPartitioned live in
// lib/cookies.js (imported above) — pure and unit-tested.

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let writeQueue = Promise.resolve();
function serializeWrite(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

// === SETTINGS HELPERS ===

async function getSyncSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(SYNC_DEFAULTS));
  const merged = { ...SYNC_DEFAULTS, ...stored };
  // Defensive: a malformed import or sync from a future-version client could
  // leave whitelist/greylist as the wrong shape. Coerce here so downstream
  // .includes / Object.keys never throw on bad data.
  if (!Array.isArray(merged.whitelist)) merged.whitelist = [];
  if (!Array.isArray(merged.whitelistExact)) merged.whitelistExact = [];
  if (!merged.greylist || typeof merged.greylist !== 'object' || Array.isArray(merged.greylist)) {
    merged.greylist = {};
  }
  if (!merged.cookieRules || typeof merged.cookieRules !== 'object' || Array.isArray(merged.cookieRules)) {
    merged.cookieRules = {};
  }
  return merged;
}

// Cached so hot cleanup paths don't await chrome.permissions on every cookie.
// Kept in sync via chrome.permissions.onAdded / onRemoved listeners below.
// `bdReady` is the in-flight first refresh — callers await it once on the
// hot path so the first cleanup after SW wake doesn't silently skip
// browsingData with a stale `false`.
let hasBrowsingDataCached = false;
let bdReady = null;
async function refreshBrowsingDataCache() {
  try { hasBrowsingDataCached = await chrome.permissions.contains({ permissions: ['browsingData'] }); }
  catch { hasBrowsingDataCached = false; }
}
bdReady = refreshBrowsingDataCache();
if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => { bdReady = refreshBrowsingDataCache(); });
  chrome.permissions.onRemoved.addListener(() => { bdReady = refreshBrowsingDataCache(); });
}
async function hasBrowsingData() {
  // Capture the current bdReady into a local so a concurrent permissions
  // event reassigning bdReady can't swap the promise out from under us.
  const ready = bdReady;
  if (ready) { try { await ready; } catch {} }
  return hasBrowsingDataCached;
}

// === INSTALL / UPDATE ===

chrome.runtime.onInstalled.addListener(async (details) => {
  // Migration v1 — legacy keys
  const legacy = await chrome.storage.sync.get(['deletionLog', 'totalCleaned', 'installedAt', 'cookieAgeHours']);
  if (legacy.deletionLog || legacy.totalCleaned !== undefined) {
    await chrome.storage.local.set({
      deletionLog: Array.isArray(legacy.deletionLog) ? legacy.deletionLog : [],
      totalCleaned: typeof legacy.totalCleaned === 'number' ? legacy.totalCleaned : 0,
    });
  }
  await chrome.storage.sync.remove(['deletionLog', 'totalCleaned', 'installedAt', 'cookieAgeHours']);

  if (details.reason === 'install') {
    // Don't start deleting cookies before the user opts in — a fresh install
    // wiping a forgotten-whitelist site on first tab close reads as "the
    // extension broke my session". Welcome step 3 flips this to true.
    // Only set if absent: a developer reloading an unpacked extension also
    // fires reason='install', and we don't want to silently disable a setup
    // the user already turned on.
    const existing = await chrome.storage.sync.get('enabled');
    if (existing.enabled === undefined) {
      await chrome.storage.sync.set({ enabled: false });
    }
    chrome.tabs.create({ url: 'welcome.html' });
  }

  await ensureContextMenus();
  await rescheduleAlarm();
  await scheduleDailyReset();
  await updateBadge();
  await refreshVisibleActionIcons();
  await refreshWhitelistMenuForActiveTab();
});

// Idempotent — safe to call from onInstalled, onStartup, or after a profile
// reload. Chrome normally persists menus across restarts, but a corrupted
// profile or sync glitch can leave them missing; rebuilding on startup is
// cheap insurance.
// i18n lookup for context-menu titles with a hardcoded English fallback (and
// optional $1 substitutions). getMessage falls back to the default locale (en)
// for keys missing in the active locale, and returns '' for a wholly missing
// key — the `|| fallback` covers that.
function ctxMsg(key, subs, fallback) {
  try { return chrome.i18n.getMessage(key, subs || undefined) || fallback; }
  catch { return fallback; }
}

async function ensureContextMenus() {
  try { await chrome.contextMenus.removeAll(); } catch {}
  // Two items (whitelist + per-site clean) would otherwise auto-nest under
  // Chrome's long store name, so we group them under an explicit "CookieFlush"
  // parent. Per-site "Clean this site's cookies now" mirrors the popup button —
  // it clears only the current site and never touches other tabs' sessions.
  chrome.contextMenus.create({
    id: 'cookieflush-parent',
    title: 'CookieFlush',
    contexts: ['page', 'link'],
  });
  // Whitelist offers the same subdomain-vs-whole-domain split as the popup. Two
  // items whose titles are refreshed per active tab (see updateWhitelistMenu):
  // on a subdomain both show with the exact targets; otherwise only the first
  // shows as the generic "Whitelist this site". `whitelist-site` keeps the old
  // id so it still fires for the single-item case.
  // On a subdomain, "Whitelist all of <domain>" is shown first (the common
  // intent), then "Whitelist only <host>" — mirroring the popup's order. On an
  // apex/unresolved host, only `whitelist-site` shows as the generic entry.
  chrome.contextMenus.create({
    id: 'whitelist-domain',
    parentId: 'cookieflush-parent',
    title: 'Whitelist the whole domain',
    contexts: ['page', 'link'],
    visible: false,   // revealed only on a subdomain we can resolve
  });
  chrome.contextMenus.create({
    id: 'whitelist-site',
    parentId: 'cookieflush-parent',
    title: chrome.i18n.getMessage('ctxWhitelist') || 'Whitelist this site',
    contexts: ['page', 'link'],
  });
  chrome.contextMenus.create({
    id: 'unwhitelist-site',
    parentId: 'cookieflush-parent',
    title: ctxMsg('ctxUnwhitelist', null, 'Remove from whitelist'),
    contexts: ['page', 'link'],
    visible: false,   // shown instead of the add-items when already whitelisted
  });
  chrome.contextMenus.create({
    id: 'force-clean',
    parentId: 'cookieflush-parent',
    title: chrome.i18n.getMessage('ctxForceClean') || "Clean this site's cookies now",
    contexts: ['page'],
  });
}

// Refresh the whitelist context-menu titles for the given page URL. On a
// subdomain we can confidently resolve, both items show and name their exact
// target (this subdomain vs the registrable domain + all subdomains); otherwise
// we collapse to the single generic "Whitelist this site". Menus are global (not
// per-tab), so this reflects the last-focused tab — the click handler always
// re-derives the target from the actually-clicked tab, so a stale title can
// never whitelist the wrong host.
async function updateWhitelistMenu(url) {
  const host = stripWww(safeHostname(url || '') || '');
  const reg = host ? (registrableDomain(host) || host) : '';
  // Whitelist membership (wildcard OR exact) — NOT isWhitelisted, which also
  // counts greylist; "Remove from whitelist" must map to an actual entry.
  let onWhitelist = false;
  if (host) {
    try {
      const { whitelist = [], whitelistExact = [] } = await chrome.storage.sync.get(['whitelist', 'whitelistExact']);
      onWhitelist = whitelist.some(w => host === w || host.endsWith('.' + w)) ||
                    (Array.isArray(whitelistExact) && whitelistExact.includes(host));
    } catch {}
  }
  const set = (id, props) => chrome.contextMenus.update(id, props).catch(() => {});
  try {
    if (host && onWhitelist) {
      // Already protected → mirror the popup: offer removal, hide the add items.
      await set('unwhitelist-site', { visible: true });
      await set('whitelist-site', { visible: false });
      await set('whitelist-domain', { visible: false });
    } else if (host) {
      // Two scopes on every site: the whole domain (+ subdomains) vs only this
      // exact host. On an apex, reg === host, so the pair reads "all of cnn.com"
      // vs "only cnn.com".
      await set('unwhitelist-site', { visible: false });
      await set('whitelist-domain', { visible: true, title: ctxMsg('ctxWhitelistDomain', [reg], `Whitelist all of ${reg}`) });
      await set('whitelist-site', { visible: true, title: ctxMsg('ctxWhitelistExact', [host], `Whitelist only ${host}`) });
    } else {
      // Internal/unsupported page — show the generic (inert) entry only.
      await set('unwhitelist-site', { visible: false });
      await set('whitelist-domain', { visible: false });
      await set('whitelist-site', { visible: true, title: ctxMsg('ctxWhitelist', null, 'Whitelist this site') });
    }
  } catch {}
}

// Seed the whitelist menu titles for the current tab right after the menus are
// (re)built, so a fresh SW start shows the right split before any tab event.
async function refreshWhitelistMenuForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await updateWhitelistMenu(tab?.url);
  } catch {}
}

chrome.runtime.onStartup.addListener(async () => {
  await ensureContextMenus();
  await rescheduleAlarm();
  await scheduleDailyReset();
  await rolloverDayIfNeeded();
  await updateBadge();
  await refreshVisibleActionIcons();
  await refreshWhitelistMenuForActiveTab();
  // Prune on every startup so expired greylist entries don't accumulate
  // forever when the user has Scheduled sweep disabled.
  await pruneGreylist();
  const settings = await getSyncSettings();
  if (settings.enabled && settings.cleanOnStartup) {
    // Use the sweep (not cleanAllNonWhitelisted): on session restore Chrome
    // hands us the restored tabs with their URLs, and the sweep spares any
    // domain that still has an open tab. cleanAllNonWhitelisted ignores open
    // tabs entirely and would sign the user out of every non-whitelisted site
    // they just reopened.
    await sweepNonOpenCookies('startup-cleanup');
  }
});

// === TAB URL CACHE ===
//
// Survives SW sleep via chrome.storage.session (in-memory, cleared at browser
// restart — exactly the lifetime we want). The in-process Map is the hot
// path; the session-storage mirror is the rehydration source after the SW is
// terminated mid-session. Without it, the first onRemoved after wake fires
// with no hostname and silently skips the cleanup.

const tabUrlCache = new Map();
const SESSION_TAB_CACHE_KEY = 'tabUrlCache';

// Real (subdomain-precise) hostnames of tabs that closed or navigated away and
// are awaiting a debounced third-party sweep. The sweep deletes cookies keyed by
// registrable domain, which can't reconstruct the exact origin a service worker
// or Cache/FileSystem entry lives under (www.google.com, forum.vivaldi.net), so
// we stash the real hostnames here and clear their storage directly — even when
// the site set no first-party cookie to delete. Persisted to session storage so
// the backstop alarm (which may run in a freshly-woken SW) still sees them.
const pendingStorageHosts = new Set();
const SESSION_PENDING_HOSTS_KEY = 'pendingStorageHosts';

function persistPendingHosts() {
  if (!chrome.storage?.session) return;
  chrome.storage.session.set({ [SESSION_PENDING_HOSTS_KEY]: [...pendingStorageHosts] }).catch(() => {});
}

function queueStorageHost(host) {
  if (!host) return;
  pendingStorageHosts.add(host);
  persistPendingHosts();
}

// Returns and clears every queued hostname, merging the in-memory set with the
// session-storage mirror (the two diverge when the SW was suspended between the
// queueing event and the sweep).
async function drainPendingHosts() {
  const merged = new Set(pendingStorageHosts);
  if (chrome.storage?.session) {
    try {
      const stored = await chrome.storage.session.get(SESSION_PENDING_HOSTS_KEY);
      const arr = stored[SESSION_PENDING_HOSTS_KEY];
      if (Array.isArray(arr)) for (const h of arr) if (typeof h === 'string') merged.add(h);
    } catch {}
  }
  pendingStorageHosts.clear();
  if (chrome.storage?.session) chrome.storage.session.set({ [SESSION_PENDING_HOSTS_KEY]: [] }).catch(() => {});
  return [...merged];
}

// chrome.storage.session is in-memory and cheap; no setTimeout-based
// debounce so we never lose the last write to SW suspension. Writes are
// bounded by tab open/close/nav rate, which is fine.
function persistTabCache() {
  if (!chrome.storage?.session) return;
  const obj = {};
  for (const [id, host] of tabUrlCache) obj[id] = host;
  chrome.storage.session.set({ [SESSION_TAB_CACHE_KEY]: obj }).catch(() => {});
}

(async function primeTabCache() {
  try {
    if (chrome.storage?.session) {
      const stored = await chrome.storage.session.get(SESSION_TAB_CACHE_KEY);
      const cached = stored[SESSION_TAB_CACHE_KEY];
      if (cached && typeof cached === 'object') {
        for (const [id, host] of Object.entries(cached)) {
          const numId = Number(id);
          if (Number.isInteger(numId) && typeof host === 'string') tabUrlCache.set(numId, host);
        }
      }
    }
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set();
    for (const t of tabs) {
      liveIds.add(t.id);
      const h = t.url ? safeHostname(t.url) : null;
      if (h) tabUrlCache.set(t.id, h);
    }
    // Drop entries for tabs that no longer exist (SW slept across a tab
    // close — the onRemoved event was already delivered to the previous SW
    // generation, but the cache survived).
    for (const id of [...tabUrlCache.keys()]) {
      if (!liveIds.has(id)) tabUrlCache.delete(id);
    }
    persistTabCache();
  } catch {}
})();

// === TAB EVENTS ===

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const hostname = tabUrlCache.get(tabId);
  tabUrlCache.delete(tabId);
  persistTabCache();
  if (!hostname) return;

  const settings = await getSyncSettings();
  if (!settings.enabled || !settings.cleanOnTabClose) return;

  if (settings.cleanThirdParty) {
    // Opt-in sweep model (matches Cookie AutoDelete): closing a tab triggers a
    // store-wide sweep that removes every cookie whose domain has no open tab
    // and isn't whitelisted — catching the non-partitioned third-party cookies
    // the per-domain path can't reach. Debounced (see scheduleSweep).
    // Remember the EXACT origin so the sweep can clear its service worker /
    // Cache / FileSystem storage, which the cookie-keyed sweep can't locate.
    // Only when a storage toggle is on — otherwise the queue would grow all
    // session with nothing ever draining it.
    if (anyStorageToggleOn(settings)) queueStorageHost(hostname);
    await scheduleSweep('tab-close-sweep');
    return;
  }

  // Default: surgical per-domain cleanup. Removes the closed site's own
  // cookies plus any partitioned (CHIPS) cookies scoped to it — nothing else.
  const target = stripWww(hostname);
  if (await isHostnameStillOpen(target, tabId)) return;
  // Pass the real hostname too: storage is origin-keyed, so clearing a service
  // worker registered under www.google.com needs that exact origin, not the
  // www-stripped google.com used for cookie matching.
  await cleanCookiesForDomain(target, hostname);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Capture the previous host BEFORE the cache is updated below, so navigation
  // detection compares against where the tab actually came from. We update the
  // cache ONLY from info.url (the authoritative URL-change signal), never from
  // tab.url: onUpdated also fires for status/title/favicon ticks on which
  // tab.url already reflects the NEW URL. Writing the cache from tab.url on one
  // of those ticks would overwrite prevHost before the real url tick arrives,
  // making prevTarget === newHost below and silently skipping cleanOnNavigation.
  const prevHost = tabUrlCache.get(tabId);

  // Refresh the toolbar icon's protected-state indicator on navigation. This is
  // independent of cleanOnNavigation — the indicator should track the address
  // bar even when nav-triggered cleanup is off. The whitelist context-menu
  // titles track the address bar the same way.
  if (info.url) { await updateActionIcon(tabId, info.url); await updateWhitelistMenu(info.url); }

  if (!info.url) return;
  const newHost = safeHostname(info.url);
  if (!newHost) return;
  tabUrlCache.set(tabId, newHost);
  persistTabCache();

  const settings = await getSyncSettings();
  if (!settings.enabled || !settings.cleanOnNavigation) return;

  if (!prevHost) return;
  const prevTarget = stripWww(prevHost);
  if (prevTarget === stripWww(newHost)) return;

  if (settings.cleanThirdParty) {
    // Domain changed; sweep all non-open, non-whitelisted cookies. Remember the
    // exact origin we left so the sweep can clear its origin-keyed storage (only
    // when a storage toggle is on — see the tab-close handler).
    if (anyStorageToggleOn(settings)) queueStorageHost(prevHost);
    await scheduleSweep('tab-close-sweep');
    return;
  }

  // Default: clean only the domain we navigated away from. Pass the real
  // previous hostname so origin-keyed storage (service workers, Cache, etc.) is
  // cleared under the exact origin, not the www-stripped registrable domain.
  if (await isHostnameStillOpen(prevTarget, tabId)) return;
  await cleanCookiesForDomain(prevTarget, prevHost);
});

// === ALARMS ===

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'scheduled-cleanup') {
    await cleanScheduled();
    await pruneGreylist();
  } else if (alarm.name === 'pending-cleanup') {
    // Backstop for scheduleSweep's in-memory timer: if the service worker was
    // suspended before the timer fired, this alarm runs the sweep instead.
    if (pendingSweepTimer) { clearTimeout(pendingSweepTimer); pendingSweepTimer = null; }
    await sweepNonOpenCookies('tab-close-sweep');
  } else if (alarm.name === 'daily-reset') {
    await rolloverDayIfNeeded();
    await updateBadge();
    // Reschedule for the next local midnight (DST-safe — see scheduleDailyReset).
    await scheduleDailyReset();
  }
});

async function rescheduleAlarm() {
  await chrome.alarms.clear('scheduled-cleanup');
  const settings = await getSyncSettings();
  if (settings.scheduledCleanupMinutes > 0) {
    try {
      await chrome.alarms.create('scheduled-cleanup', {
        periodInMinutes: settings.scheduledCleanupMinutes,
      });
    } catch {}
  }
}

async function scheduleDailyReset() {
  // Fire at the next local midnight. We don't use periodInMinutes:1440 —
  // a fixed 24h period drifts across DST transitions (badge resets an
  // hour off twice a year). Instead the alarm handler reschedules itself
  // for the next local midnight each time it fires.
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  await chrome.alarms.clear('daily-reset');
  try { await chrome.alarms.create('daily-reset', { when: next.getTime() }); } catch {}
}

async function rolloverDayIfNeeded() {
  const today = todayKey();
  const { dayKey = '' } = await chrome.storage.local.get('dayKey');
  if (dayKey !== today) {
    await chrome.storage.local.set({ dayKey: today, cleanedToday: 0 });
  }
}

// === TAB QUERIES ===

async function isHostnameStillOpen(target, excludeTabId = null) {
  if (!target) return false;
  const tabs = await chrome.tabs.query({});
  return tabs.some(t => {
    if (excludeTabId != null && t.id === excludeTabId) return false;
    const h = stripWww(safeHostname(t.url) || '');
    return h && (h === target || h.endsWith('.' + target));
  });
}

// === CORE CLEANUP ===

async function cleanCookiesForDomain(target, realHost = target, opts = {}) {
  if (!target) return 0;
  // includeParent — a manual "Clean now" cleans the WHOLE SITE: everything at
  // or under the registrable domain, not just the exact host. A page on
  // edition.cnn.com reads its login from `.cnn.com` (parent) cookies, and ad
  // stacks scatter cookies across sibling hosts (lightning.cnn.com,
  // www.cnn.com left behind by a redirect) — leaving any of those reads as
  // "it didn't clean". Browsers reject Set-Cookie on a public suffix, so every
  // cookie under the registrable domain is the site's own — no PSL needed to
  // know it's safe. Two spares keep it from breaking anything live: a host
  // that's whitelisted (or keep-ruled) is skipped, and so is a host with an
  // open tab OUTSIDE the site being cleaned (never yank a session out from
  // under another live tab). Automatic (tab-close/nav) callers keep the narrow
  // surgical scope; only the explicit user action broadens it.
  const includeParent = !!opts.includeParent;
  const settings = await getSyncSettings();
  const whitelisted = isWhitelisted(target, settings);
  const ruleList = rulesForHost(target, settings);
  // Fully protected and no per-cookie carve-outs → nothing to do. When the
  // domain has rules we fall through to apply any explicit delete-rules even on
  // a whitelisted site.
  if (whitelisted && !ruleList) return 0;

  // Three sources, each catching cookies the others miss:
  //
  // 1. unpart — chrome.cookies.getAll({domain:D}) returns cookies whose domain is
  //    D OR a subdomain of D (NOT parents — verified against Chrome). So to
  //    reach the whole site for an includeParent clean of a subdomain, we query
  //    the registrable domain (cnn.com) instead of target (edition.cnn.com) —
  //    that covers the shared parent cookies AND every sibling host; the delete
  //    loop below spares whitelisted/keep-ruled hosts and hosts open in another
  //    tab. Non-includeParent callers keep the narrow target query.
  // 2. partByDomain — getAll defaults to unpartitioned only; passing
  //    partitionKey:{} also returns partitioned (CHIPS) cookies. Same query
  //    domain as #1. (This call also re-returns the unpartitioned set; the
  //    `seen` dedup below collapses the overlap.)
  // 3. partBySite — partitioned (CHIPS) cookies stored UNDER target's partition,
  //    regardless of host: an embedded youtube.com cookie set while browsing
  //    target, plus target's own first-party partitioned cookies. We do NOT query
  //    this by partition string. Chrome keys partitions by SITE (scheme+eTLD+1),
  //    so target='app.example.com' actually lives under 'https://example.com';
  //    a literal getAll({topLevelSite:`https://${target}`}) would match nothing
  //    for subdomains, and deriving the site from a host needs the Public Suffix
  //    List. Instead we enumerate every partitioned cookie, read its REAL
  //    topLevelSite, and keep those whose partition site the closed host belongs
  //    to (target is that site or a subdomain of it). They exist only in target's
  //    top-level context, and target is NOT whitelisted (early return above), so
  //    the whole partition is deleted — we deliberately do NOT spare a whitelisted
  //    host: whitelisting youtube.com protects youtube's own context, not a
  //    youtube cookie partitioned under a non-whitelisted site.
  // includeParent → widen the query to the registrable domain so parent cookies
  // are actually returned (getAll doesn't walk upward). Falls back to target when
  // the suffix can't be resolved.
  const queryDomain = includeParent ? (registrableDomain(target) || target) : target;
  const [unpart, partByDomain, allPartitioned] = await Promise.all([
    chrome.cookies.getAll({ domain: queryDomain }),
    chrome.cookies.getAll({ domain: queryDomain, partitionKey: {} }).catch(() => []),
    chrome.cookies.getAll({ partitionKey: {} }).catch(() => []),
  ]);
  const partBySite = allPartitioned.filter(c => {
    const p = cookiePartitionSite(c);            // '' for unpartitioned → dropped
    return p && (target === p || target.endsWith('.' + p));
  });

  // "Open tab wins" guard for the manual whole-site clean: a cookie host is
  // spared when some open tab lives under it but OUTSIDE the site being
  // cleaned. Covers both shared parent cookies (`.cnn.com` while a sibling
  // money.cnn.com tab is open — deleting them would break that live session)
  // and sibling hosts themselves (an open money.cnn.com tab keeps its own
  // cookies). Tabs on the target itself don't count — the user is explicitly
  // cleaning that site while it's open. Only built for includeParent.
  let openHosts = null;
  if (includeParent) {
    openHosts = new Set();
    for (const t of await chrome.tabs.query({})) {
      const h = stripWww(safeHostname(t.url) || '');
      if (h) openHosts.add(h);
    }
  }
  const hostOpenOutsideTarget = (host) => !!openHosts && [...openHosts].some(h =>
    (h === host || h.endsWith('.' + host)) &&      // open tab under this host
    h !== target && !h.endsWith('.' + target));    // ...but not the site being cleaned

  const seen = new Set();
  const queue = [];   // { c, mode }
  // mode 'first-party' — cookies reached via the domain query: target's own,
  //                      plus (includeParent) the parent + sibling hosts of the
  //                      whole site. The delete loop classifies each one.
  // mode 'partition'   — every cookie under target's partition, host-agnostic.
  const enqueue = (c, mode) => {
    const bareDomain = c.domain.replace(/^\./, '');
    if (mode === 'first-party' && !includeParent) {
      // Automatic (tab-close/nav) callers keep the narrow surgical scope: the
      // target host and its subdomains only. (The narrow query already
      // guarantees this; kept as a guard.)
      if (bareDomain !== target && !bareDomain.endsWith('.' + target)) return;
    }
    const pk = c.partitionKey ? JSON.stringify(c.partitionKey) : '';
    const key = `${c.storeId}|${bareDomain}|${c.path}|${c.name}|${pk}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ c, mode });
  };
  for (const c of unpart) enqueue(c, 'first-party');
  for (const c of partByDomain) enqueue(c, 'first-party');
  for (const c of partBySite) enqueue(c, 'partition');

  let deletedCount = 0;
  // Hosts whose first-party cookies we actually deleted — their origin-keyed
  // storage is cleared below (matches the sweep's touchedHosts). Deep-subdomain
  // origins (lightning.cnn.com) are only reachable this way; realHost/target
  // alone can't name them.
  const touchedHosts = new Set([realHost, target]);
  for (const { c, mode } of queue) {
    const bareDomain = c.domain.replace(/^\./, '');
    if (mode === 'partition') {
      // A cross-site cookie partitioned under target — an embedded tracker — is
      // never spared by a name rule (a keep-rule must not shield a tracker),
      // mirroring the crossSite short-circuit in the sweep/clean-all paths:
      //   • whitelisted target  → kept (same as the pre-rules early return)
      //   • non-whitelisted      → deleted with the rest of the partition
      if (whitelisted) continue;
    } else {
      // First-party classification. Fold www like cookieGoverningHost does:
      // a `.www.cnn.com` cookie left behind by a redirect is governed by
      // cnn.com, i.e. it's a PARENT cookie while cleaning edition.cnn.com.
      const gov = stripWww(bareDomain);
      const selfOrSub = bareDomain === target || bareDomain.endsWith('.' + target);
      const parent = !selfOrSub && (target.endsWith('.' + bareDomain) || target.endsWith('.' + gov));
      if (selfOrSub || parent) {
        // Per-cookie rules use TARGET's rule list for the parent copies too, so
        // a keep-rule for e.g. cf_clearance still shields the `.cnn.com` copy.
        // A parent host that is itself whitelisted — including an EXACT entry,
        // which doesn't make isWhitelisted(target) true for this subdomain —
        // is kept: cleaning edition.cnn.com must not wipe a whitelisted cnn.com.
        if (parent && isWhitelisted(bareDomain, settings)) continue;
        if (parent && hostOpenOutsideTarget(gov)) continue;
        // Whitelisted target: only delete what an explicit delete-rule names.
        // Non-whitelisted: delete everything except explicit keep-rules.
        // (ruleList is null when the feature is off → verdict null → default path.)
        const verdict = ruleVerdict(c.name, ruleList);
        if (whitelisted ? verdict !== 'delete' : verdict === 'keep') continue;
      } else {
        // Sibling host within the same site (manual whole-site clean only —
        // the narrow callers never enqueue these). Governed by its OWN host:
        // its own whitelist entry / keep-rules decide, and an open tab on it
        // keeps its session alive. A whitelisted target's manual clean stays a
        // narrow rules-only pass and never widens to siblings.
        if (whitelisted) continue;
        if (hostOpenOutsideTarget(gov)) continue;
        if (!shouldDeleteFirstParty(c.name, gov, settings)) continue;
      }
    }
    const url = `${c.secure ? 'https' : 'http'}://${bareDomain}${c.path}`;
    try {
      const removeArgs = { url, name: c.name, storeId: c.storeId };
      if (c.partitionKey) removeArgs.partitionKey = c.partitionKey;
      const removed = await chrome.cookies.remove(removeArgs);
      if (removed) {
        deletedCount++;
        if (mode !== 'partition') touchedHosts.add(bareDomain);
      }
    } catch {}
  }

  // browsingData cleanup (only if permission granted AND any toggle on). Skipped
  // when the target is whitelisted: there we only deleted a few rule-named
  // cookies, and wiping the whole origin's LocalStorage/IndexedDB/cache would
  // nuke the login the whitelist is meant to preserve.
  if (!whitelisted && anyStorageToggleOn(settings)) {
    if (await hasBrowsingData()) {
      // storageOrigins expands each host to its bare/www. forms, so a worker
      // registered under www.google.com is cleared even though the cookie path
      // worked off google.com. touchedHosts seeds realHost + target and adds
      // the host of every first-party cookie actually deleted, so a whole-site
      // clean reaches deep-subdomain origins too (whitelisted/spared hosts are
      // never deleted from, hence never land in the set).
      try {
        await chrome.browsingData.remove(
          { origins: storageOrigins([...touchedHosts]) },
          browsingDataTypes(settings),
        );
      } catch {}
    }
  }

  await logDeletion(target, deletedCount);
  return deletedCount;
}

// Manual per-site clean (popup "Clean now" + the context-menu item). Ad-heavy
// pages re-set cookies within moments of a clean — scripts keep running in the
// still-open tab (BBC's ecos.dt beacon cookie is back in under a second). One
// silent follow-up pass shortly after catches those immediate re-sets; a page
// that re-sets continuously can't be beaten while its tab stays open, so we
// deliberately don't loop beyond one retry. The returned count is the first
// pass's (what the popup shows); the retry logs its own deletions if any.
const MANUAL_CLEAN_SECOND_PASS_MS = 1500;
async function manualSiteClean(target, realHost) {
  const count = await cleanCookiesForDomain(target, realHost, { includeParent: true });
  setTimeout(() => {
    cleanCookiesForDomain(target, realHost, { includeParent: true }).catch(() => {});
  }, MANUAL_CLEAN_SECOND_PASS_MS);
  return count;
}

// Debounced trigger for the tab-close / navigation sweep. The in-memory timer
// gives a snappy delay while the SW is alive; the 'pending-cleanup' alarm is a
// backstop that re-runs the sweep if the SW is suspended before the timer
// fires (alarms clamp to ~30s minimum, so it only matters in that case).
let pendingSweepTimer = null;
async function scheduleSweep(tag = 'tab-close-sweep') {
  const settings = await getSyncSettings();
  if (!settings.enabled) return;
  // Coalesce: a fresh trigger supersedes any pending one.
  if (pendingSweepTimer) { clearTimeout(pendingSweepTimer); pendingSweepTimer = null; }
  const delaySec = Math.max(0, Math.min(300, settings.cleanupDelaySeconds || 0));
  if (delaySec === 0) {
    await chrome.alarms.clear('pending-cleanup').catch(() => {});
    await sweepNonOpenCookies(tag);
    return;
  }
  const delayMs = delaySec * 1000;
  pendingSweepTimer = setTimeout(() => {
    pendingSweepTimer = null;
    chrome.alarms.clear('pending-cleanup').catch(() => {});
    sweepNonOpenCookies(tag).catch(() => {});
  }, delayMs);
  // Backstop fires only if the SW is suspended before the timer. Set it a hair
  // past the timer (and never under the ~30s alarm floor) so the timer wins
  // whenever the SW is still alive.
  try {
    await chrome.alarms.create('pending-cleanup', { delayInMinutes: Math.max(0.5, delayMs / 60000 + 0.25) });
  } catch {}
}

async function cleanScheduled() {
  await sweepNonOpenCookies('scheduled-sweep');
}

// Store-wide sweep: deletes every cookie whose domain has no open tab and
// isn't whitelisted. Shared by the scheduled alarm, the tab-close/navigation
// triggers, and startup. `tag` labels the entry written to the activity log.
async function sweepNonOpenCookies(tag = 'scheduled-sweep') {
  const settings = await getSyncSettings();
  if (!settings.enabled) return 0;

  const tabs = await chrome.tabs.query({});
  const openHosts = new Set();
  for (const t of tabs) {
    const h = stripWww(safeHostname(t.url) || '');
    if (h) openHosts.add(h);
  }
  const hostHasOpenTab = (host) =>
    !!host && [...openHosts].some(h => h === host || h.endsWith('.' + host));

  // Two calls cover both unpartitioned and partitioned (CHIPS) cookies.
  // getAll({partitionKey:{}}) returns BOTH partitioned and unpartitioned, so it
  // overlaps getAll({}); dedup by identity so each cookie is removed once.
  const [unpart, part] = await Promise.all([
    chrome.cookies.getAll({}),
    chrome.cookies.getAll({ partitionKey: {} }).catch(() => []),
  ]);
  const all = unpart.concat(part);
  const seen = new Set();

  // Per-cookie decision (not a single group-by-host) because a partitioned
  // cookie's fate depends on BOTH keys:
  //   • Cross-site partitioned (host ≠ partition site) — a third-party cookie
  //     slipping past 3P blocking. When "remove third-party cookies" is on we
  //     sweep it once its partition site has no open tab, REGARDLESS of whether
  //     that site (or the cookie's own host) is whitelisted. Closing a
  //     whitelisted site therefore still flushes the doubleclick / taboola /
  //     rubicon junk partitioned under it, while keeping the site's own login.
  //     The open-tab check keeps an embedded player/SSO frame alive while the
  //     site is still open.
  //   • Everything else (unpartitioned, or first-party partitioned where
  //     host == site) — governed by its own host: kept if whitelisted or still
  //     open, exactly as before.
  const toDelete = [];
  for (const c of all) {
    const bare = c.domain.replace(/^\./, '');
    const pk = c.partitionKey ? JSON.stringify(c.partitionKey) : '';
    const key = `${c.storeId}|${bare}|${c.path}|${c.name}|${pk}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const site = cookiePartitionSite(c);   // '' when unpartitioned
    if (site && settings.cleanThirdParty && !isFirstPartyPartitioned(c, site)) {
      if (hostHasOpenTab(site)) continue;
      toDelete.push({ c, governing: site, firstParty: false });
      continue;
    }

    const gov = cookieGoverningHost(c);
    if (!gov) continue;
    // Open tab wins over everything (including a delete-rule): never pull a
    // cookie out from under a live session. Otherwise rules + whitelist decide.
    if (hostHasOpenTab(gov)) continue;
    if (!shouldDeleteFirstParty(c.name, gov, settings)) continue;
    toDelete.push({ c, governing: gov, firstParty: true });
  }

  let totalDeleted = 0;
  const touchedHosts = new Set();
  for (const { c, governing, firstParty } of toDelete) {
    const bare = c.domain.replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${bare}${c.path}`;
    try {
      const removeArgs = { url, name: c.name, storeId: c.storeId };
      if (c.partitionKey) removeArgs.partitionKey = c.partitionKey;
      const removed = await chrome.cookies.remove(removeArgs);
      // browsingData (localStorage/IndexedDB/cache) is cleared only for
      // first-party deletions: wiping boingboing.net storage because we removed
      // a doubleclick cookie partitioned under it would nuke a kept site's data.
      if (removed) { totalDeleted++; if (firstParty) touchedHosts.add(governing); }
    } catch {}
  }

  // Mirror the per-domain and full-sweep paths: if the user opted into
  // LocalStorage / IndexedDB / cache / service-worker cleanup, scheduled sweeps
  // must honor that too. Storage is origin-keyed, so two sources feed it:
  //   • touchedHosts — registrable domains of first-party cookies we deleted
  //     (folded; storageOrigins expands the www. variant).
  //   • pendingStorageHosts — the EXACT hostnames of tabs that just closed or
  //     navigated away. These are the only reliable source of subdomain origins
  //     (forum.vivaldi.net, www.google.com) and let us clear a site's worker
  //     even when it set no first-party cookie to delete.
  if (anyStorageToggleOn(settings)) {
    const closedHosts = await drainPendingHosts();
    const hosts = new Set(touchedHosts);
    for (const h of closedHosts) {
      const bare = stripWww(h);
      // Don't wipe a whitelisted site, and don't yank storage out from under a
      // host still open in another tab (matches the cookie-side open-tab guard).
      if (isWhitelisted(bare, settings) || hostHasOpenTab(bare)) continue;
      hosts.add(h);
    }
    if (hosts.size && await hasBrowsingData()) {
      try {
        await chrome.browsingData.remove(
          { origins: storageOrigins(hosts) },
          browsingDataTypes(settings),
        );
      } catch {}
    }
  }

  await logDeletion(tag, totalDeleted);
  return totalDeleted;
}

async function cleanAllNonWhitelisted(tag = 'manual-clean-all') {
  const settings = await getSyncSettings();
  const [unpart, part] = await Promise.all([
    chrome.cookies.getAll({}),
    chrome.cookies.getAll({ partitionKey: {} }).catch(() => []),
  ]);
  const all = unpart.concat(part);
  let deletedCount = 0;
  const touchedHosts = new Set();
  // getAll({partitionKey:{}}) re-returns the unpartitioned set, so `all` holds
  // each unpartitioned cookie twice. Dedup by identity (same key shape as the
  // sweep path) so we don't fire a redundant chrome.cookies.remove per cookie.
  const seen = new Set();
  for (const c of all) {
    const bareKey = c.domain.replace(/^\./, '');
    const pkKey = c.partitionKey ? JSON.stringify(c.partitionKey) : '';
    const dedupKey = `${c.storeId}|${bareKey}|${c.path}|${c.name}|${pkKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    // Governing host, not raw host_key: a partitioned youtube.com cookie under a
    // non-whitelisted top-level site is deleted even though youtube is whitelisted.
    const host = cookieGoverningHost(c);
    // Cross-site partitioned cookies are third-party junk (host ≠ partition
    // site). With "remove third-party cookies" on, sweep them even when their
    // top-level site is whitelisted — the whitelist protects the site's own
    // context, not a tracker partitioned under it. Their governing origin's
    // storage is left intact below (crossSite → not added to touchedHosts).
    const site = cookiePartitionSite(c);
    const crossSite = !!site && settings.cleanThirdParty && !isFirstPartyPartitioned(c, site);
    // First-party cookies obey per-cookie rules + whitelist; cross-site trackers
    // are always swept (whitelist doesn't shield a tracker partitioned under it).
    if (!crossSite && !shouldDeleteFirstParty(c.name, host, settings)) continue;
    const bare = c.domain.replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${bare}${c.path}`;
    try {
      const removeArgs = { url, name: c.name, storeId: c.storeId };
      if (c.partitionKey) removeArgs.partitionKey = c.partitionKey;
      const removed = await chrome.cookies.remove(removeArgs);
      // Clear origin storage only for sites being fully cleaned — not a
      // whitelisted host where a delete-rule removed a single cookie, nor a
      // cross-site tracker (its top-level site's storage stays intact).
      if (removed) {
        deletedCount++;
        if (!crossSite && !isWhitelisted(host, settings)) touchedHosts.add(host);
      }
    } catch {}
  }

  // browsingData cleanup. Two origin sources:
  //   • touchedHosts — registrable domains of first-party cookies we deleted
  //     (folded; storageOrigins expands the www. variant).
  //   • real tab hostnames — the EXACT origins (subdomain-precise) of every site
  //     the user has open or recently closed this session. Cookies are keyed by
  //     registrable domain and can't reach storage on a deep subdomain
  //     (forum.vivaldi.net) whose cookies live on the parent, nor a site that set
  //     no cookie at all. Clean-all is the aggressive "clear EVERY site" action
  //     (it already deletes open tabs' cookies), so we clear open tabs too —
  //     only whitelisted hosts are spared.
  if (anyStorageToggleOn(settings)) {
    const hosts = new Set(touchedHosts);
    const realHosts = [...tabUrlCache.values(), ...(await drainPendingHosts())];
    for (const h of realHosts) {
      const bare = stripWww(h || '');
      if (!bare || !bare.includes('.')) continue;   // skip chrome:// pseudo-hosts
      if (isWhitelisted(bare, settings)) continue;
      hosts.add(h);
    }
    if (hosts.size && await hasBrowsingData()) {
      try {
        await chrome.browsingData.remove(
          { origins: storageOrigins(hosts) },
          browsingDataTypes(settings),
        );
      } catch {}
    }
  }

  await logDeletion(tag, deletedCount);
  return deletedCount;
}

// === WHITELIST / GREYLIST CHECK ===

function isWhitelisted(hostname, settings) {
  // Pure matching (wildcard + exact + time-boxed greylist) lives in lib/whitelist
  // so it can be unit-tested; here we just strip www and stamp "now".
  return isHostWhitelisted(stripWww(hostname || ''), settings, Date.now());
}

async function pruneGreylist() {
  await serializeWrite(async () => {
    const { greylist = {} } = await chrome.storage.sync.get('greylist');
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(greylist)) {
      if (!(greylist[k] > now)) { delete greylist[k]; changed = true; }
    }
    if (changed) await chrome.storage.sync.set({ greylist });
  });
}

// === PER-COOKIE RULES (advanced, opt-in) ===
//
// When `enableCookieRules` is on, a domain can carry an ordered list of rules
// — { name: '<pattern>', keep: true|false } — that override the all-or-nothing
// whitelist decision for INDIVIDUAL cookies by name. A `keep` rule protects a
// cookie even on a non-whitelisted site; a `delete` rule wipes a cookie even on
// a whitelisted one. First-match-wins; an unmatched cookie falls back to the
// normal whitelist/open-tab behavior. Patterns support `*` wildcards.
//
// Rules apply only to first-party cookies (governed by their own host). They are
// deliberately NOT consulted for cross-site partitioned (tracker) cookies — those
// are governed by their partition site, where a name match would be a footgun.
//
// The reserved domain key '*' holds GLOBAL rules that apply to EVERY host —
// name-based rules only pay off for the handful of cookies whose names are stable
// across thousands of sites (cf_clearance, _ga, consent cookies), and those are
// exactly the ones you don't want to re-add per domain. Global rules are the
// lowest-precedence layer: a host-specific rule for the same cookie name still
// wins (see rulesForHost), so a per-site override beats the global default.

// GLOBAL_RULES_KEY + the rule-matching functions (matchCookieName, rulesForHost,
// ruleVerdict) live in lib/cookie-rules.js (imported above) — pure and tested.
const COOKIE_RULES_MAX_DOMAINS = 50;
const COOKIE_RULES_MAX_PER_DOMAIN = 20;
const RULE_NAME_MAX = 64;
// chrome.storage.sync caps a single key at 8 KB. cookieRules lives under ONE
// key, so the domain/rule counts above are only upper bounds — this serialized
// byte budget is the real guard. Every writer checks the candidate object
// against it before set() so we never throw QUOTA_BYTES_PER_ITEM (which would
// surface as a misleading failure in the options UI).
const COOKIE_RULES_MAX_BYTES = 7000;

function cookieRulesTooBig(obj) {
  // Measure UTF-8 BYTES, not String.length (UTF-16 code units): the storage.sync
  // 8 KB/item quota is bytes, so a multibyte rule name could slip past a
  // .length check yet overflow the real limit on set().
  try { return new TextEncoder().encode(JSON.stringify(obj)).length > COOKIE_RULES_MAX_BYTES; }
  catch { return true; }
}

// Combined first-party decision: should this cookie be DELETED given rules +
// whitelist? Used by the store-wide sweep and the manual full-clean. The
// per-domain close path makes the same decision inline (it already knows the
// whitelist state of its single target).
function shouldDeleteFirstParty(cookieName, gov, settings) {
  const verdict = ruleVerdict(cookieName, rulesForHost(gov, settings));
  if (verdict === 'keep') return false;
  if (verdict === 'delete') return true;
  return !isWhitelisted(gov, settings);
}

// === COOKIE-RULE WRITERS ===
//
// Edited only from the options page, but funneled through serializeWrite (like
// the whitelist/greylist writers) so a concurrent synced-device write or a
// second open Settings tab can't clobber the rule set with a lost update.

function normalizeRuleName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > RULE_NAME_MAX) return null;
  if (/[\s;=]/.test(n)) return null; // cookie names can't contain these; reject junk input
  return n;
}

async function addRuleDomain(domain) {
  if (!isValidDomain(domain)) return 'invalid';
  return serializeWrite(async () => {
    const { cookieRules = {} } = await chrome.storage.sync.get('cookieRules');
    if (cookieRules[domain]) return 'duplicate';
    if (Object.keys(cookieRules).length >= COOKIE_RULES_MAX_DOMAINS) return 'full';
    cookieRules[domain] = [];
    if (cookieRulesTooBig(cookieRules)) { delete cookieRules[domain]; return 'full'; }
    await chrome.storage.sync.set({ cookieRules });
    return 'added';
  });
}

async function removeRuleDomain(domain) {
  return serializeWrite(async () => {
    const { cookieRules = {} } = await chrome.storage.sync.get('cookieRules');
    if (!(domain in cookieRules)) return false;
    delete cookieRules[domain];
    await chrome.storage.sync.set({ cookieRules });
    return true;
  });
}

async function addRule(domain, name, keep) {
  const clean = normalizeRuleName(name);
  if (!clean) return 'invalid';
  return serializeWrite(async () => {
    const { cookieRules = {} } = await chrome.storage.sync.get('cookieRules');
    // The global ('*') bucket has no "Add domain" step, so create it on first use.
    if (domain === GLOBAL_RULES_KEY && !Array.isArray(cookieRules[domain])) {
      cookieRules[domain] = [];
    }
    const list = cookieRules[domain];
    if (!Array.isArray(list)) return 'no-domain';
    if (list.length >= COOKIE_RULES_MAX_PER_DOMAIN) return 'full';
    // Case-insensitive duplicate check: matchCookieName is case-insensitive, so
    // 'SessionID' and 'sessionid' would be redundant (the second never fires).
    const lc = clean.toLowerCase();
    if (list.some(r => r.name.toLowerCase() === lc)) return 'duplicate';
    list.push({ name: clean, keep: !!keep });
    if (cookieRulesTooBig(cookieRules)) { list.pop(); return 'full'; }
    await chrome.storage.sync.set({ cookieRules });
    return 'added';
  });
}

// Remove by name (not array index): the options UI captures a name at render
// time, and matching by name avoids a TOCTOU where a concurrent reorder/remove
// from another tab or synced device would make a stale index delete the wrong
// rule. Names are unique per domain (case-insensitive), so first match is exact.
async function removeRule(domain, name) {
  return serializeWrite(async () => {
    const { cookieRules = {} } = await chrome.storage.sync.get('cookieRules');
    const list = cookieRules[domain];
    if (!Array.isArray(list)) return false;
    const i = list.findIndex(r => r && r.name === name);
    if (i < 0) return false;
    list.splice(i, 1);
    await chrome.storage.sync.set({ cookieRules });
    return true;
  });
}

// === LOGGING + BADGE ===

async function logDeletion(domain, count) {
  if (count <= 0) return;
  await rolloverDayIfNeeded();
  await serializeWrite(async () => {
    const { deletionLog = [], totalCleaned = 0, cleanedToday = 0 } = await chrome.storage.local.get(
      ['deletionLog', 'totalCleaned', 'cleanedToday']
    );
    deletionLog.unshift({ timestamp: Date.now(), domain, count });
    while (deletionLog.length > LOG_MAX_ENTRIES) deletionLog.pop();
    await chrome.storage.local.set({
      deletionLog,
      totalCleaned: totalCleaned + count,
      cleanedToday: cleanedToday + count,
    });
  });
  // totalCleaned/cleanedToday are kept for the popup + options stats only; the
  // toolbar badge no longer reflects them (see updateBadge).
}

async function updateBadge() {
  // We deliberately do NOT show a running cookie/cleaned count — it races to
  // "999+" within a day and carries no actionable signal (per user feedback).
  // The only badge state kept is "OFF", which tells the user auto-cleanup is
  // paused; everything else stays clear, with whitelist status conveyed by the
  // toolbar icon instead (see updateActionIcon).
  const { enabled = true } = await chrome.storage.sync.get('enabled');
  if (!enabled) {
    try { await chrome.action.setBadgeText({ text: 'OFF' }); } catch {}
    try { await chrome.action.setBadgeBackgroundColor({ color: BADGE_DISABLED_COLOR }); } catch {}
    if (chrome.action.setBadgeTextColor) {
      try { await chrome.action.setBadgeTextColor({ color: '#ffffff' }); } catch {}
    }
    return;
  }
  try { await chrome.action.setBadgeText({ text: '' }); } catch {}
}

// === TOOLBAR ICON INDICATOR ===
//
// Like Cookie AutoDelete, the toolbar icon signals whether the active tab's
// site is protected (whitelisted or greylisted). We render a "protected"
// variant once — the base cookie icon with a small green check badge in the
// corner — and swap it in per-tab. The variant is built at runtime with
// OffscreenCanvas so we don't ship extra PNG assets that can drift from the
// base icon.

const ICON_SIZES = [16, 48];
let protectedIconCache = null;        // { 16: ImageData, 48: ImageData } once built
let protectedIconBuildPromise = null; // de-dupes concurrent builds

async function buildProtectedIcons() {
  if (protectedIconCache) return protectedIconCache;
  if (protectedIconBuildPromise) return protectedIconBuildPromise;
  protectedIconBuildPromise = (async () => {
    const out = {};
    for (const size of ICON_SIZES) {
      try {
        const resp = await fetch(chrome.runtime.getURL(`icons/${size}_${size}.png`));
        const bitmap = await createImageBitmap(await resp.blob());
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, size, size);

        // Green check badge, bottom-right. White ring keeps it legible against
        // the cookie's tan/brown regardless of where it lands.
        const r = size * 0.36;
        const cx = size - r - size * 0.02;
        const cy = size - r - size * 0.02;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.8, 0, 2 * Math.PI);
        ctx.fillStyle = '#16a34a';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, size * 0.075);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.4, cy + r * 0.02);
        ctx.lineTo(cx - r * 0.08, cy + r * 0.36);
        ctx.lineTo(cx + r * 0.44, cy - r * 0.34);
        ctx.stroke();

        out[size] = ctx.getImageData(0, 0, size, size);
      } catch {}
    }
    // Only cache if we got at least one size; otherwise allow a later retry.
    if (Object.keys(out).length) protectedIconCache = out;
    protectedIconBuildPromise = null;
    return out;
  })();
  return protectedIconBuildPromise;
}

async function updateActionIcon(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const host = stripWww(safeHostname(url || '') || '');
  let protectedSite = false;
  if (host) {
    const settings = await getSyncSettings();
    // Only indicate "protected" while cleanup is enabled. When disabled, the
    // 'OFF' badge already occupies the icon (and nothing is being cleaned), so
    // overlaying the whitelist check would collide with it and mislead.
    protectedSite = settings.enabled !== false && isWhitelisted(host, settings);
  }
  try {
    if (protectedSite) {
      const icons = await buildProtectedIcons();
      const imageData = {};
      for (const size of ICON_SIZES) if (icons[size]) imageData[size] = icons[size];
      if (Object.keys(imageData).length) {
        await chrome.action.setIcon({ tabId, imageData });
        return;
      }
    }
    // Not protected (or variant unavailable) — restore the default icon. Passing
    // a path resets any previously-set per-tab imageData.
    await chrome.action.setIcon({
      tabId,
      path: { 16: 'icons/16_16.png', 48: 'icons/48_48.png' },
    });
  } catch {}
}

// Refresh the icon for every currently-visible (active) tab across all windows.
// Cheap — there's one active tab per window — and only triggered on list edits.
async function refreshVisibleActionIcons() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs) await updateActionIcon(t.id, t.url);
  } catch {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateActionIcon(tabId, tab.url);
    await updateWhitelistMenu(tab.url);
  } catch {}
});

// === WHITELIST / GREYLIST WRITERS ===

// A valid registrable hostname has at least one dot (e.g. example.com), no
// scheme, no whitespace, no leading/trailing dot. Without this guard, using
// the keyboard shortcut on chrome://settings would whitelist the bare token
// "settings", which then matches every host that ends in ".settings" (none
// in practice, but it's junk in storage and confuses the UI count).
function isValidDomain(domain) {
  if (typeof domain !== 'string') return false;
  if (!domain || domain.length > 253) return false;
  if (!/\./.test(domain)) return false;
  if (/^\.|\.$/.test(domain)) return false;
  if (/[\s/\\@:?#]/.test(domain)) return false;
  return true;
}

// Returns a status string ('added' | 'duplicate' | 'full' | 'invalid') so the
// popup/options UI can report the outcome. All list mutations funnel through
// here (and removeFrom* / addToGreylist below) so they share serializeWrite's
// single queue — the popup and options pages MUST message the SW rather than
// read-modify-write chrome.storage.sync directly, or a concurrent context-menu
// / keyboard / synced-device write can clobber theirs (lost update).
// Read the two whitelist lists as clean arrays (defensive against bad synced data).
async function getWhitelistLists() {
  const { whitelist = [], whitelistExact = [] } = await chrome.storage.sync.get(['whitelist', 'whitelistExact']);
  return {
    whitelist: Array.isArray(whitelist) ? whitelist : [],
    whitelistExact: Array.isArray(whitelistExact) ? whitelistExact : [],
  };
}

// Add a WILDCARD entry (covers the host + all its subdomains). Coverage/pruning
// logic lives in lib/whitelist (planAddWildcard); here we just do storage I/O.
async function addToWhitelist(domain) {
  if (!isValidDomain(domain)) return 'invalid';
  return serializeWrite(async () => {
    const p = planAddWildcard(await getWhitelistLists(), domain, WHITELIST_MAX_ENTRIES);
    if (p.result !== 'added') return p.result;
    await chrome.storage.sync.set({ whitelist: p.whitelist, whitelistExact: p.whitelistExact });
    return 'added';
  });
}

// Add an EXACT entry (covers ONLY that host, never its subdomains).
async function addToWhitelistExact(host) {
  if (!isValidDomain(host)) return 'invalid';
  return serializeWrite(async () => {
    const p = planAddExact(await getWhitelistLists(), host, WHITELIST_MAX_ENTRIES);
    if (p.result !== 'added') return p.result;
    await chrome.storage.sync.set({ whitelistExact: p.whitelistExact });
    return 'added';
  });
}

// Remove a whitelist entry. exact=true removes `domain` verbatim (the options
// list, where each row is a stored entry). exact=false (the popup's "Remove
// from whitelist") removes the entry that actually protects `domain`, which may
// be a PARENT domain — whitelisting google.com protects mail.google.com, so
// removing from mail.google.com must drop google.com. Returns the removed entry
// or null.
async function removeFromWhitelist(domain, exact = false) {
  const host = exact ? domain : stripWww(domain || '');
  if (!host) return null;
  return serializeWrite(async () => {
    const p = planRemove(await getWhitelistLists(), host, exact);
    if (!p.removed) return null;
    const patch = {};
    if (p.whitelist) patch.whitelist = p.whitelist;
    if (p.whitelistExact) patch.whitelistExact = p.whitelistExact;
    await chrome.storage.sync.set(patch);
    return p.removed;
  });
}

// Remove an EXACT-list entry verbatim (the options list's exact rows).
async function removeFromWhitelistExact(host) {
  if (!host) return null;
  return serializeWrite(async () => {
    const { whitelistExact = [] } = await chrome.storage.sync.get('whitelistExact');
    const ex = Array.isArray(whitelistExact) ? whitelistExact : [];
    if (!ex.includes(host)) return null;
    await chrome.storage.sync.set({ whitelistExact: ex.filter(d => d !== host) });
    return host;
  });
}

async function removeFromGreylist(domain) {
  if (!domain) return false;
  return serializeWrite(async () => {
    const { greylist = {} } = await chrome.storage.sync.get('greylist');
    if (!(domain in greylist)) return false;
    delete greylist[domain];
    await chrome.storage.sync.set({ greylist });
    return true;
  });
}

async function addToGreylist(domain) {
  if (!isValidDomain(domain)) return;
  await serializeWrite(async () => {
    const { greylist = {}, greylistDurationDays = 7 } = await chrome.storage.sync.get(
      ['greylist', 'greylistDurationDays']
    );
    const keys = Object.keys(greylist);
    if (keys.length >= GREYLIST_MAX_ENTRIES && !(domain in greylist)) {
      let oldestKey = null, oldestExp = Infinity;
      for (const k of keys) {
        if (greylist[k] < oldestExp) { oldestExp = greylist[k]; oldestKey = k; }
      }
      if (oldestKey) delete greylist[oldestKey];
    }
    greylist[domain] = Date.now() + greylistDurationDays * 86400 * 1000;
    await chrome.storage.sync.set({ greylist });
  });
}

// === CONTEXT MENU ===

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url) return;
  const realHost = safeHostname(tab.url) || '';
  const host = stripWww(realHost);
  if (!host) return;
  if (info.menuItemId === 'whitelist-site') {
    // "Only this host" → exact entry (does NOT cover subdomains).
    await addToWhitelistExact(host);
  } else if (info.menuItemId === 'whitelist-domain') {
    // "All of <domain>" → wildcard entry for the registrable domain (covers
    // subdomains). Re-derived from the clicked tab so a stale menu title can't
    // target the wrong host; falls back to the exact host if unresolved.
    await addToWhitelist(registrableDomain(host) || host);
  } else if (info.menuItemId === 'unwhitelist-site') {
    // Mirror the popup's "Remove from whitelist": exact=false drops the entry
    // that actually protects this host, which may be a parent domain.
    await removeFromWhitelist(host);
  } else if (info.menuItemId === 'force-clean') {
    // Per-site manual clean. Pass the real hostname so origin-keyed storage is
    // cleared under the exact origin (matches the popup/nav/tab-close paths).
    // manualSiteClean = whole-site scope + a follow-up pass for re-set cookies.
    const count = await manualSiteClean(host, realHost);
    if (count > 0) maybeShowRating(tab.id);
  }
});

// === KEYBOARD COMMANDS ===

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-cleanup') {
    await serializeWrite(async () => {
      const { enabled = true } = await chrome.storage.sync.get('enabled');
      await chrome.storage.sync.set({ enabled: !enabled });
    });
  } else if (command === 'whitelist-current-site') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const host = stripWww(safeHostname(tab.url) || '');
    await addToWhitelist(host);
  } else if (command === 'force-clean-now') {
    const count = await cleanAllNonWhitelisted();
    if (count > 0) maybeShowRating(null);
  }
});

// === MESSAGE LISTENER ===

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Rating widget events are synchronous fire-and-forget — handle inline
  // and signal "no async response" by returning false.
  if (msg?.type === 'rw:event') {
    if (globalThis.RatingWidget) globalThis.RatingWidget.bg.handleMessage(msg);
    return false;
  }
  (async () => {
    try {
      if (msg?.action === 'force-clean' && msg.hostname) {
        // Per-site manual clean (popup "Clean now"). The popup already strips
        // www, so target === realHost here; that's fine — cleanCookiesForDomain's
        // storageOrigins() re-expands to both bare and www. forms, so origin-keyed
        // storage (service worker / Cache / etc.) is still covered.
        // manualSiteClean = whole-site scope (parent + sibling hosts) plus a
        // follow-up pass for cookies the page re-sets right after the clean.
        const count = await manualSiteClean(stripWww(msg.hostname), msg.hostname);
        sendResponse({ ok: true, count });
        if (count > 0) maybeShowRating(null);
      } else if (msg?.action === 'force-clean-all') {
        const count = await cleanAllNonWhitelisted();
        sendResponse({ ok: true, count });
        if (count > 0) maybeShowRating(null);
      } else if (msg?.action === 'add-greylist' && msg.hostname) {
        await addToGreylist(stripWww(msg.hostname));
        sendResponse({ ok: true });
      } else if (msg?.action === 'add-whitelist' && msg.hostname) {
        const result = await addToWhitelist(stripWww(msg.hostname));
        sendResponse({ ok: true, result });
      } else if (msg?.action === 'add-whitelist-exact' && msg.hostname) {
        const result = await addToWhitelistExact(stripWww(msg.hostname));
        sendResponse({ ok: true, result });
      } else if (msg?.action === 'remove-whitelist' && msg.hostname) {
        const removed = await removeFromWhitelist(msg.hostname, !!msg.exact);
        sendResponse({ ok: true, removed });
      } else if (msg?.action === 'remove-whitelist-exact' && msg.hostname) {
        const removed = await removeFromWhitelistExact(msg.hostname);
        sendResponse({ ok: true, removed });
      } else if (msg?.action === 'remove-greylist' && msg.hostname) {
        const removed = await removeFromGreylist(msg.hostname);
        sendResponse({ ok: true, removed });
      } else if (msg?.action === 'rule-add-domain' && msg.domain) {
        const result = await addRuleDomain(stripWww(msg.domain));
        sendResponse({ ok: true, result });
      } else if (msg?.action === 'rule-remove-domain' && msg.domain) {
        const removed = await removeRuleDomain(msg.domain);
        sendResponse({ ok: true, removed });
      } else if (msg?.action === 'rule-add' && msg.domain) {
        const result = await addRule(msg.domain, msg.name, !!msg.keep);
        sendResponse({ ok: true, result });
      } else if (msg?.action === 'rule-remove' && msg.domain) {
        const removed = await removeRule(msg.domain, msg.name);
        sendResponse({ ok: true, removed });
      } else {
        sendResponse({ ok: false, error: 'unknown action' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// === STORAGE LISTENER ===

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.scheduledCleanupMinutes) await rescheduleAlarm();
    // Toggling enabled swaps the 'OFF' badge AND the per-tab protected icon
    // (the check is suppressed while OFF), so refresh both together.
    if (changes.enabled) { await updateBadge(); await refreshVisibleActionIcons(); }
    // Whitelist/greylist membership drives the toolbar icon indicator. A change
    // here (popup, options import, context menu, keyboard shortcut) can flip the
    // active tab's protected state, so refresh the visible icons.
    if (changes.whitelist || changes.whitelistExact || changes.greylist) await refreshVisibleActionIcons();
    // A whitelist change also flips the active tab's context-menu between the
    // add-items and "Remove from whitelist", so keep the menu in sync too.
    if (changes.whitelist || changes.whitelistExact) await refreshWhitelistMenuForActiveTab();
  }
});
