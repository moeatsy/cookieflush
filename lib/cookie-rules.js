// Per-cookie rule matching (advanced, opt-in) — pure, no chrome.*. A domain can
// carry ordered { name, keep } rules that override the all-or-nothing whitelist
// for individual cookies by name. First-match-wins. The reserved '*' domain key
// holds GLOBAL rules applied to every host as the lowest-precedence layer.

export const GLOBAL_RULES_KEY = '*';

// Compiled-regex cache for wildcard patterns — cleanup runs over many cookies,
// so recompiling `_ga*` per cookie would be wasteful.
const ruleRegexCache = new Map();

export function ruleNameToRegex(pattern) {
  // Escape every regex metacharacter, THEN turn the escaped `\*` back into `.*`.
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

export function matchCookieName(pattern, name) {
  if (pattern === '*') return true;
  const n = String(name ?? '');
  if (!pattern.includes('*')) return pattern.toLowerCase() === n.toLowerCase();
  let re = ruleRegexCache.get(pattern);
  if (!re) { re = ruleNameToRegex(pattern); ruleRegexCache.set(pattern, re); }
  return re.test(n);
}

// The rule list governing `host`: host-specific rules (exact domain entry, else
// the longest parent-domain entry — rules on google.com cover mail.google.com)
// followed by GLOBAL ('*') rules as a fallback. Order matters: ruleVerdict is
// first-match-wins, so a host-specific rule beats the global one on a name
// collision. Returns null when the feature is off or nothing applies.
export function rulesForHost(host, settings) {
  if (!settings || !settings.enableCookieRules) return null;
  const cr = settings.cookieRules;
  if (!cr || typeof cr !== 'object') return null;

  // Host-specific layer. An explicit exact entry is authoritative — even an empty
  // one shadows any parent-domain rules (adding mail.google.com with no rules
  // stops it inheriting google.com's). It does NOT shadow global rules.
  let hostRules = null;
  if (Object.prototype.hasOwnProperty.call(cr, host) && Array.isArray(cr[host])) {
    hostRules = cr[host];
  } else {
    let best = null, bestLen = -1;
    for (const d of Object.keys(cr)) {
      if (d === GLOBAL_RULES_KEY || host === d) continue;
      if (host.endsWith('.' + d) && d.length > bestLen && Array.isArray(cr[d]) && cr[d].length) {
        best = cr[d]; bestLen = d.length;
      }
    }
    hostRules = best;
  }

  const globalRules = Array.isArray(cr[GLOBAL_RULES_KEY]) ? cr[GLOBAL_RULES_KEY] : null;
  const host_ = hostRules && hostRules.length ? hostRules : null;
  const glob_ = globalRules && globalRules.length ? globalRules : null;
  if (!host_ && !glob_) return null;
  if (!glob_) return host_;
  if (!host_) return glob_;
  return host_.concat(glob_);
}

// 'keep' | 'delete' | null (no matching rule → caller uses default behavior).
export function ruleVerdict(cookieName, ruleList) {
  if (!ruleList) return null;
  for (const r of ruleList) {
    if (r && typeof r.name === 'string' && matchCookieName(r.name, cookieName)) {
      return r.keep ? 'keep' : 'delete';
    }
  }
  return null;
}
