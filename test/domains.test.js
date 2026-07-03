import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripWww, safeHostname } from '../lib/domains.js';

test('stripWww: drops leading www. and a trailing FQDN dot', () => {
  assert.equal(stripWww('www.example.com'), 'example.com');
  assert.equal(stripWww('example.com.'), 'example.com');       // FQDN trailing dot
  assert.equal(stripWww('www.example.com.'), 'example.com');   // both
  assert.equal(stripWww('example.com'), 'example.com');        // unchanged
  assert.equal(stripWww('edition.cnn.com'), 'edition.cnn.com'); // non-www subdomain kept
  assert.equal(stripWww('www2.example.com'), 'www2.example.com'); // only exact "www." prefix
  assert.equal(stripWww(''), '');
  assert.equal(stripWww(null), '');
  assert.equal(stripWww(undefined), '');
});

test('safeHostname: extracts hostname, null on garbage', () => {
  assert.equal(safeHostname('https://www.example.com/path?q=1'), 'www.example.com');
  assert.equal(safeHostname('http://sub.example.co.uk'), 'sub.example.co.uk');
  assert.equal(safeHostname('https://example.com:8443/'), 'example.com'); // port stripped
  assert.equal(safeHostname('not a url'), null);
  assert.equal(safeHostname(''), null);
  assert.equal(safeHostname('chrome://extensions'), 'extensions');
});
