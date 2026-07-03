import { test, expect } from './fixtures.js';

const reset = (d, extra = {}) => d.setSync({
  enabled: true, whitelist: [], whitelistExact: [], greylist: {},
  enableCookieRules: false, cookieRules: {}, ...extra,
});

test('ccTLD (.co.uk): wildlist covers host + subdomain, sibling registrable cleaned', async ({ driver }) => {
  await reset(driver);
  await driver.setCookie('https://example.co.uk/', 'sid', '1');
  await driver.setCookie('https://shop.example.co.uk/', 'sid', '1');
  await driver.setCookie('https://other.co.uk/', 'sid', '1');

  expect((await driver.send({ action: 'add-whitelist', hostname: 'example.co.uk' })).result).toBe('added');
  await driver.send({ action: 'force-clean-all' });

  expect(await driver.getCookie('https://example.co.uk/', 'sid'), 'apex kept').toBeTruthy();
  expect(await driver.getCookie('https://shop.example.co.uk/', 'sid'), 'subdomain kept').toBeTruthy();
  expect(await driver.getCookie('https://other.co.uk/', 'sid'), 'different registrable cleaned').toBeNull();
});

test('greylist keeps a host temporarily', async ({ driver }) => {
  await reset(driver);
  await driver.setCookie('https://grey.com/', 'sid', '1');
  await driver.setCookie('https://plain.com/', 'sid', '1');

  await driver.send({ action: 'add-greylist', hostname: 'grey.com' });
  await driver.send({ action: 'force-clean-all' });

  expect(await driver.getCookie('https://grey.com/', 'sid'), 'greylisted host kept').toBeTruthy();
  expect(await driver.getCookie('https://plain.com/', 'sid'), 'non-listed cleaned').toBeNull();
});

test('cookie rules: keep-rule shields a cookie on a non-whitelisted site; delete-rule wipes one on a whitelisted site', async ({ driver }) => {
  await reset(driver, {
    enableCookieRules: true,
    cookieRules: { '*': [{ name: 'keep_me', keep: true }, { name: 'zap', keep: false }] },
  });
  // whitelisted site
  await driver.send({ action: 'add-whitelist', hostname: 'ruled.com' });
  await driver.setCookie('https://ruled.com/', 'session', '1'); // no rule → kept (whitelisted)
  await driver.setCookie('https://ruled.com/', 'zap', '1');     // delete-rule → wiped even here
  // non-whitelisted site
  await driver.setCookie('https://open.com/', 'keep_me', '1');  // keep-rule → shielded
  await driver.setCookie('https://open.com/', 'trackme', '1');  // no rule → cleaned

  await driver.send({ action: 'force-clean-all' });

  expect(await driver.getCookie('https://ruled.com/', 'session'), 'whitelisted keeps unruled cookie').toBeTruthy();
  expect(await driver.getCookie('https://ruled.com/', 'zap'), 'delete-rule overrides whitelist').toBeNull();
  expect(await driver.getCookie('https://open.com/', 'keep_me'), 'keep-rule shields on non-whitelisted').toBeTruthy();
  expect(await driver.getCookie('https://open.com/', 'trackme'), 'unruled cookie on non-whitelisted cleaned').toBeNull();
});

test('per-site "Clean now" also removes shared parent-domain cookies (includeParent)', async ({ driver }) => {
  await reset(driver);
  // A page on the redirect target plus a domain-wide cookie the site shares.
  await driver.setCookie('https://edition.cnn.com/', 'local', '1');
  await driver.setCookieRaw({ url: 'https://edition.cnn.com/', domain: '.cnn.com', name: 'shared', value: '1' });

  const resp = await driver.send({ action: 'force-clean', hostname: 'edition.cnn.com' });
  expect(resp.ok).toBe(true);

  expect(await driver.getCookie('https://edition.cnn.com/', 'local'), 'own cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://cnn.com/', 'shared'), 'shared parent cookie cleaned').toBeNull();
});

