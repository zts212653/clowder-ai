import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { register } from 'tsx/esm/api';

register();
const { startPendingPreview } = await import('./fixtures/pending-decisions-server.mts');

test(
  'both built-in themes expose pending decisions and locate the selected original message',
  { timeout: 60000 },
  async () => {
    const app = await startPendingPreview();
    const browser = await chromium.launch({ headless: true });
    try {
      for (const scenario of [
        { theme: 'sys:1', mobile: false },
        { theme: 'pkg:v2', mobile: false },
        { theme: 'sys:1', mobile: true },
        { theme: 'pkg:v2', mobile: true },
      ]) {
        const { theme, mobile } = scenario;
        const page = await browser.newPage({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 },
          colorScheme: mobile ? 'dark' : 'light',
        });
        const errors = [];
        page.on('console', (m) => {
          if (m.type() === 'error') console.error('fixture console:', m.text());
        });
        page.on('pageerror', (e) => {
          errors.push(e.message);
          console.error('fixture page:', e.message);
        });
        try {
          await page.goto(app.url + '/?theme=' + theme);
          await page.waitForFunction(() => window.fixtureReady, undefined, { timeout: 10000 });
          if (mobile) {
            await page.evaluate("A.set({path:'s.tweaks.theme',v:'dark'})");
            assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
          }
          const entry = page.locator('.typing-scope [data-act="pendingDecisions"]');
          await entry.waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.match(await entry.innerText(), /2/);
          assert.equal(await page.locator('[data-tid="pdl-test"] [data-act="pendingDecisions"]').count(), 1);
          await entry.click();
          const target = page.locator('[data-act="msgJump"]').filter({ hasText: 'Review an older taste proposal' });
          await target.click();
          await page.locator('[data-stream] > [data-mid="old-approval"].emph').waitFor({ timeout: 5000 });
          if (process.env.PENDING_SCREENSHOTS) {
            await mkdir(process.env.PENDING_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path:
                process.env.PENDING_SCREENSHOTS + '/' + theme.replace(':', '-') + (mobile ? '-mobile' : '') + '.png',
              animations: 'disabled',
            });
          }
          await page.evaluate(() => window.settlePending());
          assert.equal(await entry.count(), 0);
          assert.equal(await page.locator('#chat-input').inputValue(), 'Keep this draft');
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error('fixture body:', (await page.locator('body').innerText()).slice(0, 1400));
          throw error;
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
