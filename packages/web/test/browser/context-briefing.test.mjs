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
  ...[1280, 320, 375].flatMap((width) =>
    ['light', 'dark'].map((theme) => ({ name: `modern-${width}-${theme}`, width, theme, sample: 'modern' })),
  ),
  { name: 'desktop-legacy', width: 1280, theme: 'light', sample: 'legacy' },
  { name: 'mobile-legacy', width: 375, theme: 'dark', sample: 'legacy' },
  { name: 'mobile-missing', width: 375, theme: 'light', sample: 'missing' },
  { name: 'mobile-missing-dark', width: 320, theme: 'dark', sample: 'missing' },
  { name: 'desktop-warning', width: 1280, theme: 'light', sample: 'warning' },
  { name: 'mobile-warning', width: 320, theme: 'dark', sample: 'warning' },
].forEach(({ name, width, theme, sample }) => {
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
    await page.goto(`${origin}/?theme=${theme}&case=${sample}`);
    const row = page.locator('[data-message-id="context-briefing-proof"]');
    await row.waitFor();
    assert.match(await row.innerText(), /上下文交接/);
    assert.match(await row.innerText(), sample === 'legacy' || sample === 'missing' ? /接收猫：未记录/ : /给 墨墨/);
    assert.doesNotMatch(await row.innerText(), /threadId|cat_cafe_|T0|→ 你/);
    assert.doesNotMatch(await row.innerText(), /42|本次提供给猫的背景/);
    if (sample === 'modern' || sample === 'warning') assert.match(await row.innerText(), /请核对侧栏菜单/);
    if (sample === 'warning') assert.match(await row.innerText(), /之前有“别动”指令/);
    await page.screenshot({ path: path.join(evidence, `${name}-collapsed.png`), fullPage: true });
    await row.screenshot({ path: path.join(evidence, `${name}-card-collapsed.png`) });
    const inspect = () =>
      row.evaluate((element) => {
        const card = element.querySelector('[data-context-receipt]');
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
    assert.equal(await row.locator('details').count(), 0, 'one disclosure opens every detail');
    assert.match(await row.innerText(), /诊断/);
    assert.match(await row.innerText(), /已提供的线程记忆摘要/);
    assert.match(await row.innerText(), /已提供的锚点摘要/);
    assert.match(await row.innerText(), /保留原有活跃任务/);
    assert.match(await row.innerText(), /保留独有字段值/);
    assert.match(await row.innerText(), /候选仅为指针/);
    assert.match(await row.innerText(), /T0 7/);
    await page.screenshot({ path: path.join(evidence, `${name}-expanded.png`), fullPage: true });
    await row.screenshot({ path: path.join(evidence, `${name}-card-expanded.png`) });
    const expanded = await inspect();
    writeFileSync(path.join(evidence, `${name}-expanded.json`), JSON.stringify(expanded, null, 2));
    assert.deepEqual(expanded.overflowing, [], 'expanded commands, IDs and paths must wrap without clipping');
    assert.ok(expanded.pageScroll <= expanded.pageWidth + 1);
    assert.match(await row.innerText(), /cat_cafe_search_evidence/);
    await row.getByRole('button').first().press('Enter');
    assert.equal(await row.getByRole('button').first().getAttribute('aria-expanded'), 'false');
    assert.doesNotMatch(await row.innerText(), /cat_cafe_|threadId|T0/);
    assert.deepEqual(errors, []);
  });
});
