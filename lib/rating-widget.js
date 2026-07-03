/**
 * RatingWidget — self-contained 5-star rating widget for Chrome extensions.
 *
 * Design (see ../res.txt for the rationale):
 *   - 5-star granular scale (so 4★ users go to feedback, not the store)
 *   - Sentiment routing, compliant variant: the store button is visible on
 *     every path, but visual hierarchy changes — 5★ pushes to store, 4★ shows
 *     both equally, 1–3★ pushes to feedback with a tiny "leave review anyway"
 *     secondary link
 *   - Bounce-in entrance, cascade-fill on hover, confetti on 5★
 *   - Trigger only on "moment of victory" — caller decides when (after a
 *     successful action), not on a timer
 *   - One-shot: any rating or dismissal sets ratingDone forever
 *
 * Three integration paths, in order of preference:
 *   A) Toast injected from MV3 service worker after a successful action
 *      (current saveAs pattern; works on any tab the extension touched).
 *   B) Inline mount in popup.html / welcome.html / options.html.
 *   C) Custom — call RatingWidget.show() directly from any context.
 *
 * The `show` function below is self-contained on purpose: chrome.scripting
 * .executeScript serializes it to the target page, so it can't reference any
 * closure-scoped helpers.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    appName: 'this extension',
    threshold: 5,
    position: 'bottom-right', // bottom-right|bottom-left|top-right|top-left|inline
    starSize: 36,
    starColor: '#FFB800',
    starColorIdle: '#d8d8d8',
    storeUrl: '',             // auto-filled by bg.maybeShowAfterUse
    feedbackUrl: '',          // mailto:..., google form, typeform, etc.
    confetti: true,
    bounceIn: true,
    storageKeys: { count: 'rwUseCount', done: 'rwDone' },
    msgType: 'rw:event',
    i18n: {}                  // override any string below
  };

  var DEFAULT_I18N = {
    prompt: 'Enjoying {app}?',
    five: 'Awesome! Help others discover {app}?',
    fivePrimary: 'Rate 5★ on Chrome Web Store',
    four: 'Almost there — what would make it 5?',
    fourPrimary: 'Send quick feedback',
    low: 'Sorry to hear that. What went wrong?',
    lowPrimary: 'Tell us what to fix',
    thanks: 'Thanks for your feedback!',
    notNow: 'Not now'
  };

  /* ===========================================================
   * SHOW — self-contained renderer.
   * Must not reference outer-scope helpers; it gets serialized.
   * =========================================================== */
  function show(opts) {
    opts = opts || {};
    var doc = document;
    if (doc.getElementById('rw-host')) return; // already on page

    // --- merge defaults inline (no shared helpers) ---
    var d = {
      appName: 'this extension', position: 'bottom-right',
      starSize: 36, starColor: '#FFB800', starColorIdle: '#d8d8d8',
      storeUrl: '', feedbackUrl: '', confetti: true, bounceIn: true,
      storageKeys: { count: 'rwUseCount', done: 'rwDone' },
      msgType: 'rw:event', mountTarget: null,
      scale: 'stars',         // 'stars' | 'emoji'
      microcopyVars: null,    // { count: 12, action: 'audited' } — substituted into i18n strings as {key}
      autoDismissMs: 12000    // 0 to disable
    };
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) d[k] = opts[k];

    // --- accessibility: respect prefers-reduced-motion ---
    var noMotion = false;
    try { noMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (noMotion) { d.bounceIn = false; d.confetti = false; }

    var t = {
      prompt: 'Enjoying {app}?',
      five: 'Awesome! Help others discover {app}?',
      fivePrimary: 'Rate 5★ on Chrome Web Store',
      four: 'Almost there — what would make it 5?',
      fourPrimary: 'Send quick feedback',
      low: 'Sorry to hear that. What went wrong?',
      lowPrimary: 'Tell us what to fix',
      thanks: 'Thanks for your feedback!',
      notNow: 'Not now'
    };
    if (opts.i18n) for (var k2 in opts.i18n) t[k2] = opts.i18n[k2];
    function tr(key) {
      var s = (t[key] || '').replace('{app}', d.appName);
      if (d.microcopyVars) {
        for (var mk in d.microcopyVars) {
          if (Object.prototype.hasOwnProperty.call(d.microcopyVars, mk)) {
            s = s.split('{' + mk + '}').join(String(d.microcopyVars[mk]));
          }
        }
      }
      return s;
    }

    // --- container & shadow root for CSS isolation ---
    var inline = d.position === 'inline';
    var host = doc.createElement('div');
    host.id = 'rw-host';
    var posCss = '';
    var m = '20px';
    if (inline) posCss = 'position:static;display:inline-block';
    else if (d.position === 'top-right')    posCss = 'position:fixed;top:'+m+';right:'+m;
    else if (d.position === 'top-left')     posCss = 'position:fixed;top:'+m+';left:'+m;
    else if (d.position === 'bottom-left')  posCss = 'position:fixed;bottom:'+m+';left:'+m;
    else                                    posCss = 'position:fixed;bottom:'+m+';right:'+m;
    host.style.cssText = 'all:initial;z-index:2147483647;' + posCss;
    (d.mountTarget || (inline ? doc.body : doc.documentElement)).appendChild(host);
    if (inline && d.mountTarget) host.style.position = 'static';

    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    // Warm off-white in light mode — feels less "ad-card", validated against pure-white in
    // Stripe/Linear empty-state patterns. Dark mode stays neutral; warm tint reads as muddy there.
    var bg = dark ? '#23232a' : '#fffdf6';
    var fg = dark ? '#e8e8ed' : '#1a1a1a';
    var muted = dark ? '#8b8b95' : '#666';
    var border = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)';
    var size = d.starSize;

    // SVG gradient ids — unique-ish per show in case multiple end up in one document
    var gradId = 'rw-grad-' + Math.random().toString(36).slice(2, 8);
    var gradIdleId = gradId + '-i';

    var style = doc.createElement('style');
    style.textContent =
      ':host,*{box-sizing:border-box}' +
      // Gold inset stripe via box-shadow — respects border-radius natively, no clipping of
      // children (confetti can still escape the card on 5★). Outer drop shadow stays intact.
      '.card{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'background:'+bg+';color:'+fg+';border:1px solid '+border+';border-radius:14px;' +
        'padding:14px 20px 10px;width:300px;max-width:calc(100vw - 40px);' +
        'box-shadow:0 12px 40px rgba(0,0,0,.18),inset 0 2px 0 '+d.starColor+';' +
        'position:relative;opacity:0;transform:translateY(8px) scale(.96)}' +
      '.card.in{opacity:1;transform:none;transition:opacity .28s ease,transform .32s cubic-bezier(.34,1.56,.64,1)}' +
      '.card.out{opacity:0;transform:translateY(8px) scale(.96);transition:opacity .22s,transform .22s}' +
      '.title{margin:0 0 10px;font-weight:600;font-size:14px;text-align:center}' +
      '.stars{display:flex;justify-content:center;align-items:center;gap:4px;padding:2px 0;min-height:'+(size+6)+'px}' +
      '.s{cursor:pointer;user-select:none;padding:0 2px;display:inline-flex;align-items:center;justify-content:center;' +
        'transition:transform .2s cubic-bezier(.34,1.56,.64,1);will-change:transform;transform:translateZ(0)}' +
      '.s svg{width:'+size+'px;height:'+size+'px;display:block;overflow:visible}' +
      '.s svg .lit-on{opacity:0;transition:opacity .18s ease}' +
      '.s.lit svg .lit-on{opacity:1}' +
      '.s.emoji{font-size:'+size+'px;line-height:1;filter:grayscale(1) opacity(.55);' +
        'transition:filter .2s ease,transform .2s cubic-bezier(.34,1.56,.64,1)}' +
      '.s.emoji.lit{filter:none}' +
      '.s.hover{transform:scale(1.15)}' +
      '.not-now{display:block;margin:6px auto 0;background:transparent;border:0;padding:6px 8px;' +
        'color:'+muted+';font:500 11px inherit;cursor:pointer;text-decoration:underline;text-decoration-color:'+border+';' +
        'text-underline-offset:2px}' +
      '.not-now:hover{color:'+fg+'}' +
      '.actions{display:flex;flex-direction:column;gap:8px;margin-top:10px}' +
      '.btn{display:block;width:100%;padding:10px 14px;border-radius:10px;border:0;cursor:pointer;' +
        'font:600 13px/1.2 inherit;text-align:center;text-decoration:none}' +
      '.btn.primary{background:'+d.starColor+';color:#1a1a1a}' +
      '.btn.primary:hover{filter:brightness(.95)}' +
      '.btn.secondary{background:transparent;color:'+fg+';border:1px solid '+border+'}' +
      '.btn.secondary:hover{background:'+border+'}' +
      '.btn.tiny{background:transparent;color:'+muted+';font-weight:500;font-size:12px;padding:4px;text-decoration:underline}' +
      '.btn.tiny:hover{color:'+fg+'}' +
      '.confetti{position:absolute;top:50%;left:50%;width:8px;height:8px;border-radius:2px;pointer-events:none}' +
      '@keyframes rwConf{to{transform:translate(var(--dx),var(--dy)) rotate(var(--r));opacity:0}}' +
      '.confetti.go{animation:rwConf 1.1s cubic-bezier(.2,.7,.3,1) forwards}' +
      '@media (prefers-reduced-motion: reduce){' +
        '.card,.card.in,.card.out{transition:none!important}' +
        '.s,.s.emoji{transition:filter .15s ease!important;transform:none!important}' +
        '.s.hover{transform:none!important}' +
        '.confetti{display:none!important}' +
      '}';
    shadow.appendChild(style);

    // Shared SVG defs for star gradients (one defs block, referenced by every star)
    if (d.scale !== 'emoji') {
      var defs = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
      defs.setAttribute('style', 'position:absolute;width:0;height:0');
      defs.innerHTML =
        '<defs>' +
          '<linearGradient id="'+gradId+'" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="'+lighten(d.starColor, 18)+'"/>' +
            '<stop offset="100%" stop-color="'+darken(d.starColor, 8)+'"/>' +
          '</linearGradient>' +
          '<linearGradient id="'+gradIdleId+'" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="'+d.starColorIdle+'"/>' +
            '<stop offset="100%" stop-color="'+darken(d.starColorIdle, 6)+'"/>' +
          '</linearGradient>' +
        '</defs>';
      shadow.appendChild(defs);
    }

    function lighten(hex, pct) { return shiftHex(hex, pct); }
    function darken(hex, pct)  { return shiftHex(hex, -pct); }
    function shiftHex(hex, pct) {
      var h = hex.replace('#','');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      var f = pct / 100;
      function s(c) { return Math.max(0, Math.min(255, Math.round(c + (f >= 0 ? (255 - c) * f : c * f)))); }
      return '#' + ((1<<24) + (s(r)<<16) + (s(g)<<8) + s(b)).toString(16).slice(1);
    }

    var card = doc.createElement('div');
    card.className = 'card';
    if (!d.bounceIn) card.classList.add('in');

    var title = doc.createElement('div');
    title.className = 'title';
    title.textContent = tr('prompt');
    card.appendChild(title);

    var stars = doc.createElement('div');
    stars.className = 'stars';
    var starEls = [];
    var hoverTimers = [];
    var frozen = false; // becomes true after a rating is picked
    function setLit(el, lit) {
      if (lit) el.classList.add('lit'); else el.classList.remove('lit');
    }
    function clearHover() {
      if (frozen) return;
      for (var i = 0; i < hoverTimers.length; i++) clearTimeout(hoverTimers[i]);
      hoverTimers = [];
      for (var j = 0; j < starEls.length; j++) {
        setLit(starEls[j], false);
        starEls[j].classList.remove('hover');
      }
    }
    function lightUp(n) {
      if (frozen) return;
      clearHover();
      // Bounce only the actively-hovered star; light up earlier stars instantly to avoid wave/jitter.
      for (var i = 0; i < n - 1; i++) setLit(starEls[i], true);
      // Last star — slight stagger so the user sees fill follow the cursor.
      hoverTimers.push(setTimeout(function () {
        if (frozen) return;
        setLit(starEls[n - 1], true);
        starEls[n - 1].classList.add('hover');
      }, 30));
    }
    var EMOJI = ['😡', '😐', '🙂', '😄', '😍']; // 😡 😐 🙂 😄 😍
    var STAR_PATH = 'M12 2 L14.39 8.36 L21 9.27 L16 13.97 L17.45 20.91 L12 17.77 L6.55 20.91 L8 13.97 L3 9.27 L9.61 8.36 Z';
    for (var i = 1; i <= 5; i++) {
      var s = doc.createElement('span');
      s.className = 's' + (d.scale === 'emoji' ? ' emoji' : '');
      s.setAttribute('role', 'button');
      s.dataset.value = String(i);
      if (d.scale === 'emoji') {
        s.setAttribute('aria-label', 'rate ' + i + ' of 5');
        s.textContent = EMOJI[i - 1];
      } else {
        s.setAttribute('aria-label', i + ' star' + (i > 1 ? 's' : ''));
        // Two stacked paths so the gradient swap fades in via opacity (smoother than fill attribute swap)
        s.innerHTML =
          '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="' + STAR_PATH + '" fill="url(#' + gradIdleId + ')"/>' +
            '<path d="' + STAR_PATH + '" fill="url(#' + gradId + ')" class="lit-on"/>' +
          '</svg>';
      }
      starEls.push(s);
      stars.appendChild(s);
    }
    stars.addEventListener('mouseover', function (e) {
      var s = e.target.closest && e.target.closest('.s');
      if (!s) return;
      lightUp(parseInt(s.dataset.value, 10));
    });
    stars.addEventListener('mouseleave', clearHover);
    stars.addEventListener('click', function (e) {
      var s = e.target.closest && e.target.closest('.s');
      if (!s) return;
      var v = parseInt(s.dataset.value, 10);
      route(v, s);
    });
    card.appendChild(stars);

    var actions = doc.createElement('div');
    actions.className = 'actions';
    card.appendChild(actions);

    // "Not now" — soft dismiss instead of × close
    var notNowBtn = doc.createElement('button');
    notNowBtn.className = 'not-now';
    notNowBtn.type = 'button';
    notNowBtn.textContent = tr('notNow');
    notNowBtn.addEventListener('click', function () {
      markDone();
      dismiss();
    });
    card.appendChild(notNowBtn);

    shadow.appendChild(card);

    // entrance
    if (d.bounceIn) requestAnimationFrame(function () {
      requestAnimationFrame(function () { card.classList.add('in'); });
    });

    // Auto-dismiss timer: silent fade after N seconds with no engagement.
    // Resets on hover-into-card. Cancelled once user clicks any star (post-rating
    // state shouldn't auto-vanish out from under them).
    var autoTimer = null;
    function armAutoDismiss() {
      if (!d.autoDismissMs || frozen) return;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(function () {
        if (frozen) return;
        // No markDone — passive ignore should let next show try again.
        dismiss();
      }, d.autoDismissMs);
    }
    armAutoDismiss();
    card.addEventListener('mouseenter', function () { if (!frozen) armAutoDismiss(); });

    function route(value, srcStar) {
      if (autoTimer) clearTimeout(autoTimer);
      // Freeze stars at chosen value (do this BEFORE flipping pointer-events,
      // so the synthetic mouseleave that fires next can't wipe the .lit state)
      for (var ti = 0; ti < hoverTimers.length; ti++) clearTimeout(hoverTimers[ti]);
      hoverTimers = [];
      for (var si = 0; si < starEls.length; si++) {
        starEls[si].classList.remove('hover');
        setLit(starEls[si], si < value);
      }
      frozen = true;
      stars.style.pointerEvents = 'none';

      markDone(); // no matter what they pick, never show again

      if (value === 5) {
        if (d.confetti && srcStar) burst(card, d.starColor);
        title.textContent = tr('five');
        renderActions([
          { kind: 'primary', label: tr('fivePrimary'), action: 'open-store' }
        ], value);
      } else if (value === 4) {
        if (d.feedbackUrl) {
          title.textContent = tr('four');
          renderActions([
            { kind: 'primary', label: tr('fourPrimary'), action: 'open-feedback' }
          ], value);
        } else {
          title.textContent = tr('thanks');
          setTimeout(dismiss, 1400);
        }
      } else {
        if (d.feedbackUrl) {
          title.textContent = tr('low');
          renderActions([
            { kind: 'primary', label: tr('lowPrimary'), action: 'open-feedback' }
          ], value);
        } else {
          title.textContent = tr('thanks');
          setTimeout(dismiss, 1400);
        }
      }
    }

    function renderActions(items, value) {
      actions.innerHTML = '';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + it.kind;
        b.textContent = it.label;
        (function (action) {
          b.addEventListener('click', function () {
            sendEvent({ action: action, value: value });
            if (action === 'open-store' && d.storeUrl) openUrl(d.storeUrl);
            else if (action === 'open-feedback' && d.feedbackUrl) openUrl(d.feedbackUrl);
            dismiss();
          });
        })(it.action);
        actions.appendChild(b);
      }
    }

    function openUrl(url) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          // background will open the tab via tabs.create
          return; // already handled by sendEvent above
        }
      } catch (e) {}
      try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    }

    function sendEvent(payload) {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            type: d.msgType,
            action: payload.action,
            value: payload.value,
            url: payload.action === 'open-store' ? d.storeUrl
               : payload.action === 'open-feedback' ? d.feedbackUrl : '',
            storageKeys: d.storageKeys
          });
        }
      } catch (e) {}
    }

    function markDone() {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            type: d.msgType, action: 'done',
            storageKeys: d.storageKeys
          });
        }
      } catch (e) {}
    }

    function dismiss() {
      if (autoTimer) clearTimeout(autoTimer);
      card.classList.remove('in');
      card.classList.add('out');
      setTimeout(function () { if (host && host.parentNode) host.parentNode.removeChild(host); }, 240);
    }

    function burst(target, color) {
      var n = 18;
      for (var i = 0; i < n; i++) {
        var p = doc.createElement('div');
        p.className = 'confetti';
        var hue = (i * 360 / n) | 0;
        p.style.background = i % 3 === 0 ? color
          : i % 3 === 1 ? 'hsl(' + hue + ',85%,60%)'
          : '#fff';
        var angle = (Math.random() * Math.PI * 2);
        var dist = 60 + Math.random() * 80;
        var dx = Math.cos(angle) * dist;
        var dy = Math.sin(angle) * dist - 20;
        var rot = (Math.random() * 720 - 360) | 0;
        p.style.setProperty('--dx', dx + 'px');
        p.style.setProperty('--dy', dy + 'px');
        p.style.setProperty('--r', rot + 'deg');
        target.appendChild(p);
        // trigger animation next frame
        requestAnimationFrame(function (el) { return function () { el.classList.add('go'); }; }(p));
        setTimeout(function (el) { return function () { if (el.parentNode) el.parentNode.removeChild(el); }; }(p), 1200);
      }
    }
  }

  /* ===========================================================
   * Background-side helpers (MV3 service worker).
   * =========================================================== */
  var bg = {
    /**
     * Increment use-count, and if threshold reached and user hasn't already
     * rated/dismissed, inject the toast into the given tab.
     *
     * @param {number} tabId
     * @param {object} opts  same options as show(), plus optional .threshold
     */
    async maybeShowAfterUse(tabId, opts) {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      var o = mergeDefaults(opts);
      var keys = o.storageKeys;
      var data = await chrome.storage.local.get([keys.count, keys.done]);
      if (data[keys.done]) return;
      var n = (data[keys.count] || 0) + 1;
      var update = {}; update[keys.count] = n;
      await chrome.storage.local.set(update);
      if (n < o.threshold) return;
      if (!tabId) return;

      // Skip non-injectable tabs (chrome://, web-store, etc.)
      try {
        var tab = await chrome.tabs.get(tabId);
        if (!tab || !tab.url) return;
        if (/^(chrome|edge|about|chrome-extension|chrome-untrusted|view-source):/i.test(tab.url)) return;
        if (/chromewebstore\.google\.com/i.test(tab.url)) return;
      } catch (e) { return; }

      // Auto-derive store URL if caller didn't pass one
      if (!o.storeUrl && chrome.runtime && chrome.runtime.id) {
        o.storeUrl = 'https://chromewebstore.google.com/detail/' + chrome.runtime.id + '/reviews';
      }

      var serializable = serialize(o);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: show,
          args: [serializable]
        });
      } catch (e) { /* tab gone, no permission, etc. */ }
    },

    /**
     * Wire from chrome.runtime.onMessage. Persists "done" and opens
     * store/feedback URLs in a new tab. Returns true if it handled the message.
     */
    handleMessage: function (message) {
      if (!message || typeof message !== 'object' || message.type !== 'rw:event') return false;
      var keys = message.storageKeys || { done: 'rwDone' };
      var update = {}; update[keys.done] = true;
      try { chrome.storage.local.set(update); } catch (e) {}

      if (message.action === 'open-store' && message.url) {
        try { chrome.tabs.create({ url: message.url }); } catch (e) {}
      } else if (message.action === 'open-feedback' && message.url) {
        try { chrome.tabs.create({ url: message.url }); } catch (e) {}
      }
      return true;
    },

    /** Reset rating state — useful for QA / debugging. */
    reset: async function (storageKeys) {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      var keys = Object.assign({}, DEFAULTS.storageKeys, storageKeys || {});
      var update = {}; update[keys.count] = 0; update[keys.done] = false;
      await chrome.storage.local.set(update);
    }
  };

  function mergeDefaults(opts) {
    var o = JSON.parse(JSON.stringify(DEFAULTS));
    if (!opts) return o;
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) {
      if (k === 'i18n') {
        o.i18n = Object.assign({}, DEFAULT_I18N, opts.i18n || {});
      } else if (k === 'storageKeys') {
        o.storageKeys = Object.assign({}, DEFAULTS.storageKeys, opts.storageKeys || {});
      } else o[k] = opts[k];
    }
    if (!o.i18n || !Object.keys(o.i18n).length) o.i18n = Object.assign({}, DEFAULT_I18N);
    return o;
  }

  function serialize(o) {
    // Strip non-serializable bits and shrink for executeScript args.
    return {
      appName: o.appName, position: o.position,
      starSize: o.starSize, starColor: o.starColor, starColorIdle: o.starColorIdle,
      storeUrl: o.storeUrl, feedbackUrl: o.feedbackUrl,
      confetti: !!o.confetti, bounceIn: !!o.bounceIn,
      storageKeys: o.storageKeys, msgType: o.msgType,
      i18n: o.i18n,
      scale: o.scale || 'stars',
      microcopyVars: o.microcopyVars || null,
      autoDismissMs: o.autoDismissMs == null ? 12000 : o.autoDismissMs
    };
  }

  /**
   * Inline mount for popup/options/welcome. Pass a container element.
   */
  function mount(container, opts) {
    var o = mergeDefaults(opts);
    o.position = 'inline';
    if (!o.storeUrl && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      o.storeUrl = 'https://chromewebstore.google.com/detail/' + chrome.runtime.id + '/reviews';
    }
    o.mountTarget = container;
    show(o);
  }

  /**
   * Should we show inline right now? Reads counters from chrome.storage.local.
   * Caller decides what to do with the answer.
   */
  async function shouldShow(opts) {
    var o = mergeDefaults(opts);
    if (typeof chrome === 'undefined' || !chrome.storage) return false;
    var data = await chrome.storage.local.get([o.storageKeys.count, o.storageKeys.done]);
    if (data[o.storageKeys.done]) return false;
    return (data[o.storageKeys.count] || 0) >= o.threshold;
  }

  /** Increment the counter only — useful when you want manual control of trigger. */
  async function bump(opts) {
    var o = mergeDefaults(opts);
    if (typeof chrome === 'undefined' || !chrome.storage) return 0;
    var data = await chrome.storage.local.get([o.storageKeys.count]);
    var n = (data[o.storageKeys.count] || 0) + 1;
    var update = {}; update[o.storageKeys.count] = n;
    await chrome.storage.local.set(update);
    return n;
  }

  root.RatingWidget = {
    show: show,
    mount: mount,
    shouldShow: shouldShow,
    bump: bump,
    bg: bg,
    DEFAULTS: DEFAULTS,
    DEFAULT_I18N: DEFAULT_I18N
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
