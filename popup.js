import { registrableDomain } from './lib/registrable-domain.js';

const els = {
  toggle: document.getElementById('toggle-enabled'),
  hero: document.getElementById('hero'),
  status: document.getElementById('site-status'),
  domain: document.getElementById('site-name'),
  meta: document.getElementById('hero-meta'),
  primary: document.getElementById('primary-action'),
  kbdHint: document.getElementById('primary-kbd-hint'),
  wlCaret: document.getElementById('wl-caret'),
  wlMenu: document.getElementById('wl-menu'),
  wlSubBtn: document.getElementById('wl-sub'),
  wlDomainBtn: document.getElementById('wl-domain'),
  greyBtn: document.getElementById('greylist-btn'),
  cleanBtn: document.getElementById('clean-btn'),
  cleanAllBtn: document.getElementById('clean-all-btn'),
  totalCleaned: document.getElementById('total-cleaned'),
  whitelistCount: document.getElementById('whitelist-count'),
  liveRegion: document.getElementById('live-region'),
  versionMeta: document.getElementById('version-meta'),
};

let state = {
  enabled: true,
  hostname: null,
  whitelist: [],
  whitelistExact: [],
  greylist: {},
  greylistDurationDays: 7,
  cleanOnTabClose: true,
  cleanOnNavigation: false,
  cleanOnStartup: false,
  scheduledCleanupMinutes: 0,
  isWhite: false,
  isGrey: false,
  isInternal: false,
  registrable: null,   // eTLD+1 when confidently resolved, else null
  isSubdomain: false,  // true when hostname is a subdomain of registrable
  whitelistTarget: null, // what the primary button whitelists (whole site)
};

async function init() {
  applyI18n();
  if (els.versionMeta) els.versionMeta.textContent = `v${chrome.runtime.getManifest().version}`;

  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['enabled', 'whitelist', 'whitelistExact', 'greylist', 'greylistDurationDays', 'cleanOnTabClose', 'cleanOnNavigation', 'cleanOnStartup', 'scheduledCleanupMinutes']),
    chrome.storage.local.get(['totalCleaned']),
  ]);

  state.enabled = sync.enabled !== false;
  state.whitelist = Array.isArray(sync.whitelist) ? sync.whitelist : [];
  state.whitelistExact = Array.isArray(sync.whitelistExact) ? sync.whitelistExact : [];
  state.greylist = (sync.greylist && typeof sync.greylist === 'object' && !Array.isArray(sync.greylist)) ? sync.greylist : {};
  state.greylistDurationDays = Number.isFinite(sync.greylistDurationDays) ? sync.greylistDurationDays : 7;
  state.cleanOnTabClose = sync.cleanOnTabClose !== false;
  state.cleanOnNavigation = !!sync.cleanOnNavigation;
  state.cleanOnStartup = !!sync.cleanOnStartup;
  state.scheduledCleanupMinutes = Number.isFinite(sync.scheduledCleanupMinutes) ? sync.scheduledCleanupMinutes : 0;

  els.toggle.checked = state.enabled;
  document.body.classList.toggle('is-disabled', !state.enabled);
  setStatNum(els.totalCleaned, local.totalCleaned || 0, 'cookies cleaned total');
  setStatNum(els.whitelistCount, state.whitelist.length, 'sites whitelisted');

  els.toggle.addEventListener('change', onToggleChange);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  resolveSite(tab);
  renderHero();
  bindActions();

  // Focus the primary CTA (not the toggle) so a stray Space press doesn't
  // accidentally toggle the extension. The primary button is live even while
  // paused now, so focus it regardless of the enabled state. When the subdomain
  // choice replaces the primary button, focus its first option instead.
  if (!state.isInternal) {
    requestAnimationFrame(() => els.primary.focus());
  }
}

