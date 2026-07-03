import { MULTI_SUFFIXES } from './lib/registrable-domain.js';

const SYNC_BOOL = ['cleanOnTabClose', 'cleanOnNavigation', 'cleanOnStartup', 'cleanThirdParty', 'cleanLocalStorage', 'cleanIndexedDB', 'cleanCache', 'cleanServiceWorkers'];
const SYNC_NUM  = ['scheduledCleanupMinutes', 'greylistDurationDays', 'cleanupDelaySeconds'];
// Must mirror SYNC_DEFAULTS in background.js — cleanOnTabClose and
// cleanThirdParty are on by default. cleanLocalStorage/IndexedDB/Cache need the
// optional browsingData permission and are flipped on by the welcome flow when
// granted.
const SYNC_DEFAULTS_BOOL_TRUE = new Set(['cleanOnTabClose', 'cleanThirdParty']);
const SYNC_DEFAULTS_NUM = { scheduledCleanupMinutes: 0, greylistDurationDays: 7, cleanupDelaySeconds: 10 };
const LOCAL_KEYS = ['deletionLog', 'totalCleaned', 'cleanedToday'];

// "browsingData"-gated checkboxes
const BD_CHECKBOXES = ['cleanLocalStorage', 'cleanIndexedDB', 'cleanCache', 'cleanServiceWorkers'];

let logFilter = 'all';
let allLogs = [];

async function init() {
  const version = chrome.runtime.getManifest().version;
  const headerVersion = document.getElementById('header-version');
  const aboutVersion = document.getElementById('about-version');
  if (headerVersion) headerVersion.textContent = `v${version}`;
  if (aboutVersion) aboutVersion.textContent = version;

  document.getElementById('kbd-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  await loadAndBind();
  bindActions();
  setupSectionNav();
  await refreshBrowsingDataStatus();
  await refreshSyncStatus();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.whitelist || changes.whitelistExact) {
        if (changes.whitelist) whitelistWild = changes.whitelist.newValue || [];
        if (changes.whitelistExact) whitelistExactArr = changes.whitelistExact.newValue || [];
        renderWhitelistView();
      }
      if (changes.greylist) renderGreylist(changes.greylist.newValue || {});
      if (changes.cookieRules) { cookieRulesState = changes.cookieRules.newValue || {}; renderCookieRules(); }
      if (changes.enableCookieRules) {
        const on = !!changes.enableCookieRules.newValue;
        const el = document.getElementById('enableCookieRules');
        if (el) el.checked = on;
        document.getElementById('rules-editor')?.classList.toggle('hidden', !on);
      }
      // Reflect settings flips that happen elsewhere (welcome flow grants
      // browsingData and sets cleanLocalStorage=true; another open Settings
      // tab toggled something; sync from another device). Without this,
      // checkboxes here go stale until the page is reloaded.
      for (const k of SYNC_BOOL) {
        if (!(k in changes)) continue;
        const el = document.getElementById(k);
        if (!el) continue;
        const newVal = changes[k].newValue;
        const defaultTrue = SYNC_DEFAULTS_BOOL_TRUE.has(k);
        el.checked = newVal === undefined ? defaultTrue : !!newVal;
      }
      for (const k of SYNC_NUM) {
        if (!(k in changes)) continue;
        const el = document.getElementById(k);
        if (!el) continue;
        const defaultVal = SYNC_DEFAULTS_NUM[k] ?? 0;
        el.value = String(changes[k].newValue ?? defaultVal);
      }
    } else if (area === 'local') {
      if (changes.deletionLog) {
        allLogs = changes.deletionLog.newValue || [];
        renderLog();
      }
    }
  });

  // Watch for browsingData permission revoked externally.
  if (chrome.permissions?.onRemoved) {
    chrome.permissions.onRemoved.addListener(refreshBrowsingDataStatus);
    chrome.permissions.onAdded.addListener(refreshBrowsingDataStatus);
  }
}

