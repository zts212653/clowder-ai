import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildChatProof, origin } from './fixtures/f322-chat-real-page-build.mjs';

const evidence = process.env.BRIEFING_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'context-briefing');
let browser;
let built;
before(
  async () => {
    mkdirSync(evidence, { recursive: true });
    built = await buildChatProof('context-briefing.tsx');
    browser = await chromium.launch({ headless: true });
  },
  { timeout: 120_000 },
);
after(async () => browser?.close());

[
  { name: 'desktop-narrow-chat', width: 1280, theme: 'light', legacy: false },
  { name: 'desktop-legacy', width: 1280, theme: 'light', legacy: true },
  { name: 'mobile-320', width: 320, theme: 'light', legacy: false },
  { name: 'mobile-375-dark', width: 375, theme: 'dark', legacy: true },
].forEach(({ name, width, theme, legacy }) => {
  test(`${name}: long briefing content remains inside the real chat card`, { timeout: 30_000 }, async (t) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${origin}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    await page.goto(`${origin}/?theme=${theme}&legacy=${legacy ? '1' : '0'}`);
    const row = page.locator('[data-message-id="context-briefing-proof"]');
    await row.waitFor();
    assert.match(await row.innerText(), /上下文交接/);
    assert.match(await row.innerText(), legacy ? /接收猫：未记录/ : /接收猫：墨墨/);
    assert.doesNotMatch(await row.innerText(), /threadId|cat_cafe_|T0|→ 你/);
    if (!legacy) assert.match(await row.innerText(), /近期消息 5 条 · 历史略过 42 条/);
    await page.screenshot({ path: path.join(evidence, `${name}-collapsed.png`), fullPage: true });
    const inspect = () =>
      row.evaluate((element) => {
        const card = element.querySelector('button')?.parentElement;
        const bounds = card.getBoundingClientRect();
        const overflowing = [...card.querySelectorAll('*')]
          .filter((child) => {
            const style = getComputedStyle(child);
            return style.display !== 'none' && child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1;
          })
          .map((child) => ({
            tag: child.tagName,
            text: child.textContent.slice(0, 80),
            width: child.clientWidth,
            scroll: child.scrollWidth,
          }));
        return {
          cardWidth: bounds.width,
          pageWidth: document.documentElement.clientWidth,
          pageScroll: document.documentElement.scrollWidth,
          overflowing,
        };
      });
    const collapsed = await inspect();
    writeFileSync(path.join(evidence, `${name}-collapsed.json`), JSON.stringify(collapsed, null, 2));
    assert.deepEqual(collapsed.overflowing, [], 'default card must not clip or overlap its content');
    assert.ok(collapsed.pageScroll <= collapsed.pageWidth + 1);
    await row.getByRole('button').first().click();
    const diagnostics = row.locator('summary').filter({ hasText: '诊断详情' });
    assert.equal(await diagnostics.count(), 1);
    assert.doesNotMatch(await row.innerText(), /cat_cafe_search_evidence/);
    await diagnostics.click();
    await page.screenshot({ path: path.join(evidence, `${name}-expanded.png`), fullPage: true });
    const expanded = await inspect();
    writeFileSync(path.join(evidence, `${name}-expanded.json`), JSON.stringify(expanded, null, 2));
    assert.deepEqual(expanded.overflowing, [], 'expanded commands, IDs and paths must wrap without clipping');
    assert.ok(expanded.pageScroll <= expanded.pageWidth + 1);
    assert.match(await row.innerText(), /cat_cafe_search_evidence/);
    await row.getByRole('button').first().click();
    assert.doesNotMatch(await row.innerText(), /cat_cafe_|threadId|T0/);
    assert.deepEqual(errors, []);
  });
});