test('per-site "Clean now" cleans the WHOLE site: sibling + deep-subdomain cookies', async ({ driver }) => {
  await reset(driver);
  await driver.setCookie('https://portal.bigsite.com/', 'own', '1');
  // A sibling host several layers deep (the CNN report) and a `.www.` cookie
  // left behind by a redirect — both siblings of the host being cleaned.
  await driver.setCookieRaw({ url: 'https://ads.tracker.bigsite.com/', domain: '.ads.tracker.bigsite.com', name: 'deep', value: '1' });
  await driver.setCookieRaw({ url: 'https://www.bigsite.com/', domain: '.www.bigsite.com', name: 'leftover', value: '1' });
  await driver.setCookie('https://othersite.com/', 'sid', '1');

  const resp = await driver.send({ action: 'force-clean', hostname: 'portal.bigsite.com' });
  expect(resp.ok).toBe(true);

  expect(await driver.getCookie('https://portal.bigsite.com/', 'own'), 'own cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://ads.tracker.bigsite.com/', 'deep'), 'deep sibling cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://www.bigsite.com/', 'leftover'), 'www leftover cleaned').toBeNull();
  expect(await driver.getCookie('https://othersite.com/', 'sid'), 'unrelated site untouched').toBeTruthy();
});

test('whole-site clean spares a whitelisted sibling host', async ({ driver }) => {
  await reset(driver);
  expect((await driver.send({ action: 'add-whitelist-exact', hostname: 'keep.bigsite2.com' })).result).toBe('added');
  await driver.setCookie('https://portal.bigsite2.com/', 'own', '1');
  await driver.setCookieRaw({ url: 'https://keep.bigsite2.com/', domain: '.keep.bigsite2.com', name: 'sib', value: '1' });

  await driver.send({ action: 'force-clean', hostname: 'portal.bigsite2.com' });

  expect(await driver.getCookie('https://portal.bigsite2.com/', 'own'), 'own cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://keep.bigsite2.com/', 'sib'), 'whitelisted sibling kept').toBeTruthy();
});

test('whole-site clean spares a sibling with an OPEN TAB (and the parent cookies it shares)', async ({ driver, context }) => {
  await reset(driver);
  // A live tab on a sibling host — served from a mocked route so the test
  // never touches the network. "Open tab wins": cleaning portal.* must not
  // yank live.*'s own cookies, nor the shared parent cookies it may be using.
  await context.route('https://live.bigsite3.com/**', route =>
    route.fulfill({ body: '<html>live</html>', contentType: 'text/html' }));
  const liveTab = await context.newPage();
  await liveTab.goto('https://live.bigsite3.com/');

  await driver.setCookie('https://portal.bigsite3.com/', 'own', '1');
  await driver.setCookieRaw({ url: 'https://live.bigsite3.com/', domain: '.live.bigsite3.com', name: 'sib', value: '1' });
  await driver.setCookieRaw({ url: 'https://portal.bigsite3.com/', domain: '.bigsite3.com', name: 'shared', value: '1' });

  await driver.send({ action: 'force-clean', hostname: 'portal.bigsite3.com' });

  expect(await driver.getCookie('https://portal.bigsite3.com/', 'own'), 'own cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://live.bigsite3.com/', 'sib'), 'open-tab sibling kept').toBeTruthy();
  expect(await driver.getCookie('https://bigsite3.com/', 'shared'), 'parent cookie shared with the open sibling kept').toBeTruthy();
  await liveTab.close();
});

