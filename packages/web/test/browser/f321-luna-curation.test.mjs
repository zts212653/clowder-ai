import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const ORIGIN = process.env.F321_LUNA_PREVIEW_ORIGIN ?? 'http://localhost:5182';
const API = process.env.F321_LUNA_PREVIEW_API ?? 'http://127.0.0.1:3012';
const EVIDENCE =
  process.env.F321_LUNA_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f321-curation-withdrawal');
let browser;
before(async () => {
  await mkdir(EVIDENCE, { recursive: true });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

for (const [width, theme] of [
  [1440, 'light'],
  [390, 'light'],
  [390, 'dark'],
])
  test(`all memories restores the home study without curation at ${width}px ${theme}`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    await context.addInitScript((mode) => {
      localStorage.setItem('theme', mode);
      localStorage.setItem(
        'cat-cafe:themes',
        JSON.stringify({ version: '2026-06-10-dark-token-init', activeId: mode, custom: [], builtInOverrides: {} }),
      );
    }, theme);
    const page = await context.newPage();
    const errors = [];
    const curationRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/memory/curation') curationRequests.push(request.url());
    });
    const session = await context.request.get(`${API}/api/session`);
    assert.ok(session.ok());
    await context.addCookies(
      (await context.cookies()).map((cookie) => ({ ...cookie, domain: new URL(ORIGIN).hostname })),
    );
    try {
      const tasteRead = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/memory/taste');
      await page.goto(`${ORIGIN}/memory?tab=all&shell=v2`, { waitUntil: 'domcontentloaded' });
      assert.equal((await tasteRead).status(), 200, 'the real taste endpoint must remain readable');
      const study = page.getByRole('region', { name: '主星书房', exact: true });
      await study.waitFor();
      await page.waitForFunction((mode) => document.documentElement.getAttribute('data-theme') === mode, theme);
      assert.equal(await page.locator('main h1, main h2').first().innerText(), '主星书房');
      assert.equal(await page.getByRole('region', { name: '这段时间', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: '整理设置', exact: true }).count(), 0);
      const box = await study.boundingBox();
      const header = await page.locator('[data-testid="memory-page-preview"] > header').boundingBox();
      assert.ok(box && header);
      assert.ok(Math.abs(box.y - (header.y + header.height)) <= 1, 'study must immediately follow the page header');
      assert.ok(box.y + box.height < 960, 'the home study must fit on the first screen');
      assert.deepEqual(curationRequests, []);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await page.screenshot({ path: path.join(EVIDENCE, `all-${width}-${theme}.png`) });
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(EVIDENCE, `layout-${width}-${theme}.json`),
        JSON.stringify({ width, theme, study: box, overflow, errors, curationRequests }, null, 2),
      );
    } finally {
      await context.close();
    }
  });
