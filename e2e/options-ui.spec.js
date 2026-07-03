import { test, expect } from './fixtures.js';

// The driver fixture parks its page ON options.html, so these tests drive the
// real settings UI (inputs, selects, buttons) and assert on the real storage
// the background writes.

test('options whitelist add: default scope adds a wildcard entry', async ({ driver }) => {
  await driver.setSync({ whitelist: [], whitelistExact: [] });
  await driver.page.fill('#new-whitelist', 'example.org');
  await driver.page.click('#add-whitelist');
  await expect.poll(async () => (await driver.getSync(['whitelist'])).whitelist).toContain('example.org');
  expect((await driver.getSync(['whitelistExact'])).whitelistExact || []).not.toContain('example.org');
});

test('options whitelist add: "This host only" adds an EXACT entry', async ({ driver }) => {
  await driver.setSync({ whitelist: [], whitelistExact: [] });
  await driver.page.fill('#new-whitelist', 'shop.example.org');
  await driver.page.selectOption('#new-whitelist-scope', 'exact');
  await driver.page.click('#add-whitelist');
  await expect.poll(async () => (await driver.getSync(['whitelistExact'])).whitelistExact).toContain('shop.example.org');
  expect((await driver.getSync(['whitelist'])).whitelist || []).not.toContain('shop.example.org');
});

test('JSON export omits the clean history (privacy) but keeps settings + counters', async ({ driver }) => {
  // Seed a log entry that must NOT appear in the export, plus a counter that must.
  await driver.page.evaluate(() => new Promise(r =>
    chrome.storage.local.set({
      deletionLog: [{ timestamp: 1700000000000, domain: 'secret-site.com', count: 3 }],
      totalCleaned: 42,
    }, () => r(true)),
  ));
  await driver.setSync({ whitelist: ['example.org'] });

  // Capture the exported blob instead of letting the browser download it.
  const exported = await driver.page.evaluate(() => new Promise((resolve) => {
    URL.createObjectURL = (blob) => { window.__blob = blob; return 'blob:noop'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('export-config').click();
    const t = setInterval(() => {
      if (window.__blob) { clearInterval(t); window.__blob.text().then(resolve); }
    }, 50);
  }));

  expect(exported).not.toContain('secret-site.com');
  const parsed = JSON.parse(exported);
  expect(parsed.local.deletionLog, 'no clean history in the file').toBeUndefined();
  expect(parsed.local.totalCleaned, 'aggregate counter kept').toBe(42);
  expect(parsed.sync.whitelist, 'whitelist kept').toContain('example.org');
});