test('manual clean second pass catches a cookie the page re-sets right after (BBC ecos.dt)', async ({ driver }) => {
  await reset(driver);
  await driver.setCookie('https://beacon-site.com/', 'ecos.dt', 'old');

  await driver.send({ action: 'force-clean', hostname: 'beacon-site.com' });
  expect(await driver.getCookie('https://beacon-site.com/', 'ecos.dt'), 'first pass removed it').toBeNull();

  // Simulate the page's beacon script re-setting the cookie moments later.
  await driver.setCookie('https://beacon-site.com/', 'ecos.dt', 'reset');
  expect(await driver.getCookie('https://beacon-site.com/', 'ecos.dt'), 're-set landed').toBeTruthy();

  // The silent follow-up pass fires 1.5s after the first clean.
  await driver.page.waitForTimeout(2600);
  expect(await driver.getCookie('https://beacon-site.com/', 'ecos.dt'), 'second pass removed the re-set cookie').toBeNull();
});

test('manual clean of a WHITELISTED site stays rules-only and never widens to siblings', async ({ driver }) => {
  await reset(driver, {
    whitelistExact: ['portal.bigsite4.com'],
    enableCookieRules: true,
    cookieRules: { 'portal.bigsite4.com': [{ name: 'zap', keep: false }] },
  });
  await driver.setCookie('https://portal.bigsite4.com/', 'zap', '1');      // delete-rule → wiped
  await driver.setCookie('https://portal.bigsite4.com/', 'session', '1');  // no rule → kept (whitelisted)
  await driver.setCookieRaw({ url: 'https://shop.bigsite4.com/', domain: '.shop.bigsite4.com', name: 'sib', value: '1' });

  await driver.send({ action: 'force-clean', hostname: 'portal.bigsite4.com' });

  expect(await driver.getCookie('https://portal.bigsite4.com/', 'zap'), 'delete-rule still applies').toBeNull();
  expect(await driver.getCookie('https://portal.bigsite4.com/', 'session'), 'whitelisted cookie kept').toBeTruthy();
  expect(await driver.getCookie('https://shop.bigsite4.com/', 'sib'), 'sibling untouched on a whitelisted site').toBeTruthy();
});

test('global keep-rule shields a sibling cookie during a whole-site clean', async ({ driver }) => {
  await reset(driver, {
    enableCookieRules: true,
    cookieRules: { '*': [{ name: 'keep_me', keep: true }] },
  });
  await driver.setCookie('https://portal.bigsite5.com/', 'own', '1');
  await driver.setCookieRaw({ url: 'https://ads.bigsite5.com/', domain: '.ads.bigsite5.com', name: 'keep_me', value: '1' });
  await driver.setCookieRaw({ url: 'https://ads.bigsite5.com/', domain: '.ads.bigsite5.com', name: 'junk', value: '1' });

  await driver.send({ action: 'force-clean', hostname: 'portal.bigsite5.com' });

  expect(await driver.getCookie('https://portal.bigsite5.com/', 'own'), 'own cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://ads.bigsite5.com/', 'keep_me'), 'keep-rule shields the sibling cookie').toBeTruthy();
  expect(await driver.getCookie('https://ads.bigsite5.com/', 'junk'), 'unruled sibling cookie cleaned').toBeNull();
});

test('EXACT whitelist of a parent protects its cookies when cleaning a subdomain', async ({ driver }) => {
  await reset(driver);
  await driver.setCookieRaw({ url: 'https://edition.cnn.com/', domain: '.cnn.com', name: 'shared', value: '1' });
  await driver.setCookie('https://edition.cnn.com/', 'local', '1');

  // cnn.com is whitelisted EXACT (only cnn.com, not its subdomains).
  expect((await driver.send({ action: 'add-whitelist-exact', hostname: 'cnn.com' })).result).toBe('added');

  // Clean the (non-whitelisted) subdomain.
  await driver.send({ action: 'force-clean', hostname: 'edition.cnn.com' });

  expect(await driver.getCookie('https://edition.cnn.com/', 'local'), 'subdomain cookie cleaned').toBeNull();
  expect(await driver.getCookie('https://cnn.com/', 'shared'), 'exact-whitelisted parent cookie kept').toBeTruthy();
});
