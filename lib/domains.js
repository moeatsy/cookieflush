// Foundational host helpers — pure, no chrome.* — shared by the background and
// the cookie/whitelist modules so hostname normalization is defined once.

export function stripWww(host) {
  // Also drop a trailing dot: a fully-qualified `example.com.` is the same host
  // as `example.com`, but left as-is it wouldn't match cookies/whitelist entries
  // and would fool the registrable-domain split into seeing a phantom subdomain.
  return (host || '').replace(/\.$/, '').replace(/^www\./, '');
}

export function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
