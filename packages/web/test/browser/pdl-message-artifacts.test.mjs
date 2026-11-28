import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { register } from 'tsx/esm/api';

register();
const { startArtifactPreview } = await import('./fixtures/message-artifacts-server.mts');

test(
  'ordinary messages and hold notices share compact artifact links in both themes and open native file preview',
  { timeout: 60000 },
  async () => {
    const app = await startArtifactPreview(),
      browser = await chromium.launch({ headless: true });
    try {
      for (const theme of ['sys:1', 'pkg:v2'])
        for (const mobile of [false, true]) {
          const page = await browser.newPage({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 },
          });
          const errors = [];
          page.on('pageerror', (error) => {
            errors.push(error.message);
            console.error(error.stack);
          });
          page.on('console', (m) => {
            if (m.type() === 'error') console.error(m.text());
          });
          try {
            await page.goto(app.url + '/?theme=' + theme);
            await page.waitForFunction(() => window.artifactFixtureReady, undefined, { timeout: 10000 });
            if (mobile) await page.evaluate("A.set({path:'s.tweaks.theme',v:'dark'})");
            const message = page.locator('[data-stream] > [data-mid="hold-notice"]');
            const dock = message.locator('[data-artifact-dock]');
            await dock.waitFor();
            assert.equal(await page.locator('[data-stream] [data-artifact-dock]').count(), 2);
            assert.equal(await dock.locator('a').count(), 4);
            await page
              .context()
              .route('https://github.com/**', (route) =>
                route.fulfill({ contentType: 'text/html', body: '<p>External artifact destination</p>' }),
              );
            const [popup] = await Promise.all([page.waitForEvent('popup'), dock.locator('a').first().click()]);
            await popup.waitForLoadState();
            assert.equal(popup.url(), 'https://github.com/zts212653/clowder-ai/pull/2131');
            await popup.close();
            assert.equal(await message.locator('.artifact-inline a').count(), 0);
            assert.equal(await dock.locator('.artifact-segment--issue svg').count(), 1);
            assert.equal(await dock.locator('button').getAttribute('data-v'), 'docs/SOP.md');
            const quote = await page.evaluate(() => {
              const value = document.querySelector('[data-mid="hold-notice"] .artifact-inline--commit');
              const range = document.createRange();
              range.selectNodeContents(value);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              const quote = window.artifactReadSelection();
              selection.removeAllRanges();
              return quote;
            });
            assert.equal(quote.text, 'f4212a2d84adf58e18fdd04968e988bdab586b02');
            assert.equal(quote.renderedOccurrences, 1);
            const bounds = await dock.boundingBox();
            assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1280));
            if (process.env.ARTIFACT_SCREENSHOTS) {
              await mkdir(process.env.ARTIFACT_SCREENSHOTS, { recursive: true });
              await page.screenshot({
                path:
                  process.env.ARTIFACT_SCREENSHOTS + '/' + theme.replace(':', '-') + (mobile ? '-mobile' : '') + '.png',
                animations: 'disabled',
              });
            }
            await dock.locator('button').click();
            await page.waitForFunction(() => window.artifactOpenedPath === 'docs/SOP.md');
            await page.getByText('Clowder AI 开发 SOP', { exact: false }).first().waitFor({ timeout: 5000 });
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        }
    } finally {
      await browser.close();
      await app.close();
    }
  },
);
