import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { BUSY_THREAD } from './fixtures/f322-chat-real-page-data.mjs';

// Product ThreadSidebar + HTTP client; all network requests are intercepted by
// the existing proof harness. No server, model, live API or runtime store is used.
test('resident native binding survives read failure and is not duplicated in either sidebar', async () => {
  const evidence = process.env.SUPERAGENT_NAV_EVIDENCE ?? path.join(os.tmpdir(), `resident-navigation-${process.pid}`);
  mkdirSync(evidence, { recursive: true });
  const built = await buildChatProof();
  const browser = await chromium.launch({ headless: true });
  const receipts = [];
  try {
    for (const shell of ['classic', 'v2']) {
      const context = await browser.newContext({ deviceScaleFactor: 2 });
      let unavailable = false;
      let retired = false;
      let disabled = false;
      let bound = false;
      let opens = 0;
      let reads = 0;
      const entry = () => ({
        pluginId: 'dev.resident',
        instanceId: 'installed',
        commandId: 'main',
        label: '我的助手',
        threadId: bound ? BUSY_THREAD : null,
        status: disabled ? 'disabled' : 'ready',
        openable: true,
        icon: { type: 'svg', src: '/api/plugin-manager/plugins/official.superagent/icon' },
      });
      const harness = createChatProofHarness(context, built, evidence, [], (api) => {
        const respond = api.respond;
        api.respond = (request, url) => {
          if (url.pathname === '/api/plugin-conversations') {
            reads++;
            return {
              status: unavailable ? 503 : 200,
              contentType: 'application/json',
              body: JSON.stringify({ entries: retired ? [] : [entry()] }),
            };
          }
          if (url.pathname === '/api/plugin-conversations/installed/main/open') {
            assert.equal(request.method(), 'POST');
            opens++;
            bound = true;
            return { status: 200, contentType: 'application/json', body: JSON.stringify({ entry: entry() }) };
          }
          return respond(request, url);
        };
      });
      const proof = await harness.openProof();
      const { page } = proof;
      await page.evaluate((value) => window.__f322Chat.presentation(value), shell);
      const resident = page.getByRole('navigation', { name: '常驻助手' });
      const ready = resident.getByRole('button', { name: '我的助手，可用' });
      await ready.waitFor();
      if (shell === 'v2') await page.getByTestId('sidebar-memory').waitFor();
      const geometry = await ready.evaluate((element) => {
        const glyph = element.querySelector('svg');
        const memory = document.querySelector('[data-testid="sidebar-memory"]');
        return {
          height: element.getBoundingClientRect().height,
          icon: {
            width: glyph.getBoundingClientRect().width,
            height: glyph.getBoundingClientRect().height,
            x: glyph.getBoundingClientRect().x,
            stroke: getComputedStyle(glyph).strokeWidth,
          },
          memoryIconX: memory?.querySelector('svg')?.getBoundingClientRect().x,
          text: element.textContent,
          imageCount: element.querySelectorAll('img').length,
        };
      });
      assert.equal(geometry.height, 32);
      assert.equal(geometry.icon.width, 16);
      assert.equal(geometry.icon.height, 16);
      assert.equal(geometry.icon.stroke, '1.75px');
      assert.equal(geometry.text, '我的助手');
      assert.equal(geometry.imageCount, 0);
      if (shell === 'v2') assert.equal(geometry.icon.x, geometry.memoryIconX, 'the resident glyph aligns with Memory');
      await page.screenshot({ path: path.join(evidence, `resident-${shell}-ready.png`), fullPage: true });
      await resident
        .locator('xpath=ancestor::aside[1]')
        .screenshot({ path: path.join(evidence, `sidebar-${shell}-ready.png`) });
      await resident.getByRole('button', { name: '我的助手，可用' }).click();
      await page.waitForURL(`**/thread/${BUSY_THREAD}`);
      await page.waitForFunction(
        (id) => document.querySelectorAll(`[data-thread-id="${id}"]`).length === 0,
        BUSY_THREAD,
      );
      assert.equal(opens, 1, 'only the explicit first open resolves the command');
      const before = reads;
      unavailable = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await resident.getByRole('button', { name: '我的助手，不可用' }).waitFor();
      await resident.getByRole('button', { name: '我的助手，不可用' }).click();
      assert.equal(opens, 1, 'the confirmed native target is still usable without another command');
      assert.ok(reads > before);
      await page.screenshot({ path: path.join(evidence, `resident-${shell}-read-error.png`), fullPage: true });
      unavailable = false;
      disabled = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const disabledEntry = resident.getByRole('button', { name: '我的助手，未启用' });
      await disabledEntry.waitFor();
      assert.equal(await disabledEntry.evaluate((element) => element.getBoundingClientRect().height), 32);
      await page.screenshot({ path: path.join(evidence, `resident-${shell}-disabled.png`), fullPage: true });
      await page.setViewportSize({ width: 640, height: 900 });
      const expand = page.getByRole('button', { name: /^(展开侧栏|Show sidebar)$/ });
      if (await expand.isVisible()) await expand.click();
      await disabledEntry.waitFor();
      const contained = await resident.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll('button, a')).every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right;
        });
      });
      assert.equal(contained, true, 'the settings affordance remains within a narrow sidebar');
      await page.screenshot({ path: path.join(evidence, `resident-${shell}-narrow.png`), fullPage: true });
      retired = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await resident.waitFor({ state: 'detached' });
      await page.locator(`[data-thread-id="${BUSY_THREAD}"]`).first().waitFor();
      receipts.push({
        shell,
        geometry,
        narrowContained: contained,
        explicitOpens: opens,
        retainedNavigation: true,
        ordinaryDuplicate: false,
        restoredAfterRetirement: true,
        errors: proof.errors,
        unexpected: proof.unexpected,
      });
      await harness.closeProof(proof);
      await context.close();
    }
    writeFileSync(path.join(evidence, 'result.json'), `${JSON.stringify(receipts, null, 2)}\n`);
    console.log(JSON.stringify({ evidence, receipts }));
  } finally {
    await browser.close();
  }
});
