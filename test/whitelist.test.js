import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coversHost, isHostWhitelisted, planAddWildcard, planAddExact, planRemove,
} from '../lib/whitelist.js';

test('coversHost: wildcard covers host + subdomains; exact only the host', () => {
  assert.equal(coversHost('cnn.com', ['cnn.com'], []), true);
  assert.equal(coversHost('edition.cnn.com', ['cnn.com'], []), true);   // wildcard → subdomain
  assert.equal(coversHost('cnn.com', [], ['cnn.com']), true);           // exact → self
  assert.equal(coversHost('edition.cnn.com', [], ['cnn.com']), false);  // exact ≠ subdomain
  assert.equal(coversHost('notcnn.com', ['cnn.com'], []), false);       // dotted-boundary guard
  assert.equal(coversHost('', ['cnn.com'], []), false);
});

test('isHostWhitelisted: greylist honored only before expiry', () => {
  const s = { whitelist: [], whitelistExact: [], greylist: { 'a.com': 100 } };
  assert.equal(isHostWhitelisted('a.com', s, 50), true);   // now < exp
  assert.equal(isHostWhitelisted('a.com', s, 150), false); // now > exp
  assert.equal(isHostWhitelisted('sub.a.com', s, 50), false); // greylist is exact-host
});

test('planAddWildcard: added on empty', () => {
  const p = planAddWildcard({ whitelist: [], whitelistExact: [] }, 'cnn.com');
  assert.equal(p.result, 'added');
  assert.deepEqual(p.whitelist, ['cnn.com']);
  assert.deepEqual(p.whitelistExact, []);
});

test('planAddWildcard: duplicate and parent-covered', () => {
  assert.equal(planAddWildcard({ whitelist: ['cnn.com'], whitelistExact: [] }, 'cnn.com').result, 'duplicate');
  assert.equal(planAddWildcard({ whitelist: ['cnn.com'], whitelistExact: [] }, 'edition.cnn.com').result, 'covered');
});

test('planAddWildcard: prunes covered wildcard children AND covered exacts', () => {
  const p = planAddWildcard(
    { whitelist: ['a.cnn.com', 'other.com'], whitelistExact: ['cnn.com', 'b.cnn.com', 'keep.com'] },
    'cnn.com',
  );
  assert.equal(p.result, 'added');
  assert.deepEqual(p.whitelist.sort(), ['cnn.com', 'other.com']);   // a.cnn.com pruned
  assert.deepEqual(p.whitelistExact.sort(), ['keep.com']);          // cnn.com + b.cnn.com pruned
});

test('planAddWildcard: dotted-boundary — notexample.com not pruned by example.com', () => {
  const p = planAddWildcard({ whitelist: ['notexample.com'], whitelistExact: [] }, 'example.com');
  assert.equal(p.result, 'added');
  assert.ok(p.whitelist.includes('notexample.com'));
});

test('planAddWildcard: full at cap', () => {
  const p = planAddWildcard({ whitelist: ['a.com', 'b.com'], whitelistExact: [] }, 'c.com', 2);
  assert.equal(p.result, 'full');
});

test('planAddExact: added, duplicate, and covered-by-wildcard', () => {
  assert.equal(planAddExact({ whitelist: [], whitelistExact: [] }, 'cnn.com').result, 'added');
  assert.equal(planAddExact({ whitelist: [], whitelistExact: ['cnn.com'] }, 'cnn.com').result, 'duplicate');
  assert.equal(planAddExact({ whitelist: ['cnn.com'], whitelistExact: [] }, 'cnn.com').result, 'covered');
  assert.equal(planAddExact({ whitelist: ['cnn.com'], whitelistExact: [] }, 'edition.cnn.com').result, 'covered');
});

test('planAddExact: full at cap', () => {
  assert.equal(planAddExact({ whitelist: [], whitelistExact: ['a.com'] }, 'b.com', 1).result, 'full');
});

test('planRemove(exact=false): covering wildcard (parent) takes priority', () => {
  const p = planRemove({ whitelist: ['cnn.com'], whitelistExact: [] }, 'edition.cnn.com', false);
  assert.equal(p.removed, 'cnn.com');
  assert.deepEqual(p.whitelist, []);
});

test('planRemove(exact=false): falls back to exact entry for the host', () => {
  const p = planRemove({ whitelist: [], whitelistExact: ['only.com'] }, 'only.com', false);
  assert.equal(p.removed, 'only.com');
  assert.deepEqual(p.whitelistExact, []);
});

test('planRemove(exact=false): nothing protects the host', () => {
  assert.equal(planRemove({ whitelist: [], whitelistExact: [] }, 'x.com', false).removed, null);
});

test('planRemove(exact=true): removes the verbatim wildcard row only', () => {
  const p = planRemove({ whitelist: ['a.com', 'b.com'], whitelistExact: [] }, 'a.com', true);
  assert.equal(p.removed, 'a.com');
  assert.deepEqual(p.whitelist, ['b.com']);
  assert.equal(planRemove({ whitelist: ['a.com'], whitelistExact: [] }, 'zzz.com', true).removed, null);
});

test('domain matrix: wildcard covers subdomains across gTLD / ccTLD / private suffix', () => {
  // gTLD
  assert.equal(coversHost('edition.cnn.com', ['cnn.com'], []), true);
  // 2-level ccTLD
  assert.equal(coversHost('shop.example.co.uk', ['example.co.uk'], []), true);
  assert.equal(coversHost('example.co.uk', ['example.co.uk'], []), true);
  // deep subdomain
  assert.equal(coversHost('a.b.c.example.com', ['example.com'], []), true);
  // private-suffix unit (whitelisting foo.github.io covers *.foo.github.io only)
  assert.equal(coversHost('x.foo.github.io', ['foo.github.io'], []), true);
  assert.equal(coversHost('other.github.io', ['foo.github.io'], []), false);
});

test('domain matrix: exact excludes subdomains across domain types', () => {
  assert.equal(coversHost('shop.example.co.uk', [], ['example.co.uk']), false);
  assert.equal(coversHost('example.co.uk', [], ['example.co.uk']), true);
  assert.equal(coversHost('edition.cnn.com', [], ['cnn.com']), false);
});

test('domain matrix: coverage/prune works on ccTLD shapes', () => {
  // adding wildcard example.co.uk prunes an exact sub.example.co.uk it now covers
  const p = planAddWildcard({ whitelist: [], whitelistExact: ['sub.example.co.uk', 'keep.org'] }, 'example.co.uk');
  assert.equal(p.result, 'added');
  assert.deepEqual(p.whitelistExact, ['keep.org']);
  // exact under a ccTLD wildcard is 'covered'
  assert.equal(planAddExact({ whitelist: ['example.co.uk'], whitelistExact: [] }, 'shop.example.co.uk').result, 'covered');
});

test('end-to-end: exact then wildcard replaces it; subdomain protection flips', () => {
  let lists = { whitelist: [], whitelistExact: [] };
  let p = planAddExact(lists, 'cnn.com');
  lists = { whitelist: lists.whitelist, whitelistExact: p.whitelistExact };
  assert.equal(coversHost('cnn.com', lists.whitelist, lists.whitelistExact), true);
  assert.equal(coversHost('edition.cnn.com', lists.whitelist, lists.whitelistExact), false);

  p = planAddWildcard(lists, 'cnn.com');
  lists = { whitelist: p.whitelist, whitelistExact: p.whitelistExact };
  assert.deepEqual(lists.whitelistExact, []);  // exact pruned by wildcard
  assert.equal(coversHost('edition.cnn.com', lists.whitelist, lists.whitelistExact), true);
});
