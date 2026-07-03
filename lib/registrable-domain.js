// --- Registrable-domain (eTLD+1) resolution --------------------------------
// A pragmatic subset of the Public Suffix List — enough to confidently resolve
// the registrable domain for the vast majority of real traffic WITHOUT bundling
// the full ~230 KB PSL. It is deliberately FAIL-SAFE: when a host's public
// suffix isn't positively recognized here, registrableDomain() returns null and
// callers offer only the exact-host (subdomain) whitelist. That way we can never
// mistake a public suffix (co.uk, github.io) for a registrable domain and
// whitelist an entire TLD's worth of unrelated sites.
//
// Shared by the popup (whitelist choice UI) and the background (context-menu
// whitelist items) so both compute the split identically from one source list.

// Multi-label public suffixes: ccTLD second levels + popular private hosting
// suffixes. Every entry is itself a public suffix, so eTLD+1 = entry + 1 label.
// A private-hosting entry like github.io also correctly makes foo.github.io its
// OWN registrable unit (host === eTLD+1 → no "whole domain" option offered).
export const MULTI_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz', 'geek.nz',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  // South Africa
  'co.za', 'org.za', 'net.za', 'web.za', 'gov.za',
  // India
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  // South Korea
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr',
  // Greater China / SE Asia
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'org.hk', 'net.hk', 'com.tw', 'org.tw',
  'com.sg', 'net.sg', 'org.sg', 'com.my', 'com.ph', 'co.id', 'co.th', 'com.vn',
  // Turkey / Israel / Ukraine / Russia / Poland / Spain / Greece / Mexico / LatAm
  'com.tr', 'org.tr', 'co.il', 'org.il', 'com.ua', 'net.ua', 'org.ua', 'com.ru', 'net.ru', 'org.ru',
  'com.pl', 'net.pl', 'org.pl', 'com.es', 'org.es', 'com.gr', 'com.mx', 'org.mx',
  'com.ar', 'net.ar', 'org.ar', 'com.co', 'net.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  // Austria (flat .at, but these second levels are public suffixes)
  'co.at', 'or.at', 'priv.at', 'ac.at', 'gv.at',
  // Second levels of flat-dominant ccTLDs that are ALSO kept in SIMPLE_TLDS
  // (co, ru, ua, ai). Without these, a host like foo.edu.co or b.pp.ru would
  // resolve to the public suffix itself and the UI could offer to whitelist all
  // of *.edu.co / *.pp.ru. (.us is NOT here — its geographic + k12.* trees are
  // too large to enumerate, so it's omitted from SIMPLE_TLDS to stay fail-safe.)
  'org.co', 'edu.co', 'gov.co', 'mil.co', 'nom.co',
  'pp.ru', 'msk.ru', 'spb.ru', 'edu.ru', 'gov.ru', 'ac.ru', 'int.ru', 'mil.ru',
  'in.ua', 'co.ua', 'pp.ua', 'edu.ua', 'gov.ua', 'kiev.ua',
  'com.ai', 'net.ai', 'org.ai', 'off.ai',
  // Popular private hosting suffixes (PSL private section)
  'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'onrender.com', 'fly.dev', 'glitch.me', 'repl.co', 'replit.dev',
  'surge.sh', 'now.sh', 'herokuapp.com', 'azurewebsites.net', 'cloudfront.net',
  'translate.goog', 'blogspot.com',
]);

// TLDs where registration happens directly at the second level (bare
// example.tld IS the registrable domain). Kept to unambiguously-flat gTLDs plus
// the flat-dominant ccTLDs; SLD-heavy ccTLDs (uk, jp, au, ...) are intentionally
// absent — their common second levels live in MULTI_SUFFIXES instead. A rare SLD
// exception of a flat ccTLD not covered above (e.g. an obscure regional .pl
// suffix) is the accepted ~1% miss; it can only make us over-offer, never under-
// protect, and users can still edit the whitelist in Settings.
export const SIMPLE_TLDS = new Set([
  // generic
  'com', 'net', 'org', 'info', 'biz', 'name', 'pro', 'mobi',
  'io', 'ai', 'co', 'dev', 'app', 'me', 'tv', 'cc', 'gg', 'sh', 'to', 'ly', 'fm', 'so', 'xyz',
  'online', 'site', 'shop', 'store', 'tech', 'blog', 'cloud', 'page', 'link', 'live', 'world',
  'life', 'news', 'space', 'website', 'digital', 'studio', 'design', 'agency', 'media', 'fun',
  // flat-dominant ccTLDs. NOTE: SLD-heavy ccTLDs (uk, jp, au, nz, za, br, in,
  // kr, il, tr, hk, us) are deliberately absent — their common second levels
  // live in MULTI_SUFFIXES instead, and anything unrecognized falls back to
  // subdomain-only. `.us` in particular is omitted: its geographic (ca.us…) and
  // k12.* public-suffix trees are too large to enumerate safely.
  'de', 'fr', 'nl', 'it', 'es', 'se', 'no', 'dk', 'fi', 'ch', 'be', 'at', 'pt', 'ie', 'gr', 'ro',
  'hu', 'sk', 'cz', 'bg', 'hr', 'si', 'lt', 'lv', 'ee', 'lu', 'is', 'pl', 'ru', 'ua', 'ca', 'eu',
]);

// Returns the registrable domain (eTLD+1) of `host` when it can be resolved with
// confidence, else null. `host` must already be www-stripped and lowercase.
export function registrableDomain(host) {
  if (!host) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;                 // no dot (IP-less/localhost)
  const last = (n) => labels.slice(-n).join('.');
  let suffixLen;
  if (labels.length >= 3 && MULTI_SUFFIXES.has(last(2))) suffixLen = 2;   // co.uk, github.io
  else if (SIMPLE_TLDS.has(labels[labels.length - 1])) suffixLen = 1;     // .com, .de
  else return null;                                   // unrecognized suffix → fail-safe
  const regLen = suffixLen + 1;
  if (labels.length < regLen) return null;            // host is only the suffix
  return last(regLen);
}