async function loadAndBind() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get([...SYNC_BOOL, ...SYNC_NUM, 'whitelist', 'whitelistExact', 'greylist', 'enableCookieRules', 'cookieRules']),
    chrome.storage.local.get(LOCAL_KEYS),
  ]);

  for (const k of SYNC_BOOL) {
    const el = document.getElementById(k);
    if (!el) continue;
    const defaultTrue = SYNC_DEFAULTS_BOOL_TRUE.has(k);
    const stored = sync[k];
    el.checked = stored === undefined ? defaultTrue : !!stored;

    el.addEventListener('change', async (e) => {
      const newVal = e.target.checked;
      // Browsing-data-gated checkboxes need permission.
      if (newVal && BD_CHECKBOXES.includes(k)) {
        const granted = await ensureBrowsingDataPermission(k);
        if (!granted) {
          e.target.checked = false;
          return;
        }
      }
      await chrome.storage.sync.set({ [k]: newVal });
      flashSaved();
    });
  }

  for (const k of SYNC_NUM) {
    const el = document.getElementById(k);
    if (!el) continue;
    const defaultVal = SYNC_DEFAULTS_NUM[k] ?? 0;
    el.value = String(sync[k] ?? defaultVal);
    el.addEventListener('change', async (e) => {
      await chrome.storage.sync.set({ [k]: parseInt(e.target.value, 10) });
      flashSaved();
    });
  }

  renderWhitelist(sync.whitelist || [], sync.whitelistExact || []);
  renderGreylist(sync.greylist || {});
  bindCookieRules(!!sync.enableCookieRules, sync.cookieRules || {});
  allLogs = local.deletionLog || [];
  renderLog();
}

function bindActions() {
  document.getElementById('add-whitelist').addEventListener('click', addWhitelistFromInput);
  document.getElementById('new-whitelist').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addWhitelistFromInput(); }
  });

  const wlSearch = document.getElementById('whitelist-search');
  wlSearch?.addEventListener('input', () => {
    whitelistQuery = wlSearch.value;
    renderWhitelistView();
  });

  document.getElementById('add-rule-domain')?.addEventListener('click', addRuleDomainFromInput);
  document.getElementById('new-rule-domain')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addRuleDomainFromInput(); }
  });

  // Activity filter chips
  document.querySelectorAll('.activity-toolbar .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      logFilter = btn.dataset.filter || 'all';
      document.querySelectorAll('.activity-toolbar .chip').forEach(b => b.classList.toggle('is-active', b === btn));
      renderLog();
    });
  });

  document.getElementById('clear-log').addEventListener('click', async () => {
    if (!confirm('Clear the entire activity log?')) return;
    await chrome.storage.local.set({ deletionLog: [], cleanedToday: 0 });
    allLogs = [];
    renderLog();
    flashSaved('Log cleared');
  });

  document.getElementById('export-config').addEventListener('click', exportConfig);
  document.getElementById('import-config').addEventListener('click', importConfig);
  document.getElementById('reset').addEventListener('click', async () => {
    if (!confirm('Reset all settings, lists, log, and stats? This cannot be undone.')) return;
    await Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]);
    location.reload();
  });
}

// === Section nav (scrollspy + click-to-scroll) ===
function setupSectionNav() {
  const sections = document.querySelectorAll('.section');
  const navItems = document.querySelectorAll('.sidenav-item');

  // Update on hash navigation
  if (location.hash) {
    const id = location.hash.slice(1);
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
  }

  // Scrollspy
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const id = e.target.id;
        navItems.forEach(n => n.classList.toggle('is-active', n.dataset.section === id));
      }
    }
  }, { rootMargin: '-30% 0px -65% 0px', threshold: 0 });
  sections.forEach(s => observer.observe(s));
}

