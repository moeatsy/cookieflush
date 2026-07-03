// Partitioned-cookie (CHIPS) governance — pure, no chrome.* — so the subtle
// first-party-vs-tracker logic can be unit-tested. See background.js for the
// full rationale; in short:
//   • unpartitioned cookie → governed by its own host
//   • partitioned cookie   → governed by its top-level partition SITE (eTLD+1),
//     and is "first-party" only when its own host belongs to that site.
import { stripWww, safeHostname } from './domains.js';

// The top-level SITE host a CHIPS cookie is keyed under ('' when unpartitioned).
export function cookiePartitionSite(cookie) {
  const tls = cookie?.partitionKey?.topLevelSite;
  return tls ? stripWww(safeHostname(tls) || '') : '';
}

// The host whose whitelist/open-tab state decides this cookie's fate: the
// partition site for CHIPS cookies, else the cookie's own (www-stripped) host.
export function cookieGoverningHost(cookie) {
  return cookiePartitionSite(cookie) || stripWww((cookie?.domain || '').replace(/^\./, ''));
}

// True when the cookie's own host belongs to the site it's partitioned under
// (site embedded itself), or when it's unpartitioned. A cross-site partitioned
// cookie (host ≠ site — a tracker slipping past 3P blocking) returns false.
export function isFirstPartyPartitioned(cookie, partitionSite) {
  if (!partitionSite) return true;
  const bare = (cookie?.domain || '').replace(/^\./, '');
  return bare === partitionSite || bare.endsWith('.' + partitionSite);
}
