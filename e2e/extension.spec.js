import { test, expect } from './fixtures.js';

test('extension loads and registers a service worker', async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test('popup page renders without script errors', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('.brand-name')).toHaveText('CookieFlush');
  await expect(page.locator('#primary-action')).toBeAttached();
  expect(errors, errors.join('\n')).toEqual([]);
  await page.close();
});

test('whitelist messages: wildcard, exact, and coverage rules', async ({ driver }) => {
  await driver.setSync({ whitelist: [], whitelistExact: [] });

  expect((await driver.send({ action: 'add-whitelist', hostname: 'cnn.com' })).result).toBe('added');
  expect((await driver.send({ action: 'add-whitelist-exact', hostname: 'only.com' })).result).toBe('added');

  let sync = await driver.getSync(['whitelist', 'whitelistExact']);
  expect(sync.whitelist).toContain('cnn.com');
  expect(sync.whitelistExact).toContain('only.com');

  // Exact host already covered by a broader wildcard → not added.
  expect((await driver.send({ action: 'add-whitelist-exact', hostname: 'edition.cnn.com' })).result).toBe('covered');
  // Wildcard child of an existing wildcard → not added.
  expect((await driver.send({ action: 'add-whitelist', hostname: 'edition.cnn.com' })).result).toBe('covered');

  // Adding wildcard that covers an existing exact prunes the redundant exact.
  expect((await driver.send({ action: 'add-whitelist', hostname: 'only.com' })).result).toBe('added');
  sync = await driver.getSync(['whitelist', 'whitelistExact']);
  expect(sync.whitelist).toContain('only.com');
  expect(sync.whitelistExact).not.toContain('only.com');

  // Popup "Remove" (exact:false) drops the covering wildcard.
  expect((await driver.send({ action: 'remove-whitelist', hostname: 'edition.cnn.com' })).removed).toBe('cnn.com');
  sync = await driver.getSync(['whitelist']);
  expect(sync.whitelist).not.toContain('cnn.com');
});

test('cookie cleanup: wildcard keeps host + subdomains, non-whitelisted cleaned', async ({ driver }) => {
  await driver.setSync({ enabled: true, whitelist: [], whitelistExact: [], greylist: {} });

  // Seed cookies for three domains.
  expect(await driver.setCookie('https://cf-keep.com/', 'sid', '1')).toBeTruthy();
  expect(await driver.setCookie('https://sub.cf-keep.com/', 'sid', '1')).toBeTruthy();
  expect(await driver.setCookie('https://cf-clean.com/', 'sid', '1')).toBeTruthy();

  // Whitelist cf-keep.com as a wildcard (covers its subdomains).
  expect((await driver.send({ action: 'add-whitelist', hostname: 'cf-keep.com' })).result).toBe('added');

  // Global manual sweep.
  await driver.send({ action: 'force-clean-all' });

  expect(await driver.getCookie('https://cf-keep.com/', 'sid'), 'whitelisted host kept').toBeTruthy();
  expect(await driver.getCookie('https://sub.cf-keep.com/', 'sid'), 'subdomain of wildcard kept').toBeTruthy();
  expect(await driver.getCookie('https://cf-clean.com/', 'sid'), 'non-whitelisted cleaned').toBeNull();
});

test('cookie cleanup: EXACT entry keeps only the host, its subdomain is cleaned', async ({ driver }) => {
  await driver.setSync({ enabled: true, whitelist: [], whitelistExact: [], greylist: {} });

  expect(await driver.setCookie('https://cf-exact.com/', 'sid', '1')).toBeTruthy();
  expect(await driver.setCookie('https://sub.cf-exact.com/', 'sid', '1')).toBeTruthy();

  // Exact whitelist: cf-exact.com only, NOT its subdomains.
  expect((await driver.send({ action: 'add-whitelist-exact', hostname: 'cf-exact.com' })).result).toBe('added');

  await driver.send({ action: 'force-clean-all' });

  expect(await driver.getCookie('https://cf-exact.com/', 'sid'), 'exact host kept').toBeTruthy();
  expect(await driver.getCookie('https://sub.cf-exact.com/', 'sid'), 'subdomain NOT covered by exact → cleaned').toBeNull();
});