// === Permission gating ===
// Call chrome.permissions.request directly inside the user-gesture click
// handler. Awaiting contains() first can lose the gesture chain on some
// Chrome versions, causing the prompt to silently auto-deny. request() is
// idempotent — returns true immediately when already granted.
async function ensureBrowsingDataPermission(reason) {
  const banner = document.getElementById('bd-status');
  showBdBanner(banner, '', `Asking Chrome for permission to clear ${labelForReason(reason)}…`);

  try {
    const granted = await chrome.permissions.request({ permissions: ['browsingData'] });
    if (granted) {
      showBdBanner(banner, 'success', 'Permission granted — CookieMaid can now clear browser storage.');
      autoHideBanner(banner, 4000);
      return true;
    }
    showBdBanner(banner, 'danger', 'Permission denied. CookieMaid will keep cleaning cookies only. Click a checkbox above to try again.');
    autoHideBanner(banner, 6000);
    return false;
  } catch (e) {
    showBdBanner(banner, 'danger', `Could not request permission: ${e?.message || 'unknown error'}`);
    autoHideBanner(banner, 6000);
    return false;
  }
}

function labelForReason(reason) {
  return ({
    cleanLocalStorage: 'LocalStorage',
    cleanIndexedDB: 'IndexedDB',
    cleanCache: 'cache',
    cleanServiceWorkers: 'service workers',
  })[reason] || 'browser storage';
}

function showBdBanner(el, kind, text) {
  el.classList.remove('hidden', 'danger', 'success');
  if (kind) el.classList.add(kind);
  el.replaceChildren(document.createTextNode(text));
}

