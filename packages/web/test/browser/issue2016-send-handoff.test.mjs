import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof, webRoot } from './fixtures/f322-chat-real-page-build.mjs';

const evidence = path.resolve(webRoot, '../../.cat-cafe/tmp/issue2016-browser');
const measurements = [];
let browser, built;
before(async () => {
  await mkdir(evidence, { recursive: true });
  built = await buildChatProof();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await writeFile(path.join(evidence, 'verification.json'), JSON.stringify({ measurements }, null, 2));
});

for (const [width, base] of [
  [1440, 'light'],
  [390, 'dark'],
]) {
  test(`attachment handoff has immediate feedback and one visible snapshot at ${width}px ${base}`, async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const harness = createChatProofHarness(context, built, evidence, measurements);
    const proof = await harness.openProof({ surface: true, width, base, sidebar: width >= 720 });
    const { page } = proof;
    const text = '原正文和图片只能在一处展示';
    let held;
    let accepted = false;
    try {
      await page.route('**/message-attempts/*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            accepted
              ? { status: 'accepted', userMessage: { id: 'handoff-accepted', timestamp: 100 } }
              : { status: 'unknown' },
          ),
        }),
      );
      await page.route('**/api/messages', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        assert.equal(held, undefined, 'one send produces one request');
        held = route;
      });
      const imageBytes = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 240;
        canvas.height = 140;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#eee8df';
        drawing.fillRect(0, 0, 240, 140);
        drawing.fillStyle = '#3f453d';
        drawing.font = '20px sans-serif';
        drawing.fillText('Attachment preview', 22, 76);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await page.locator('input[type="file"]').setInputFiles({
        name: 'handoff.png',
        mimeType: 'image/png',
        buffer: Buffer.from(imageBytes, 'base64'),
      });
      await page.getByRole('button', { name: 'Remove handoff.png', exact: true }).waitFor();
      await page.locator('textarea').fill(text);
      await page.evaluate(() => {
        const read = FileReader.prototype.readAsArrayBuffer;
        const waiting = [];
        let holding = true;
        FileReader.prototype.readAsArrayBuffer = function (file) {
          if (holding) waiting.push(() => read.call(this, file));
          else read.call(this, file);
        };
        window.__releaseHandoff = () => {
          holding = false;
          waiting.splice(0).forEach((resume) => {
            resume();
          });
        };
      });
      await page.locator('textarea').press('Enter');
      const status = page.getByTestId('send-attempt-status');
      await status.locator(':scope[data-send-status="preparing"]').waitFor();
      const attemptRow = status.locator('xpath=ancestor::*[@data-message-viewport-boundary][1]');
      assert.ok((await status.innerText()).includes('正在准备发送'));
      assert.equal(await attemptRow.getByText(text, { exact: true }).count(), 0);
      assert.equal(await page.locator('textarea').inputValue(), text);
      assert.equal(held, undefined);
      assert.equal(await page.getByText('附件上传中，请稍候...', { exact: true }).count(), 0);
      await harness.capture(page, `handoff-${width}-${base}-preparing`);
      await page.evaluate((text) => {
        window.__handoffFrames = [];
        window.__watchHandoff = true;
        const sample = () => {
          const row = document.querySelector('[data-send-status]')?.closest('[data-message-viewport-boundary]');
          window.__handoffFrames.push({
            composer: document.querySelector('textarea')?.value.includes(text),
            bubble: row?.textContent.includes(text),
          });
          if (window.__watchHandoff) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, text);
      await page.locator('textarea').fill(`${text}\n下一条新输入`);
      await page.evaluate(() => window.__releaseHandoff());
      await status.locator(':scope[data-send-status="sending"]').waitFor();
      assert.equal(await attemptRow.getByText(text, { exact: true }).count(), 1);
      assert.equal(await page.locator('textarea').inputValue(), '\n下一条新输入');
      assert.equal(await page.getByRole('button', { name: 'Remove handoff.png', exact: true }).count(), 0);
      assert.equal(await page.getByText('附件上传中，请稍候...', { exact: true }).count(), 0);
      const row = await attemptRow.evaluateHandle((element) => element);
      assert.equal(await row.evaluate((element) => element.querySelectorAll('img[alt="附件"]').length), 1);
      await harness.capture(page, `handoff-${width}-${base}-sending`);
      const fits = await page.evaluate(() => {
        const frame = document.querySelector('[data-testid="chat-input-composer-row"]').getBoundingClientRect();
        return frame.left >= 0 && frame.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
      });
      assert.equal(fits, true, 'composer and document fit the actual viewport');
      const frames = await page.evaluate(() => {
        window.__watchHandoff = false;
        return window.__handoffFrames;
      });
      assert.ok(frames.length > 1);
      assert.ok(
        frames.every((frame) => frame.composer !== frame.bubble),
        JSON.stringify(frames),
      );
      measurements.push({ width, base, scope: 'isolated product surface, controlled HTTP, real IndexedDB', frames });
      const request = held.request();
      const form = await new Response(request.postDataBuffer(), {
        headers: { 'content-type': request.headers()['content-type'] },
      }).formData();
      assert.equal(form.get('content'), text);
      assert.equal(form.get('images').name, 'handoff.png');
      accepted = true;
      await held.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'queued', userMessageId: 'handoff-accepted' }),
      });
      await status.locator(':scope[data-send-status="accepted"]').waitFor();
      assert.equal(await row.evaluate((element) => element.isConnected), true);
    } catch (error) {
      await harness.captureFailure(page, `handoff-${width}-${base}`, error);
      throw error;
    } finally {
      await harness.closeProof(proof);
      await context.close();
    }
  });
}
