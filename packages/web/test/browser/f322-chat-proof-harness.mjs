import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { origin, webRoot } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD, createChatProofApi, DRAFT } from './fixtures/f322-chat-real-page-data.mjs';
import { measureChatProof } from './fixtures/f322-chat-real-page-metrics.mjs';

export function createChatProofHarness(context, built, evidenceDir, measurements, configureApi) {
  async function openProof({
    width = 1440,
    base = 'light',
    language = 'zh',
    sidebar = true,
    crowded = false,
    surface = false,
    resizable = false,
  } = {}) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    page.setDefaultTimeout(7000);
    const api = createChatProofApi(Date.now(), crowded, surface);
    configureApi?.(api);
    const errors = [],
      unexpected = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ language }) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('cat-cafe:sidebar:active-tab', 'pinned');
      },
      { language },
    );
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(request.url());
        return route.abort();
      }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
      if (url.pathname.startsWith('/api/')) {
        const response = api.respond(request, url);
        if (response) return route.fulfill(response);
        unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      if (url.pathname.startsWith('/avatars/')) {
        const file = path.resolve(webRoot, 'public', url.pathname.slice(1));
        if (file.startsWith(path.join(webRoot, 'public/avatars/')) && existsSync(file))
          return route.fulfill({ contentType: 'image/png', body: readFileSync(file) });
        const familyFile = path.resolve(webRoot, 'public/avatars/family', path.basename(url.pathname));
        if (familyFile.startsWith(path.join(webRoot, 'public/avatars/family/')) && existsSync(familyFile))
          return route.fulfill({ contentType: 'image/png', body: readFileSync(familyFile) });
        unexpected.push(url.pathname);
        return route.abort();
      }
      if (url.pathname !== `/thread/${CURRENT_THREAD}`) {
        unexpected.push(url.pathname);
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    await page.goto(
      `${origin}/thread/${CURRENT_THREAD}?sidebar=${sidebar ? '1' : '0'}&surface=${surface ? '1' : '0'}&resizable=${resizable ? '1' : '0'}`,
      {
        waitUntil: 'networkidle',
      },
    );
    await page.getByTestId('chat-proof-ready').waitFor({ state: 'attached' });
    await page.waitForFunction((draft) => document.querySelector('textarea')?.value === draft, DRAFT);
    await page.evaluate((base) => window.__f322Chat.theme(base), base);
    await page.evaluate(() => window.__f322Chat.applied());
    await page.evaluate(() =>
      Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null)))),
    );
    return { page, api, errors, unexpected };
  }
  async function closeProof(proof) {
    await proof.page.close();
    assert.deepEqual(proof.errors, []);
    assert.deepEqual(proof.unexpected, []);
  }
  async function capture(page, name) {
    const metrics = await page.evaluate(measureChatProof);
    measurements.push({ name, ...metrics });
    await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: true });
    return metrics;
  }
  async function captureFailure(page, name, error) {
    await page.screenshot({ path: path.join(evidenceDir, `${name}-failure.png`), fullPage: true });
    writeFileSync(
      path.join(evidenceDir, `${name}-failure.txt`),
      String(error.stack ?? error) + '\n' + (await page.locator('body').innerText()),
    );
  }
  return { openProof, closeProof, capture, captureFailure };
}
