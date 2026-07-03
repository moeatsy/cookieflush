import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCookieName, rulesForHost, ruleVerdict, GLOBAL_RULES_KEY } from '../lib/cookie-rules.js';

test('matchCookieName: exact (case-insensitive), literal dots, wildcards', () => {
  assert.equal(matchCookieName('sessionid', 'SessionID'), true);   // case-insensitive
  assert.equal(matchCookieName('sid', 'sidebar'), false);          // exact, not substring
  assert.equal(matchCookieName('*', 'anything'), true);            // catch-all
  assert.equal(matchCookieName('_ga*', '_ga'), true);
  assert.equal(matchCookieName('_ga*', '_ga_ABC123'), true);
  assert.equal(matchCookieName('_ga*', '_gid'), false);
  assert.equal(matchCookieName('cf_*', 'cf_clearance'), true);
  assert.equal(matchCookieName('a*z', 'abcz'), true);              // wildcard in the middle
  assert.equal(matchCookieName('a.b', 'a.b'), true);               // dot is literal
  assert.equal(matchCookieName('a.b', 'axb'), false);             // dot not "any char"
  assert.equal(matchCookieName('id', null), false);
});

test('ruleVerdict: first-match-wins, keep/delete/null', () => {
  assert.equal(ruleVerdict('x', null), null);
  assert.equal(ruleVerdict('x', []), null);
  assert.equal(ruleVerdict('_ga', [{ name: '_ga', keep: false }]), 'delete');
  assert.equal(ruleVerdict('sid', [{ name: 'sid', keep: true }]), 'keep');
  // first match wins
  assert.equal(ruleVerdict('_ga', [{ name: '_ga', keep: true }, { name: '*', keep: false }]), 'keep');
  assert.equal(ruleVerdict('other', [{ name: '_ga', keep: true }, { name: '*', keep: false }]), 'delete');
});

const S = (cookieRules, on = true) => ({ enableCookieRules: on, cookieRules });

test('rulesForHost: disabled / empty → null', () => {
  assert.equal(rulesForHost('a.com', S({ 'a.com': [{ name: 'x' }] }, false)), null);
  assert.equal(rulesForHost('a.com', S({})), null);
  assert.equal(rulesForHost('a.com', { enableCookieRules: true }), null);
});

test('rulesForHost: parent domain rules cover subdomains (google.com → mail.google.com)', () => {
  const s = S({ 'google.com': [{ name: 'sid', keep: true }] });
  assert.deepEqual(rulesForHost('google.com', s), [{ name: 'sid', keep: true }]);
  assert.deepEqual(rulesForHost('mail.google.com', s), [{ name: 'sid', keep: true }]);
  assert.equal(rulesForHost('notgoogle.com', s), null);   // dotted boundary
});

test('rulesForHost: longest parent wins', () => {
  const s = S({ 'example.com': [{ name: 'A' }], 'foo.example.com': [{ name: 'B' }] });
  assert.deepEqual(rulesForHost('bar.foo.example.com', s), [{ name: 'B' }]);
});

test('rulesForHost: an explicit (even empty) exact entry shadows parent rules', () => {
  const s = S({ 'google.com': [{ name: 'sid', keep: true }], 'mail.google.com': [] });
  // mail.google.com has its own (empty) entry → does NOT inherit google.com's
  assert.equal(rulesForHost('mail.google.com', s), null);
});

test('rulesForHost: global "*" is a fallback; host rule wins on name collision', () => {
  const s = S({ [GLOBAL_RULES_KEY]: [{ name: '_ga', keep: false }], 'site.com': [{ name: '_ga', keep: true }] });
  const list = rulesForHost('site.com', s);
  // host rules come first, so the site's keep wins over the global delete
  assert.equal(ruleVerdict('_ga', list), 'keep');
  // a host with no specific rules still gets the global layer
  assert.equal(ruleVerdict('_ga', rulesForHost('elsewhere.com', s)), 'delete');
});

test('rulesForHost: works across ccTLD (example.co.uk parent covers its subdomains)', () => {
  const s = S({ 'example.co.uk': [{ name: 'sid', keep: true }] });
  assert.deepEqual(rulesForHost('shop.example.co.uk', s), [{ name: 'sid', keep: true }]);
});