function resolveSite(tab) {
  if (!tab?.url) { state.isInternal = true; return; }
  let u;
  try { u = new URL(tab.url); } catch { state.isInternal = true; return; }

  // Treat chrome://, about:, edge://, extension://, file://, view-source: as internal.
  const internalSchemes = ['chrome:', 'about:', 'edge:', 'chrome-extension:', 'moz-extension:', 'view-source:', 'file:', 'devtools:'];
  if (internalSchemes.includes(u.protocol) || !u.hostname) {
    state.isInternal = true;
    return;
  }
  // Drop a trailing dot (fully-qualified `example.com.`) then www — otherwise the
  // apex would look like a subdomain of itself and offer a bogus choice, and the
  // stored entry (`example.com.`) wouldn't match real cookies.
  state.hostname = u.hostname.replace(/\.$/, '').replace(/^www\./, '');

  // Resolve the registrable domain so the whitelist action can offer "this
  // subdomain only" vs "the whole domain". Null (unresolved suffix) or a
  // registrable that equals the host (not a subdomain) → no choice, single button.
  state.registrable = registrableDomain(state.hostname);
  state.isSubdomain = !!state.registrable && state.registrable !== state.hostname;
  // The primary button whitelists the whole site (what "this site" means to most
  // people); on an apex/unresolved host that's just the host itself.
  state.whitelistTarget = state.registrable || state.hostname;

  // Check status
  state.isWhite = state.whitelist.some(w => state.hostname === w || state.hostname.endsWith('.' + w)) ||
                  state.whitelistExact.includes(state.hostname);
  const greyExp = state.greylist[state.hostname];
  state.isGrey = !!greyExp && greyExp > Date.now();
}

function renderHero() {
  // Always start from a clean baseline — re-renders (e.g. after the toggle
  // flips) used to leak `disabled = true` from the prior state.
  const defaultGreyLabel = `Greylist ${state.greylistDurationDays}d`;
  els.primary.disabled = false;
  els.primary.hidden = false;
  els.greyBtn.disabled = false;
  els.cleanBtn.disabled = false;
  els.greyBtn.textContent = defaultGreyLabel;
  els.greyBtn.dataset.action = 'greylist';
  els.kbdHint.style.visibility = 'visible';
  els.kbdHint.style.display = '';
  els.meta.hidden = true;
  // The scope caret + its menu are opt-in per render (only the plain "whitelist
  // this site" state on a subdomain shows them); collapse by default so no other
  // state leaks them.
  if (els.wlCaret) els.wlCaret.hidden = true;
  if (els.wlMenu) { els.wlMenu.hidden = true; els.wlCaret?.setAttribute('aria-expanded', 'false'); }

  if (state.isInternal) {
    els.status.className = 'pill neutral';
    els.status.textContent = 'NOT A WEBSITE';
    els.domain.textContent = 'Internal page';
    els.meta.hidden = false;
    els.meta.textContent = 'Open a regular website to use CookieMaid.';
    els.primary.disabled = true;
    els.greyBtn.disabled = true;
    els.cleanBtn.disabled = true;
    els.kbdHint.style.visibility = 'hidden';
    return;
  }

  els.domain.textContent = state.hostname;

  // The action buttons are configured the same whether or not auto-cleanup is on:
  // whitelist/greylist are list management, and "Clean now" is a manual action —
  // none of them depend on the enabled toggle (which only gates AUTOMATIC cleaning).
  // When paused we just overlay the PAUSED status pill at the end; the buttons stay
  // live. (Previously this block early-returned and disabled them.)
  if (state.isWhite) {
    els.status.className = 'pill whitelisted';
    els.status.textContent = 'WHITELISTED';
    els.primary.querySelector('.btn-label').textContent = 'Remove from whitelist';
    els.primary.dataset.action = 'remove-whitelist';
    els.greyBtn.disabled = true;
    els.kbdHint.style.visibility = 'hidden';
  } else if (state.isGrey) {
    const exp = new Date(state.greylist[state.hostname]).toLocaleDateString();
    els.status.className = 'pill greylisted';
    els.status.textContent = `GREYLISTED · expires ${exp}`;
    els.primary.querySelector('.btn-label').textContent = 'Whitelist permanently';
    els.primary.dataset.action = 'whitelist';
    els.greyBtn.textContent = 'Remove greylist';
    els.greyBtn.dataset.action = 'remove-greylist';
  } else {
    const mode = activeCleanupMode();
    if (mode) {
      els.status.className = 'pill cleaning';
      els.status.textContent = mode;
    } else {
      els.status.className = 'pill paused';
      els.status.textContent = 'AUTO-CLEAN OFF';
      els.meta.hidden = false;
      els.meta.textContent = 'No cleanup trigger is enabled. Open Settings to turn one on.';
    }
    els.primary.querySelector('.btn-label').textContent = chrome.i18n.getMessage('whitelistBtn') || 'Whitelist this site';
    els.primary.dataset.action = 'whitelist';

    // Reveal the caret next to the primary button on every site. The button
    // whitelists the whole site (domain + subdomains); the caret menu offers the
    // exact scopes in plain language — "keep all of <domain>" vs "only <host>",
    // which on an apex reads "all of cnn.com" vs "only cnn.com".
    if (els.wlCaret) {
      els.wlCaret.hidden = false;
      // Hide the keyboard-shortcut hint: the split control shifts the layout and
      // the shortcut targets the exact host, not the button's whole-site default.
      els.kbdHint.style.display = 'none';
      els.wlDomainBtn.textContent = `Keep all of *.${state.whitelistTarget}`;
      els.wlSubBtn.textContent = `Only ${state.hostname}`;
    }
  }

  // Paused overlay: auto-cleanup off overrides only the STATUS pill + meta. The
  // buttons configured above stay live (the whitelist/greylist label set above
  // still tells the user which list the site is on).
  if (!state.enabled) {
    els.status.className = 'pill paused';
    els.status.textContent = 'PAUSED';
    els.meta.hidden = false;
    els.meta.textContent = 'Auto-cleanup is off — sites are not cleaned automatically. You can still whitelist, greylist, or clean a site manually. Flip the toggle to resume.';
  }
}