let bannerHideTimer = null;
function autoHideBanner(el, ms) {
  clearTimeout(bannerHideTimer);
  bannerHideTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

async function refreshBrowsingDataStatus() {
  const has = await chrome.permissions.contains({ permissions: ['browsingData'] });
  const banner = document.getElementById('bd-status');
  if (has) {
    banner.classList.add('hidden');
    return;
  }
  // Permission missing but checkbox(es) still checked — show actionable banner
  // with a re-grant button. Don't silently uncheck — that loses user intent.
  const anyChecked = BD_CHECKBOXES.some(k => document.getElementById(k)?.checked);
  if (!anyChecked) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden', 'success');
  banner.classList.add('danger');
  banner.replaceChildren();
  const text = document.createElement('span');
  text.textContent = 'Storage cleanup is enabled but Chrome permission was revoked. ';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'banner-action';
  btn.textContent = 'Grant again';
  btn.addEventListener('click', async () => {
    // User gesture → safe to call request directly.
    const granted = await chrome.permissions.request({ permissions: ['browsingData'] });
    if (granted) {
      banner.classList.remove('danger');
      banner.classList.add('success');
      banner.replaceChildren(document.createTextNode('Permission granted.'));
      autoHideBanner(banner, 3000);
    }
  });
  banner.append(text, btn);
}

// === Sync status ===
async function refreshSyncStatus() {
  const el = document.getElementById('sync-status');
  try {
    const bytes = await chrome.storage.sync.getBytesInUse(null);
    const kb = (bytes / 1024).toFixed(1);
    el.textContent = `Synced via your Chrome account · using ${kb} KB of 100 KB.`;
    el.classList.add('success');
  } catch {
    el.classList.add('danger');
    el.textContent = 'Sync is unavailable on this browser — settings stay local.';
  }
}

// === Renderers ===
// Sorted snapshot of the stored whitelist + the active search query. Held in
// module scope so typing in the search box filters without re-reading storage,
// and so a remove/sync update re-applies the current filter.
let whitelistWild = [];       // wildcard entries (host + subdomains)
let whitelistExactArr = [];   // exact entries (host only)
let whitelistQuery = '';

function renderWhitelist(wild, exact = []) {
  whitelistWild = Array.isArray(wild) ? wild : [];
  whitelistExactArr = Array.isArray(exact) ? exact : [];
  renderWhitelistView();
}

function renderWhitelistView() {
  const el = document.getElementById('whitelist-list');
  // Merge both lists into one display, tagging exact entries. Sort a copy so
  // storage order is untouched; entries can arrive from any surface / device.
  const items = [
    ...whitelistWild.map(host => ({ host, exact: false })),
    ...whitelistExactArr.map(host => ({ host, exact: true })),
  ].sort((a, b) => a.host.localeCompare(b.host));

  // The search box is only useful once there's something to search.
  document.getElementById('whitelist-search-row')?.classList.toggle('hidden', items.length === 0);

  if (!items.length) {
    el.replaceChildren(emptyLi('No whitelisted sites yet. Add the first one above.'));
    return;
  }
  const q = whitelistQuery.trim().toLowerCase();
  const shown = q ? items.filter(it => it.host.includes(q)) : items;
  if (!shown.length) {
    el.replaceChildren(emptyLi(`No whitelisted sites match “${whitelistQuery.trim()}”.`));
    return;
  }
  // Mutate via the background so this write shares its serializeWrite queue
  // (a direct storage.sync write here can lose a concurrent context-menu /
  // popup / synced-device update). The list re-renders from storage.onChanged.
  el.replaceChildren(...shown.map(({ host, exact }) => entryRow(host, async () => {
    await chrome.runtime.sendMessage(
      exact ? { action: 'remove-whitelist-exact', hostname: host }
            : { action: 'remove-whitelist', hostname: host, exact: true });
    flashSaved(`Removed ${host}`);
  }, exact ? 'this host only' : '')));
}

function renderGreylist(grey) {
  const el = document.getElementById('greylist-list');
  const entries = Object.entries(grey).filter(([, exp]) => exp > Date.now());
  if (!entries.length) {
    el.replaceChildren(emptyLi('No greylisted sites. Use the popup to add one.'));
    return;
  }
  el.replaceChildren(...entries.map(([d, exp]) => {
    const days = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
    const meta = days === 0 ? '<1 day left' : `${days} day${days === 1 ? '' : 's'} left`;
    return entryRow(d, async () => {
      await chrome.runtime.sendMessage({ action: 'remove-greylist', hostname: d });
      flashSaved(`Removed ${d}`);
    }, meta);
  }));
}

// === Cookie rules (advanced) ===
// Snapshot of the stored cookieRules object; re-rendered from storage.onChanged
// after every mutation so the editor reflects writes from another tab/device.
let cookieRulesState = {};

// Reserved key for GLOBAL rules (apply to every site). Mirrors GLOBAL_RULES_KEY
// in background.js — keep the two in sync.
const GLOBAL_KEY = '*';

// One-click presets. Name-based rules only pay off for cookies whose names are
// identical across thousands of sites, so every preset targets the global ('*')
// scope. Keep rules protect a cookie even on non-whitelisted sites; delete rules
// wipe it even on whitelisted ones.
const RULE_PRESETS = [
  {
    id: 'cf-clearance',
    label: 'Keep Cloudflare clearance',
    desc: 'Stops the “Checking your browser…” challenge re-appearing every visit.',
    keep: true,
    names: ['cf_clearance'],
  },
  {
    id: 'consent',
    label: 'Keep cookie-consent choices',
    desc: 'Remembers “Reject all / Accept” so consent banners stop popping up.',
    keep: true,
    names: ['OptanonConsent', 'OptanonAlertBoxClosed', 'CookieConsent', 'euconsent-v2', 'cookie_consent'],
  },
  {
    id: 'ga',
    label: 'Always remove Google Analytics',
    desc: 'Wipes _ga / _gid / GA4 cookies everywhere — even on whitelisted sites.',
    keep: false,
    names: ['_ga', '_ga_*', '_gid', '_gat', '_gat_*', '_gac_*', '__utm*'],
  },
  {
    id: 'meta',
    label: 'Always remove Meta / Facebook tracking',
    desc: 'Wipes the _fbp / _fbc / fr advertising cookies everywhere.',
    keep: false,
    names: ['_fbp', '_fbc', 'fr'],
  },
];

async function applyPreset(preset) {
  let added = 0;
  let full = false;
  for (const name of preset.names) {
    const resp = await chrome.runtime.sendMessage({
      action: 'rule-add', domain: GLOBAL_KEY, name, keep: preset.keep,
    });
    const r = resp?.result;
    if (r === 'added') added++;
    else if (r === 'full') { full = true; break; }
    // 'duplicate' / anything else → already present or skipped; keep going.
  }
  if (full) flashSaved('Rule storage full — some not added');
  else if (added) flashSaved(`Added ${added} rule${added > 1 ? 's' : ''}`);
  else flashSaved('Already added');
}

function renderPresets() {
  const host = document.getElementById('rule-presets');
  if (!host) return;
  host.replaceChildren(...RULE_PRESETS.map((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    const title = document.createElement('span');
    title.className = 'preset-title';
    const chip = document.createElement('span');
    chip.className = preset.keep ? 'chip keep' : 'chip warn';
    chip.textContent = preset.keep ? 'Keep' : 'Delete';
    const label = document.createElement('span');
    label.textContent = preset.label;
    title.append(chip, label);
    const desc = document.createElement('span');
    desc.className = 'preset-desc';
    desc.textContent = preset.desc;
    btn.append(title, desc);
    btn.addEventListener('click', () => applyPreset(preset));
    return btn;
  }));
}

function bindCookieRules(enabled, rules) {
  cookieRulesState = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
  const toggle = document.getElementById('enableCookieRules');
  const editor = document.getElementById('rules-editor');
  if (toggle) {
    toggle.checked = enabled;
    toggle.addEventListener('change', async (e) => {
      const on = e.target.checked;
      editor?.classList.toggle('hidden', !on);
      await chrome.storage.sync.set({ enableCookieRules: on });
      flashSaved();
    });
  }
  editor?.classList.toggle('hidden', !enabled);
  renderPresets();
  renderCookieRules();
}

function renderCookieRules() {
  const host = document.getElementById('rules-list');
  if (!host) return;
  const cards = [];
  // Global card is always shown first so presets and all-site rules have a
  // stable home, even before any rule exists.
  const globalRules = Array.isArray(cookieRulesState[GLOBAL_KEY]) ? cookieRulesState[GLOBAL_KEY] : [];
  cards.push(ruleCard(GLOBAL_KEY, globalRules, {
    title: 'All sites (global)',
    global: true,
    empty: 'No global rules yet. Use a preset above, or type a cookie name to keep/delete it on every site.',
  }));
  const domains = Object.keys(cookieRulesState)
    .filter(d => d !== GLOBAL_KEY)
    .sort((a, b) => a.localeCompare(b));
  for (const d of domains) cards.push(ruleCard(d, cookieRulesState[d] || []));
  host.replaceChildren(...cards);
}

function ruleCard(domain, rules, opts = {}) {
  const card = document.createElement('div');
  card.className = opts.global ? 'rule-card rule-card-global' : 'rule-card';

  const head = document.createElement('div');
  head.className = 'rule-card-head';
  const name = document.createElement('span');
  name.className = 'domain';
  name.textContent = opts.title || domain;
  head.append(name);
  // Per-domain cards carry a "remove whole domain" ×; the global card doesn't
  // (you remove its individual rules), so its bucket can't be deleted by accident.
  if (!opts.global) {
    const del = document.createElement('button');
    del.className = 'remove';
    del.type = 'button';
    del.title = 'Remove this domain and all its rules';
    del.setAttribute('aria-label', `Remove ${domain}`);
    del.textContent = '×';
    del.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'rule-remove-domain', domain });
      flashSaved(`Removed ${domain}`);
    });
    head.append(del);
  }

  const list = document.createElement('ul');
  list.className = 'rule-rows entry-list compact';
  if (!Array.isArray(rules) || !rules.length) {
    list.append(emptyLi(opts.empty || 'No rules yet — this domain behaves normally until you add one.'));
  } else {
    rules.forEach((r) => list.append(ruleRow(domain, r)));
  }

  card.append(head, list, buildRuleAdder(domain));
  return card;
}

