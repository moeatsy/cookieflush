// Pure whitelist logic — NO chrome.* dependencies, so it can be unit-tested
// directly and reused by the background service worker. Two entry kinds:
//   • wildcard entries (`whitelist`)     — cover the host AND all its subdomains
//   • exact entries    (`whitelistExact`) — cover ONLY that host
// Hosts passed in are assumed already www-stripped and lowercased (the caller's
// job, matching how chrome hands us hostnames).

// Does an existing whitelist (either kind) already protect `host`?
export function coversHost(host, whitelist = [], whitelistExact = []) {
  if (!host) return false;
  for (const w of whitelist) {
    if (host === w || host.endsWith('.' + w)) return true;   // wildcard: host + subdomains
  }
  return whitelistExact.includes(host);                       // exact: this host only
}

// Full protection check including the (exact-host, time-boxed) greylist.
// `now` is passed in (ms) so tests are deterministic.
export function isHostWhitelisted(host, { whitelist = [], whitelistExact = [], greylist = {} } = {}, now = 0) {
  if (!host) return false;
  if (coversHost(host, whitelist, whitelistExact)) return true;
  const exp = greylist[host];
  return !!(exp && exp > now);
}

// Plan adding a WILDCARD entry. Returns a result tag and, when 'added', the new
// canonical lists. Coverage-aware: skips a redundant child, and prunes existing
// entries the new wildcard now subsumes (wildcard children + any exact at-or-
// under it) so no host loses protection while the lists stay minimal.
export function planAddWildcard({ whitelist = [], whitelistExact = [] }, domain, max = 500) {
  if (whitelist.includes(domain)) return { result: 'duplicate' };
  if (whitelist.some(w => domain.endsWith('.' + w))) return { result: 'covered' };
  const nextWild = whitelist.filter(w => !w.endsWith('.' + domain));
  const nextExact = whitelistExact.filter(e => !(e === domain || e.endsWith('.' + domain)));
  if (nextWild.length >= max) return { result: 'full' };
  nextWild.push(domain);
  return { result: 'added', whitelist: nextWild, whitelistExact: nextExact };
}

// Plan adding an EXACT entry (host only). Redundant if a wildcard already
// matches the host (identically or more broadly).
export function planAddExact({ whitelist = [], whitelistExact = [] }, host, max = 500) {
  if (whitelistExact.includes(host)) return { result: 'duplicate' };
  if (whitelist.some(w => host === w || host.endsWith('.' + w))) return { result: 'covered' };
  if (whitelistExact.length >= max) return { result: 'full' };
  return { result: 'added', whitelistExact: whitelistExact.concat([host]) };
}

// Plan removing whatever protects `host`.
//   • exact=true  → options-list row: remove that verbatim WILDCARD entry.
//   • exact=false → popup "Remove": drop the covering wildcard (may be a parent)
//                    first, else the exact entry for the host itself.
// Returns { removed } (null if nothing) plus only the list(s) that changed.
export function planRemove({ whitelist = [], whitelistExact = [] }, host, exact = false) {
  if (exact) {
    if (!whitelist.includes(host)) return { removed: null };
    return { removed: host, whitelist: whitelist.filter(d => d !== host) };
  }
  const wild = whitelist.find(w => host === w || host.endsWith('.' + w));
  if (wild) return { removed: wild, whitelist: whitelist.filter(d => d !== wild) };
  if (whitelistExact.includes(host)) {
    return { removed: host, whitelistExact: whitelistExact.filter(d => d !== host) };
  }
  return { removed: null };
}
