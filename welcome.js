const TARGET_DOMAINS = 3;
let added = [];

const els = {
  input: document.getElementById('domain-input'),
  addBtn: document.getElementById('add-domain'),
  list: document.getElementById('domains'),
  dots: document.getElementById('progress-dots').querySelectorAll('.dot'),
  progressText: document.getElementById('progress-text'),
  skipBtn: document.getElementById('skip-btn'),
  nextBtn: document.getElementById('next-btn'),
  grantBd: document.getElementById('grant-bd'),
  skipBd: document.getElementById('skip-bd'),
  permResult: document.getElementById('perm-result'),
  enableLaterBtn: document.getElementById('enable-later'),
  finishBtn: document.getElementById('finish-btn'),
  doneWhitelist: document.getElementById('done-whitelist'),
};

function init() {
  // Step 1 bindings — both Skip and Continue commit whatever is in `added`.
  // The difference is messaging, not behaviour: Skip = "I'm done picking",
  // Continue = "ship the 3+ I chose". Both persist any added domains.
  els.addBtn.addEventListener('click', addFromInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFromInput(); }
  });
  els.skipBtn.addEventListener('click', async () => {
    await commitWhitelist();
    goStep(2);
  });
  els.nextBtn.addEventListener('click', async () => {
    await commitWhitelist();
    goStep(2);
  });

  // Step 2 bindings
  els.grantBd.addEventListener('click', requestBrowsingData);
  els.skipBd.addEventListener('click', async () => {
    await chrome.storage.sync.set({
      cleanLocalStorage: false,
      cleanIndexedDB: false,
      cleanCache: false,
    });
    goStep(3);
  });

  // Step 3 bindings — finish enables auto-cleanup; "later" leaves it off.
  // The OFF default is set in background.js onInstalled; we only flip it
  // here if the user explicitly opts in.
  els.finishBtn.addEventListener('click', async () => {
    await chrome.storage.sync.set({ enabled: true });
    closeWelcomeTab();
  });
  els.enableLaterBtn.addEventListener('click', closeWelcomeTab);

  // Preload existing whitelist (if user reopens welcome via chrome://extensions reload).
  // Don't slice — earlier versions capped at 6 here, but that meant clicking
  // "Continue" on a re-visited welcome page silently truncated a larger list.
  chrome.storage.sync.get('whitelist').then(({ whitelist = [] }) => {
    if (whitelist.length) {
      added = [...whitelist];
      render();
    }
  });

  renderProgress();
}

function addFromInput() {
  const raw = els.input.value.trim().toLowerCase();
  if (!raw) return;
  let domain = raw;
  if (/^https?:\/\//.test(raw)) {
    try { domain = new URL(raw).hostname; } catch {}
  }
  domain = domain.replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!domain || !/\./.test(domain)) {
    els.input.setCustomValidity('Use a domain like example.com');
    els.input.reportValidity();
    return;
  }
  els.input.setCustomValidity('');
  if (added.includes(domain)) {
    els.input.value = '';
    return;
  }
  added.push(domain);
  els.input.value = '';
  els.input.focus();
  render();
}

function render() {
  els.list.replaceChildren(...added.map(d => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.type = 'button';
    btn.title = 'Remove';
    btn.setAttribute('aria-label', `Remove ${d}`);
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      added = added.filter(x => x !== d);
      render();
    });
    li.append(span, btn);
    return li;
  }));
  renderProgress();
}

function renderProgress() {
  const n = Math.min(added.length, TARGET_DOMAINS);
  els.dots.forEach((dot, i) => dot.classList.toggle('is-on', i < n));
  els.progressText.textContent = `${added.length} of ${TARGET_DOMAINS}`;

  if (added.length >= TARGET_DOMAINS) {
    // Reached target — show primary CTA; hide skip.
    els.skipBtn.style.display = 'none';
    els.nextBtn.style.display = '';
    els.nextBtn.disabled = false;
    els.nextBtn.querySelector('.btn-label').textContent = "I'm ready";
  } else if (added.length === 0) {
    // Nothing added — only Skip is offered. Hide primary entirely.
    els.skipBtn.style.display = '';
    els.skipBtn.textContent = 'Skip — start with empty list';
    els.nextBtn.style.display = 'none';
  } else {
    // 1–2 added — Skip becomes "Continue with N" (commits + advances).
    els.skipBtn.style.display = '';
    els.skipBtn.textContent = `Continue with ${added.length} site${added.length === 1 ? '' : 's'}`;
    els.nextBtn.style.display = 'none';
  }
}

async function commitWhitelist() {
  if (!added.length) return;
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  const set = new Set(whitelist);
  for (const d of added) set.add(d);
  const next = [...set].slice(0, 500);
  await chrome.storage.sync.set({ whitelist: next });
}

async function requestBrowsingData() {
  els.permResult.className = 'perm-result';
  els.permResult.textContent = 'Asking Chrome…';
  els.grantBd.disabled = true;
  els.skipBd.disabled = true;
  try {
    const granted = await chrome.permissions.request({ permissions: ['browsingData'] });
    if (granted) {
      // Default to LocalStorage only — that's what the perm-card promises.
      // Users can opt into IndexedDB/cache cleanup in Settings.
      await chrome.storage.sync.set({
        cleanLocalStorage: true,
        cleanIndexedDB: false,
        cleanCache: false,
      });
      els.permResult.className = 'perm-result success';
      els.permResult.textContent = 'Granted. Moving on…';
      setTimeout(() => goStep(3), 500);
    } else {
      await chrome.storage.sync.set({
        cleanLocalStorage: false,
        cleanIndexedDB: false,
        cleanCache: false,
      });
      els.permResult.className = 'perm-result danger';
      els.permResult.textContent = 'No worries — cookies only is the safe default.';
      setTimeout(() => goStep(3), 700);
    }
  } catch (e) {
    els.permResult.className = 'perm-result danger';
    els.permResult.textContent = `Could not request: ${e?.message || 'unknown error'}`;
    els.grantBd.disabled = false;
    els.skipBd.disabled = false;
  }
}

async function goStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('is-active'));
  document.getElementById(`step-${n}`).classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (n === 3) {
    const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
    els.doneWhitelist.textContent = String(whitelist.length);
    requestAnimationFrame(() => els.finishBtn.focus());
  } else if (n === 2) {
    requestAnimationFrame(() => els.grantBd.focus());
  }
}

async function closeWelcomeTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {}
  window.close();
}

init();