function ruleRow(domain, rule) {
  const li = document.createElement('li');
  li.className = 'rule-row';
  const badge = document.createElement('span');
  badge.className = rule.keep ? 'chip keep' : 'chip warn';
  badge.textContent = rule.keep ? 'Keep' : 'Delete';
  const pat = document.createElement('code');
  pat.className = 'rule-pattern';
  pat.textContent = rule.name;
  pat.style.flex = '1';
  const rm = document.createElement('button');
  rm.className = 'remove';
  rm.type = 'button';
  rm.title = 'Remove rule';
  rm.setAttribute('aria-label', `Remove rule ${rule.name}`);
  rm.textContent = '×';
  // Remove by name, not index: matches the background writer and avoids a stale
  // positional index if the list changed under us (another tab/synced device).
  rm.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'rule-remove', domain, name: rule.name });
    flashSaved('Rule removed');
  });
  li.append(badge, pat, rm);
  return li;
}

function buildRuleAdder(domain) {
  const wrap = document.createElement('div');
  wrap.className = 'rule-add row inline';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'cookie name or _ga*';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const select = document.createElement('select');
  select.className = 'select';
  for (const [val, label] of [['keep', 'Keep'], ['delete', 'Delete']]) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    select.append(o);
  }
  const btn = document.createElement('button');
  btn.className = 'btn btn-secondary';
  btn.type = 'button';
  btn.textContent = 'Add rule';
  const submit = async () => {
    const ruleName = input.value.trim();
    if (!ruleName) return;
    const resp = await chrome.runtime.sendMessage({
      action: 'rule-add', domain, name: ruleName, keep: select.value === 'keep',
    });
    const result = resp?.result;
    if (result === 'added') {
      input.setCustomValidity('');
      input.value = '';
      flashSaved('Rule added');
      return;
    }
    if (result === 'duplicate') { input.value = ''; return; }
    if (result === 'full') {
      input.setCustomValidity('This domain is full — max 20 rules, or the rule set hit its storage limit.');
      input.reportValidity();
      return;
    }
    // 'invalid' | 'no-domain' | undefined (message threw) — never falsely report success.
    input.setCustomValidity('Enter a valid cookie name (no spaces, ; or =). Use * for wildcards.');
    input.reportValidity();
  };
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  btn.addEventListener('click', submit);
  wrap.append(input, select, btn);
  return wrap;
}