function activeCleanupMode() {
  if (state.cleanOnTabClose) return 'WILL CLEAN ON CLOSE';
  if (state.cleanOnNavigation) return 'WILL CLEAN ON NAV';
  if (state.cleanOnStartup) return 'CLEANS AT STARTUP';
  if (state.scheduledCleanupMinutes > 0) return 'CLEANS ON SCHEDULE';
  return null;
}

function bindActions() {
  els.primary.addEventListener('click', async () => {
    const action = els.primary.dataset.action || 'whitelist';
    if (state.isInternal || !state.hostname) return;
    try {
      if (action === 'whitelist') {
        // Primary button = whole site (registrable domain); apex falls back to
        // the host. The caret menu is for the exact-host option.
        const target = state.whitelistTarget || state.hostname;
        const ok = await addWhitelist(target);
        if (ok === 'duplicate') {
          announce(`${target} is already whitelisted`);
        } else if (ok === 'covered') {
          announce(`${target} is already covered by a broader whitelist entry`);
        } else if (ok === 'full') {
          announce(`Whitelist is full (500 max). Open Settings to remove one.`);
          return;
        } else {
          announce(`Whitelisted ${target}`);
        }
      } else if (action === 'remove-whitelist') {
        const removed = await removeWhitelist(state.hostname);
        if (removed) {
          announce(`Removed ${removed} from whitelist`);
        } else {
          announce(`${state.hostname} is not in the whitelist`);
        }
      }
    } catch (e) {
      announce(`Couldn't save — ${e?.message || 'error'}`);
    }
    window.close();
  });

  // Subdomain whitelist choice — each button whitelists a specific, explicitly
  // shown target: the current subdomain, or its registrable domain (+ all
  // subdomains). Both funnel through the same background write as the primary
  // button, so dedup/limit handling is identical.
  const whitelistTarget = async (host, scopeNote, exact = false) => {
    if (state.isInternal || !host) return;
    try {
      const ok = exact ? await addWhitelistExact(host) : await addWhitelist(host);
      if (ok === 'duplicate') {
        announce(`${host} is already whitelisted`);
      } else if (ok === 'covered') {
        announce(`${host} is already covered by a broader whitelist entry`);
      } else if (ok === 'full') {
        announce('Whitelist is full (500 max). Open Settings to remove one.');
        return;
      } else {
        announce(`Whitelisted ${host}${scopeNote}`);
      }
    } catch (e) {
      announce(`Couldn't save — ${e?.message || 'error'}`);
    }
    window.close();
  };
  els.wlDomainBtn?.addEventListener('click', () => whitelistTarget(state.whitelistTarget, ' and all its subdomains', false));
  els.wlSubBtn?.addEventListener('click', () => whitelistTarget(state.hostname, ' (this exact address only)', true));

  // Caret dropdown holding the exact scope options.
  const closeMenu = () => {
    if (!els.wlMenu || els.wlMenu.hidden) return;
    els.wlMenu.hidden = true;
    els.wlCaret?.setAttribute('aria-expanded', 'false');
  };
  els.wlCaret?.addEventListener('click', (e) => {
    e.stopPropagation();   // don't let the document handler immediately re-close
    const willOpen = els.wlMenu.hidden;
    els.wlMenu.hidden = !willOpen;
    els.wlCaret.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) els.wlDomainBtn?.focus();
  });
  // Click anywhere outside closes the menu (but a click on a menu item runs its
  // own handler, which closes the whole popup).
  document.addEventListener('click', (e) => {
    if (els.wlMenu?.hidden) return;
    const t = e.target;
    if (!els.wlMenu.contains(t) && !els.wlCaret.contains(t)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.wlMenu && !els.wlMenu.hidden) {
      closeMenu();
      els.wlCaret?.focus();
    }
  });

  els.greyBtn.addEventListener('click', async () => {
    const action = els.greyBtn.dataset.action || 'greylist';
    if (state.isInternal || !state.hostname) return;
    try {
      if (action === 'greylist') {
        await chrome.runtime.sendMessage({ action: 'add-greylist', hostname: state.hostname });
        announce(`Greylisted ${state.hostname}`);
      } else {
        await removeGreylist(state.hostname);
        announce(`Removed ${state.hostname} from greylist`);
      }
    } catch (e) {
      announce(`Couldn't save — ${e?.message || 'error'}`);
    }
    window.close();
  });

  // Per-site manual clean. Unlike "Clean all" this only touches the active
  // site's own cookies, so it's a single click (no confirm step) — it never
  // signs the user out of any other tab.
  els.cleanBtn.addEventListener('click', async () => {
    if (state.isInternal || !state.hostname) return;
    els.cleanBtn.classList.add('loading');
    els.cleanBtn.disabled = true;
    els.primary.disabled = true;
    els.greyBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'force-clean', hostname: state.hostname });
      const count = resp?.count ?? 0;
      els.cleanBtn.classList.remove('loading');
      // Visible feedback before auto-close: the popup vanishing before the user
      // sees the result reads as "did nothing".
      if (count > 0) {
        announce(`Cleaned ${count} cookies for ${state.hostname}`);
        els.status.className = 'pill whitelisted';
        els.status.textContent = `CLEANED ${count}`;
        setTimeout(() => window.close(), 900);
      } else if (state.isWhite) {
        // Whitelisted sites short-circuit in the background and return 0 — be
        // explicit so it doesn't read as broken. Remove from whitelist first to
        // really clean it.
        announce(`${state.hostname} is whitelisted — nothing was cleaned`);
        els.status.className = 'pill neutral';
        els.status.textContent = 'SKIPPED (WHITELISTED)';
        setTimeout(() => window.close(), 1100);
      } else {
        announce(`Nothing to clean for ${state.hostname}`);
        els.status.className = 'pill neutral';
        els.status.textContent = 'NOTHING TO CLEAN';
        setTimeout(() => window.close(), 700);
      }
    } catch (e) {
      announce(`Couldn't clean — ${e?.message || 'error'}`);
      window.close();
    }
  });

  // Global sweep. Two-step (arm → confirm) because it signs the user out of
  // every non-whitelisted site, INCLUDING tabs open right now — too destructive
  // for a single stray click. The static caption under the button spells this
  // out; the confirm step guards against a misclick.
  const cleanAllLabel = els.cleanAllBtn.querySelector('.btn-label');
  const cleanAllDefault = cleanAllLabel.textContent;
  let confirmTimer = null;

  els.cleanAllBtn.addEventListener('click', async () => {
    if (els.cleanAllBtn.classList.contains('loading')) return;

    // First click — arm the confirmation and auto-disarm after a few seconds.
    if (!els.cleanAllBtn.classList.contains('confirm')) {
      els.cleanAllBtn.classList.add('confirm');
      cleanAllLabel.textContent = 'Click again to clear every site';
      announce('This signs you out of every non-whitelisted site, including open tabs. Click again to confirm.');
      confirmTimer = setTimeout(() => {
        els.cleanAllBtn.classList.remove('confirm');
        cleanAllLabel.textContent = cleanAllDefault;
      }, 3500);
      return;
    }

    // Second click — execute.
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    els.cleanAllBtn.classList.remove('confirm');
    els.cleanAllBtn.classList.add('loading');
    els.cleanAllBtn.disabled = true;
    els.primary.disabled = true;
    els.greyBtn.disabled = true;
    els.cleanBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'force-clean-all' });
      const count = resp?.count ?? 0;
      els.cleanAllBtn.classList.remove('loading');
      if (count > 0) {
        announce(`Cleared ${count} cookies across all non-whitelisted sites`);
        els.status.className = 'pill whitelisted';
        els.status.textContent = `CLEARED ${count}`;
        setTimeout(() => window.close(), 1000);
      } else {
        announce('Nothing to clean — no non-whitelisted cookies found');
        els.status.className = 'pill neutral';
        els.status.textContent = 'NOTHING TO CLEAN';
        setTimeout(() => window.close(), 800);
      }
    } catch (e) {
      els.cleanAllBtn.classList.remove('loading');
      els.cleanAllBtn.disabled = false;
      cleanAllLabel.textContent = cleanAllDefault;
      // renderHero re-derives primary/greylist enabled state from current state
      // (a blanket re-enable could wrongly light up buttons disabled for an
      // internal/paused page).
      renderHero();
      announce(`Couldn't clean — ${e?.message || 'error'}`);
    }
  });
}

