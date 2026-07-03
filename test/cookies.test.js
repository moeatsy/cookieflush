import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookiePartitionSite, cookieGoverningHost, isFirstPartyPartitioned } from '../lib/cookies.js';

const part = (topLevelSite) => ({ partitionKey: { topLevelSite } });

test('cookiePartitionSite: eTLD+1 site, www-folded; empty when unpartitioned', () => {
  assert.equal(cookiePartitionSite({ domain: '.example.com' }), '');                 // unpartitioned
  assert.equal(cookiePartitionSite(part('https://boingboing.net')), 'boingboing.net');
  assert.equal(cookiePartitionSite(part('https://www.example.com')), 'example.com'); // www folded
  assert.equal(cookiePartitionSite(part('https://example.co.uk')), 'example.co.uk');
  assert.equal(cookiePartitionSite({}), '');
});

test('cookieGoverningHost: partition site wins; else own host (www/dot stripped)', () => {
  assert.equal(cookieGoverningHost({ domain: '.example.com' }), 'example.com');       // unpart → own host
  assert.equal(cookieGoverningHost({ domain: 'example.com' }), 'example.com');         // host-only
  assert.equal(cookieGoverningHost({ domain: '.www.example.com' }), 'example.com');    // www stripped
  assert.equal(cookieGoverningHost({ domain: '.mail.google.com' }), 'mail.google.com'); // non-www subdomain kept
  // partitioned → governed by the partition SITE regardless of the cookie's host
  assert.equal(cookieGoverningHost({ domain: '.doubleclick.net', ...part('https://boingboing.net') }), 'boingboing.net');
});

test('isFirstPartyPartitioned: true unpartitioned / same-site; false cross-site tracker', () => {
  // unpartitioned → always first-party
  assert.equal(isFirstPartyPartitioned({ domain: '.example.com' }, ''), true);
  // site embedded itself (host === site)
  assert.equal(isFirstPartyPartitioned({ domain: '.youtube.com' }, 'youtube.com'), true);
  // first-party subdomain under the site
  assert.equal(isFirstPartyPartitioned({ domain: '.app.example.com' }, 'example.com'), true);
  // cross-site tracker (host ≠ site) → NOT first-party (whitelist must not shield it)
  assert.equal(isFirstPartyPartitioned({ domain: '.doubleclick.net' }, 'boingboing.net'), false);
  // dotted-boundary: notexample.com is not first-party to example.com
  assert.equal(isFirstPartyPartitioned({ domain: 'notexample.com' }, 'example.com'), false);
});
