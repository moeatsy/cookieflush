import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain } from '../lib/registrable-domain.js';

// Data-driven matrix across every domain shape the extension can meet.
// [input host (already www-stripped, lowercased), expected registrable eTLD+1 or null]
const CASES = [
  // --- generic gTLDs: apex resolves to itself, subdomains to the eTLD+1 ---
  ['example.com', 'example.com'],
  ['www2.example.com', 'example.com'],
  ['a.b.c.example.com', 'example.com'],
  ['example.net', 'example.net'],
  ['example.org', 'example.org'],
  ['foo.example.io', 'example.io'],
  ['foo.example.dev', 'example.dev'],
  ['foo.example.app', 'example.app'],
  ['foo.example.xyz', 'example.xyz'],

  // --- new/long gTLDs in SIMPLE_TLDS ---
  ['shop.brand.store', 'brand.store'],
  ['blog.brand.online', 'brand.online'],

  // --- ccTLD second-level suffixes (MULTI_SUFFIXES): eTLD+1 keeps the SLD ---
  ['example.co.uk', 'example.co.uk'],
  ['shop.example.co.uk', 'example.co.uk'],
  ['a.b.example.co.uk', 'example.co.uk'],
  ['example.org.uk', 'example.org.uk'],
  ['sub.example.ac.uk', 'example.ac.uk'],
  ['x.example.com.au', 'example.com.au'],
  ['x.example.co.jp', 'example.co.jp'],
  ['x.example.com.br', 'example.com.br'],
  ['x.example.co.za', 'example.co.za'],
  ['x.example.co.in', 'example.co.in'],
  ['x.example.co.kr', 'example.co.kr'],
  ['x.example.com.cn', 'example.com.cn'],
  ['x.example.com.hk', 'example.com.hk'],
  ['x.example.com.tr', 'example.com.tr'],
  ['x.example.com.mx', 'example.com.mx'],

  // --- flat ccTLDs kept in SIMPLE_TLDS: bare 2-label is registrable ---
  ['app.yandex.ru', 'yandex.ru'],
  ['api.x.ai', 'x.ai'],
  ['shop.brand.co', 'brand.co'],
  ['sub.example.de', 'example.de'],
  ['sub.example.fr', 'example.fr'],
  ['sub.example.nl', 'example.nl'],
  ['sub.example.pl', 'example.pl'],
  ['sub.example.ua', 'example.ua'],
  ['sub.example.io', 'example.io'],

  // --- second-level suffixes of those flat ccTLDs (added to MULTI): own unit ---
  ['a.pp.ru', 'a.pp.ru'],
  ['foo.edu.co', 'foo.edu.co'],
  ['x.gov.ua', 'x.gov.ua'],
  ['y.com.ai', 'y.com.ai'],

  // --- private hosting suffixes (PSL private section): NEVER over-reach ---
  ['foo.github.io', 'foo.github.io'],
  ['user.gitlab.io', 'user.gitlab.io'],
  ['app.vercel.app', 'app.vercel.app'],
  ['app.netlify.app', 'app.netlify.app'],
  ['app.pages.dev', 'app.pages.dev'],
  ['app.workers.dev', 'app.workers.dev'],
  ['app.herokuapp.com', 'app.herokuapp.com'],
  ['blog.blogspot.com', 'blog.blogspot.com'],

  // --- .us fail-safe: geographic / k12 trees not enumerable → null ---
  ['www.school.k12.ca.us', null],
  ['dept.ci.chicago.il.us', null],
  ['example.us', null],

  // --- unrecognized / degenerate → null (fail-safe: caller offers exact only) ---
  ['sub.example.unknowntld', null],
  ['co.uk', null],            // bare public suffix
  ['com', null],              // single label
  ['localhost', null],        // single label
  ['', null],                 // empty
  ['192.168.1.1', null],      // IPv4-ish (no known suffix)
  ['xn--80ak6aa92e.com', 'xn--80ak6aa92e.com'], // punycode label under .com

  // --- apex on a known suffix is its OWN registrable (host === eTLD+1) ---
  ['github.io', 'github.io'], // 'io' is a SIMPLE tld → treated as example.io shape
];

test('registrableDomain matrix across all domain shapes', () => {
  for (const [input, expected] of CASES) {
    assert.equal(registrableDomain(input), expected, `registrableDomain(${JSON.stringify(input)})`);
  }
});

test('subdomain detection: host !== registrable ⇒ subdomain, else apex', () => {
  const isSub = (h) => { const r = registrableDomain(h); return !!r && r !== h; };
  assert.equal(isSub('edition.cnn.com'), true);
  assert.equal(isSub('cnn.com'), false);
  assert.equal(isSub('sub.example.co.uk'), true);
  assert.equal(isSub('example.co.uk'), false);
  assert.equal(isSub('foo.github.io'), false);   // its own registrable unit
  assert.equal(isSub('example.us'), false);       // unresolved → not treated as subdomain
});
