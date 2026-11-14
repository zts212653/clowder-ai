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
      const context = await browser.newContext();
      let unavailable = false;
      let retired = false;
      let bound = false;
      let opens = 0;
      let reads = 0;
      const entry = () => ({
        pluginId: 'dev.resident',
        instanceId: 'installed',
        commandId: 'main',
        label: '我的助手',
        threadId: bound ? BUSY_THREAD : null,
        status: 'ready',
        openable: true,
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
      retired = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await resident.waitFor({ state: 'detached' });
      await page.locator(`[data-thread-id="${BUSY_THREAD}"]`).first().waitFor();
      receipts.push({
        shell,
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
