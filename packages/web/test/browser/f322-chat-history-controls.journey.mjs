import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { DRAFT } from './fixtures/f322-chat-real-page-data.mjs';

// Real header + ThreadChatSurface + history/reading controls + message records + composer.
// Existing isolated HTTP/socket boundaries; no runtime services or production mutations.
export async function runChatHistoryControls(browser, built, evidenceDir) {
  const out = process.env.F322_HISTORY_CONTROLS_EVIDENCE_DIR ?? evidenceDir;
  mkdirSync(out, { recursive: true });
  const context = await browser.newContext();
  const observations = [];
  const harness = createChatProofHarness(context, built, out, [], (api) => {
    const respond = api.respond;
    api.respond = (request, url) => {
      const result = respond(request, url);
      if (request.method() === 'GET' && url.pathname.endsWith('/artifacts')) {
        // The complete catalogue contains 774 works; the visible page is empty.
        // A row-count implementation therefore fails this same canonical read.
        return {
          ...result,
          body: JSON.stringify({ view: 'works', artifacts: [], total: 774, complete: true, workLineage: 'resolved' }),
        };
      }
      return result;
    };
  });
  try {
    for (const [width, sidebar, language, base] of [
      [1440, true, 'zh', 'light'],
      [700, true, 'en', 'dark'],
      [390, false, 'zh', 'dark'],
      [390, false, 'en', 'light'],
    ]) {
      const proof = await harness.openProof({ width, sidebar, language, base, surface: true });
      const { page, api } = proof;
      const name = `${width}-${language}-${base}`;
      try {
        await page.getByTestId('header-works').filter({ hasText: '774' }).waitFor();
        assert.ok(api.requests.some((r) => r.path.endsWith('/artifacts') && r.search === '?view=works'));
        assert.equal(await page.locator('textarea').inputValue(), DRAFT);
        const port = page.locator('[data-chat-container]');
        const bounds = await port.boundingBox();
        assert.ok(bounds?.height > 100);
        await page.mouse.move(bounds.x + 40, bounds.y + 80);
        await page.mouse.wheel(0, -10000);
        const latest = page.getByRole('button', { name: '到最新', exact: true });
        await latest.waitFor();
        const measure = () =>
          page.evaluate(() => {
            const rect = (node) => {
              if (!node) return null;
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
            };
            const port = document.querySelector('[data-chat-container]');
            const button = document.querySelector('button[aria-label="到最新"]');
            return {
              port: rect(port),
              reading: rect(document.querySelector('[data-thread-chat-reading-column]')),
              button: rect(button),
              piano: rect(document.querySelector('[data-message-piano]')),
              footer: rect(document.querySelector('[data-thread-chat-footer]')),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
        const before = await measure();
        await page.screenshot({ path: path.join(out, `${name}-reading.png`) });
        observations.push({ name, before });
        writeFileSync(path.join(out, 'proof.json'), JSON.stringify(observations, null, 2));
        assert.ok(before.button.y >= before.port.y, 'latest control stays inside the reading viewport');
        assert.ok(before.button.bottom <= before.port.bottom, 'latest control stays above the viewport edge');
        assert.ok(
          before.button.x >= before.reading.right,
          'latest control uses the navigation rail instead of covering readable messages',
        );
        assert.ok(before.button.right <= before.piano.x, 'latest control stays clear of the message piano');
        const historyFooterGap = before.footer.y - before.port.bottom;
        assert.ok(
          historyFooterGap >= 0 && historyFooterGap <= 8.5,
          'only the existing composer spacing follows history',
        );
        assert.ok(before.overflow <= 1, 'the added control space does not widen the page');
        const readingHeight = before.port.height;
        const footerTop = before.footer.y;
        await latest.click();
        await latest.waitFor({ state: 'hidden' });
        // The original owner uses smooth scrolling. Button visibility only proves
        // that its 120px threshold was crossed, not that the animation settled.
        await page.waitForFunction(() => {
          const node = document.querySelector('[data-chat-container]');
          return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
        });
        const bottom = await port.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
        assert.ok(bottom <= 2, 'the original jump action reaches the actual bottom');
        const after = await measure();
        assert.ok(
          Math.abs(after.port.height - readingHeight) <= 1 && Math.abs(after.footer.y - footerTop) <= 1,
          'showing or hiding the control never resizes the reading viewport',
        );
        assert.equal(await page.locator('textarea').inputValue(), DRAFT, 'jump preserves the unsent draft');
        assert.equal(api.sent.length, 0, 'reading and jump never send a message');
        await page.screenshot({ path: path.join(out, `${name}-latest.png`) });
      } catch (error) {
        await harness.captureFailure(page, name, error);
        throw error;
      } finally {
        await harness.closeProof(proof);
      }
    }
  } finally {
    await context.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildChatProof();
  const browser = await chromium.launch({ headless: true });
  try {
    await runChatHistoryControls(browser, built, path.join(os.tmpdir(), `f322-history-controls-${process.pid}`));
  } finally {
    await browser.close();
  }
}