async function addRuleDomainFromInput() {
  const input = document.getElementById('new-rule-domain');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;
  let domain = raw;
  if (/^https?:\/\//.test(raw)) { try { domain = new URL(raw).hostname; } catch {} }
  domain = domain.replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!domain || !/\./.test(domain)) {
    input.setCustomValidity('Use a domain like example.com');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  const resp = await chrome.runtime.sendMessage({ action: 'rule-add-domain', domain });
  const result = resp?.result;
  if (result === 'added') { input.value = ''; flashSaved(`Added ${domain}`); return; }
  if (result === 'duplicate') { input.value = ''; return; }
  if (result === 'full') {
    input.setCustomValidity('Rule storage is full (max 50 domains / ~7 KB). Remove some first.');
    input.reportValidity();
    return;
  }
  // 'invalid' | undefined — surface rather than falsely report "Added".
  input.setCustomValidity('Use a domain like example.com');
  input.reportValidity();
}

function renderLog() {
  const el = document.getElementById('log-list');
  const filtered = filterLogs(allLogs, logFilter);
  if (!filtered.length) {
    el.replaceChildren(emptyLi('No deletions yet. Close a tab on a non-whitelisted site.'));
    return;
  }
  el.replaceChildren(...filtered.slice(0, 100).map(e => {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatRelative(e.timestamp);
    time.title = new Date(e.timestamp).toLocaleString();
    const domain = document.createElement('span');
    domain.className = 'domain';
    domain.textContent = e.domain;
    domain.style.flex = '1';
    domain.style.overflow = 'hidden';
    domain.style.textOverflow = 'ellipsis';
    domain.style.whiteSpace = 'nowrap';
    const count = document.createElement('span');
    count.className = 'log-count';
    count.textContent = `${e.count}`;
    li.append(time, domain, count);
    return li;
  }));
}

function filterLogs(logs, filter) {
  if (filter === 'all') return logs;
  return logs.filter(e => {
    if (filter === 'tab') return !['scheduled-sweep', 'manual-clean-all', 'startup-cleanup'].includes(e.domain);
    if (filter === 'scheduled') return e.domain === 'scheduled-sweep' || e.domain === 'startup-cleanup';
    if (filter === 'manual') return e.domain === 'manual-clean-all';
    return true;
  });
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function emptyLi(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function entryRow(domain, onRemove, suffix = '') {
  const li = document.createElement('li');
  const left = document.createElement('span');
  left.className = 'domain';
  left.textContent = domain;
  if (suffix) {
    const small = document.createElement('small');
    small.textContent = suffix;
    left.append(' ', small);
  }
  const btn = document.createElement('button');
  btn.className = 'remove';
  btn.type = 'button';
  btn.title = 'Remove';
  btn.setAttribute('aria-label', `Remove ${domain}`);
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  li.append(left, btn);
  return li;
}

async function addWhitelistFromInput() {
  const input = document.getElementById('new-whitelist');
  const raw = input.value.trim().toLowerCase();
  if (!raw) return;
  let domain = raw;
  if (/^https?:\/\//.test(raw)) {
    try { domain = new URL(raw).hostname; } catch {}
  }
  domain = domain.replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!domain || !/\./.test(domain)) {
    input.setCustomValidity('Use a domain like example.com');
    input.reportValidity();
    return;
  }
  // Reject a bare public suffix (co.uk, com.au, github.io, …). Whitelisting one
  // would cover every unrelated site under it — the same footgun the popup/menu
  // avoid by never offering a suffix as the "whole domain". Only the recognized
  // multi-part suffixes are caught (single-label TLDs already fail the dot test).
  if (MULTI_SUFFIXES.has(domain)) {
    input.setCustomValidity(`“${domain}” is a public suffix — add a specific domain like example.${domain}`);
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');

  // Scope choice: "Whole site" → wildcard entry (host + subdomains, as before);
  // "This host only" → exact entry, same as the popup's caret option — so
  // first-time setups can add exact entries without visiting each site.
  const exact = document.getElementById('new-whitelist-scope')?.value === 'exact';

  // Add via the background (shared serializeWrite queue). The list re-renders
  // from the storage.onChanged listener once the write lands.
  const resp = await chrome.runtime.sendMessage({
    action: exact ? 'add-whitelist-exact' : 'add-whitelist',
    hostname: domain,
  });
  const result = resp?.result;
  if (result === 'duplicate') {
    input.value = '';
    return;
  }
  if (result === 'covered') {
    // A broader parent entry already protects this host — nothing added.
    input.value = '';
    flashSaved(`${domain} is already covered by a broader entry`);
    return;
  }
  if (result === 'full') {
    input.setCustomValidity('Whitelist is full (500 max). Remove an entry first.');
    input.reportValidity();
    return;
  }
  input.value = '';
  flashSaved(exact ? `Whitelisted ${domain} — this host only` : `Whitelisted ${domain}`);
}

async function exportConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(null),
  ]);
  // The activity log is deliberately NOT exported: a list of every site you've
  // cleaned is browsing history, and these files end up on external disks and
  // in git repos. It also grows the file for no benefit — the log is device-
  // local state, not configuration. (Import still accepts old files that have
  // it, via sanitizeLocal.) The aggregate counters stay — they carry no sites.
  delete local.deletionLog;
  const payload = {
    _format: 'cookieflush-config-v1',
    _exportedAt: new Date().toISOString(),
    sync,
    local,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cookiemaid-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  flashSaved('Config exported');
}

function importConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (typeof data !== 'object' || data === null) throw new Error('bad shape');
      const sync = data._format === 'cookieflush-config-v1' && data.sync ? data.sync : data;
      const local = data._format === 'cookieflush-config-v1' && data.local ? data.local : null;
      if (!confirm('Import will replace your current whitelist, greylist, settings, and log. Continue?')) return;
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(sanitizeSync(sync));
      if (local) {
        await chrome.storage.local.clear();
        await chrome.storage.local.set(sanitizeLocal(local));
      }
      location.reload();
    } catch (e) {
      alert('Invalid config file: ' + (e?.message || e));
    }
  };
  input.click();
}

