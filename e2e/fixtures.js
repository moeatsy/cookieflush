import { test as base, chromium, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The extension is the parent dir of e2e/ (this test tooling lives inside it but
// is excluded from the shipped zip).
const EXTENSION_PATH = path.resolve(__dirname, '..');

// Loads the UNPACKED extension into a fresh, disposable Chromium profile.
// Extensions require a persistent context; each test file gets its own clean
// profile so cookies/storage don't leak between files.
export const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // `channel: 'chromium'` = the full Chrome-for-Testing build. Its new
      // headless mode CAN load extensions; Playwright's default headless-shell
      // cannot, so plain `headless: true` would silently start no service worker.
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // The extension's generated ID, read off its MV3 service worker URL.
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(sw.url().split('/')[2]);
  },

  // A page parked on a real extension URL (options.html). It has full chrome.*
  // access — cookies, storage, runtime messaging — so tests drive the REAL
  // background handlers and assert on the REAL cookie/storage state.
  driver: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await use(new Driver(page));
    await page.close();
  },
});

// Thin promisified wrapper around chrome.* evaluated inside the extension page.
class Driver {
  constructor(page) { this.page = page; }
  send(msg) {
    return this.page.evaluate(m => new Promise(r => chrome.runtime.sendMessage(m, r)), msg);
  }
  getSync(keys) {
    return this.page.evaluate(k => new Promise(r => chrome.storage.sync.get(k, r)), keys);
  }
  setSync(obj) {
    return this.page.evaluate(o => new Promise(r => chrome.storage.sync.set(o, () => r(true))), obj);
  }
  setCookie(url, name, value) {
    return this.page.evaluate(([u, n, v]) =>
      new Promise(r => chrome.cookies.set({ url: u, name: n, value: v }, r)), [url, name, value]);
  }
  // Full chrome.cookies.set details (e.g. an explicit parent `domain`).
  setCookieRaw(details) {
    return this.page.evaluate(d => new Promise(r => chrome.cookies.set(d, r)), details);
  }
  getCookie(url, name) {
    return this.page.evaluate(([u, n]) =>
      new Promise(r => chrome.cookies.get({ url: u, name: n }, c => r(c))), [url, name]);
  }
}

export { expect };