async function onToggleChange(e) {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  state.enabled = e.target.checked;
  document.body.classList.toggle('is-disabled', !state.enabled);
  renderHero();
}

// All list mutations go through the background so they share its serializeWrite
// queue — writing chrome.storage.sync directly here would race a concurrent
// context-menu / keyboard / synced-device write and lose one of the updates.
async function addWhitelist(host) {
  const resp = await chrome.runtime.sendMessage({ action: 'add-whitelist', hostname: host });
  return resp?.result || 'added';
}

// Exact-scope variant — protects only `host`, not its subdomains.
async function addWhitelistExact(host) {
  const resp = await chrome.runtime.sendMessage({ action: 'add-whitelist-exact', hostname: host });
  return resp?.result || 'added';
}

// Returns the actually-removed entry (which may be a parent domain) or null.
// Critical for the "Remove from whitelist" popup button: when the popup shows
// WHITELISTED for mail.google.com because google.com is in the list, we must
// remove google.com, not mail.google.com (which isn't in the list at all). The
// background's removeFromWhitelist does that parent match (exact omitted).
async function removeWhitelist(host) {
  const resp = await chrome.runtime.sendMessage({ action: 'remove-whitelist', hostname: host });
  return resp?.removed || null;
}

async function removeGreylist(host) {
  await chrome.runtime.sendMessage({ action: 'remove-greylist', hostname: host });
}

function setStatNum(el, value, srSuffix) {
  el.textContent = formatNum(value);
  if (srSuffix) el.setAttribute('aria-label', `${value} ${srSuffix}`);
}

function formatNum(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function announce(text) {
  if (els.liveRegion) els.liveRegion.textContent = text;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
}

init();