function sanitizeSync(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of [...SYNC_BOOL, 'enabled', 'enableCookieRules']) {
    if (typeof obj[k] === 'boolean') out[k] = obj[k];
  }
  for (const k of SYNC_NUM) {
    if (Number.isFinite(obj[k])) out[k] = obj[k];
  }
  // RFC-1035 caps DNS names at 253 chars; anything longer in an imported
  // file is either junk or a layout-breaking probe, so drop it.
  const isValidDomain = (d) => typeof d === 'string' && d.length > 0 && d.length <= 253 && /\./.test(d);
  // 500 domains × ~12 bytes ≈ 6 KB, leaving room within chrome.storage.sync's
  // 8 KB/key limit. A 5000 cap would silently break the next sync.set().
  if (Array.isArray(obj.whitelist)) {
    out.whitelist = obj.whitelist.filter(isValidDomain).slice(0, 500);
  }
  if (Array.isArray(obj.whitelistExact)) {
    out.whitelistExact = obj.whitelistExact.filter(isValidDomain).slice(0, 500);
  }
  if (obj.greylist && typeof obj.greylist === 'object' && !Array.isArray(obj.greylist)) {
    const grey = {};
    // Cap expiry at 1 year in the future — anything past that is either
    // junk from a crafted import or a year-9999 timestamp that nothing
    // honors anyway. Past timestamps are dropped (greylist semantics).
    const maxExp = Date.now() + 365 * 86400 * 1000;
    const now = Date.now();
    for (const [d, exp] of Object.entries(obj.greylist)) {
      if (!isValidDomain(d)) continue;
      if (!Number.isFinite(exp)) continue;
      if (exp <= now || exp > maxExp) continue;
      grey[d] = exp;
    }
    out.greylist = grey;
  }
  // Cookie rules: mirror the background writers' caps (50 domains × 20 rules,
  // 64-char names) AND the ~7 KB serialized budget so an imported file can't
  // blow past chrome.storage.sync's 8 KB/key limit or smuggle malformed entries
  // past the cleanup engine.
  if (obj.cookieRules && typeof obj.cookieRules === 'object' && !Array.isArray(obj.cookieRules)) {
    const cr = {};
    let domains = 0;
    for (const [d, list] of Object.entries(obj.cookieRules)) {
      if (domains >= 50) break;
      // '*' is the reserved global-rules bucket; every other key must be a domain.
      if ((d !== GLOBAL_KEY && !isValidDomain(d)) || !Array.isArray(list)) continue;
      const rules = [];
      for (const r of list) {
        if (rules.length >= 20) break;
        if (!r || typeof r.name !== 'string') continue;
        const name = r.name.trim();
        if (!name || name.length > 64 || /[\s;=]/.test(name)) continue;
        if (rules.some(x => x.name.toLowerCase() === name.toLowerCase())) continue;
        rules.push({ name, keep: !!r.keep });
      }
      const candidate = { ...cr, [d]: rules };
      // UTF-8 bytes, not String.length — the storage.sync 8 KB/item quota is bytes.
      if (new TextEncoder().encode(JSON.stringify(candidate)).length > 7000) break;
      cr[d] = rules;
      domains++;
    }
    out.cookieRules = cr;
  }
  return out;
}
function sanitizeLocal(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.deletionLog)) {
    out.deletionLog = obj.deletionLog
      .filter(e => e && typeof e === 'object'
        && typeof e.domain === 'string' && e.domain.length > 0 && e.domain.length <= 253
        && Number.isFinite(e.timestamp) && Number.isFinite(e.count))
      .slice(0, 200);
  }
  if (Number.isFinite(obj.totalCleaned)) out.totalCleaned = obj.totalCleaned;
  if (Number.isFinite(obj.cleanedToday)) out.cleanedToday = obj.cleanedToday;
  return out;
}

// === Save indicator ===
let saveTimer = null;
function flashSaved(message = 'Saved') {
  const el = document.getElementById('save-indicator');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

init();
