import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startFlickerFrames } from './f322-chat-flicker-frames.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';

export async function runChatFlicker(browser, built, evidenceDir) {
  const out = process.env.F322_FLICKER_EVIDENCE ?? evidenceDir;
  mkdirSync(out, { recursive: true });
  const context = await browser.newContext({ recordVideo: { dir: out, size: { width: 700, height: 900 } } });
  const failures = [];
  try {
    const harness = createChatProofHarness(context, built, out, [], (api) => {
      const respond = api.respond;
      api.respond = (request, url) => {
        const result = respond(request, url);
        if (url.pathname === '/api/messages' && request.method() === 'GET') {
          const body = JSON.parse(result.body);
          const firstTime = Math.min(...body.messages.map((message) => message.timestamp));
          body.messages.unshift(
            ...Array.from({ length: 60 }, (_, index) => ({
              id: `flicker-history-${index}`,
              from: { kind: 'user', userId: 'owner-proof' },
              timestamp: firstTime - (60 - index) * 1000,
              content: `第 ${index + 1} 条历史。${'快速滚动时保留原来的阅读位置。'.repeat(2 + (index % 10))}`,
            })),
          );
          return { ...result, body: JSON.stringify(body) };
        }
        return url.pathname.endsWith('/artifacts')
          ? {
              ...result,
              body: JSON.stringify({ view: 'works', artifacts: [], total: 1, complete: true, workLineage: 'resolved' }),
            }
          : result;
      };
    });
    const proof = await harness.openProof({ width: 390, sidebar: false, surface: true });
    const { page } = proof;
    await page.getByTestId('header-works').filter({ hasText: '1' }).waitFor();
    await page.locator('textarea').fill('开始');
    await page.waitForTimeout(500);
    await startFlickerFrames(page);
    // The same scope's successful count must survive every painted frame of a slow background read.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/artifacts?view=works', async (route) => {
      await gate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ view: 'works', artifacts: [], total: 2, complete: true, workLineage: 'resolved' }),
      });
    });
    await page.evaluate(() => {
      window.__flicker.phase = 'count-refresh';
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    await page.waitForTimeout(250);
    release();
    await page.getByTestId('header-works').filter({ hasText: '2' }).waitFor();
    let releaseImage;
    const imageGate = new Promise((resolve) => {
      releaseImage = resolve;
    });
    await page.route('**/late-flicker-image.svg', async (route) => {
      await imageGate;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480"><rect width="320" height="480" fill="#eeeeee"/></svg>',
      });
    });
    const imageRequest = page.waitForRequest('**/late-flicker-image.svg');
    await page.evaluate(() =>
      window.__f322Chat.incoming(window.__f322Chat.selectedThread(), {
        id: 'late-flicker-media',
        from: { kind: 'user', userId: 'owner-proof' },
        type: 'user',
        content: '底部图片晚到',
        timestamp: Date.now(),
        contentBlocks: [{ type: 'image', url: '/late-flicker-image.svg' }],
      }),
    );
    await imageRequest;
    const port = page.locator('[data-chat-container]');
    const box = await port.boundingBox();
    await page.mouse.move(box.x + 70, box.y + 100);
    await page.mouse.wheel(0, -10000);
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      window.__flicker.phase = 'rapid-bottom';
    });
    await page.mouse.wheel(0, 100000);
    releaseImage();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      window.__flicker.phase = 'typing';
    });
    await page.locator('textarea').click();
    await page.keyboard.type(
      '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
      { delay: 12 },
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, 'typing.png') });
    await page.evaluate(() => {
      window.__flicker.phase = 'reading-position';
    });
    await page.mouse.move(box.x + 60, box.y + 100);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__flicker.phase = 'reading-typing';
      window.__flicker.readingTop = document.querySelector('[data-chat-container]').scrollTop;
    });
    await page.locator('textarea').fill('读到一半时输入，也不能移动我正在读的内容。'.repeat(4));
    await page.waitForTimeout(300);
    const trace = await page.evaluate(() => {
      cancelAnimationFrame(window.__flicker.raf);
      window.__flicker.observer.disconnect();
      delete window.__flicker.observer;
      return window.__flicker;
    });
    writeFileSync(path.join(out, 'frames.json'), JSON.stringify(trace, null, 2));
    const count = trace.frames.filter((f) => f.phase === 'count-refresh');
    if (count.some((f) => !/作品[12]/.test(f.works.replaceAll(' ', ''))))
      failures.push('confirmed Works count disappears during background refresh');
    const painted = trace.frames.map((frame) => ({
      ...frame,
      ...trace.layouts.filter((layout) => layout.frame === frame.frame).at(-1),
    }));
    const typing = painted.filter((f) => f.phase === 'typing');
    if (typing.some((f) => f.gap > 2))
      failures.push(
        `composer resize leaves bottom across frames: ${typing
          .filter((f) => f.gap > 2)
          .slice(0, 8)
          .map((f) => `${f.frame}:${f.gap}`)
          .join(', ')}`,
      );
    const bottom = painted.filter((f) => f.phase === 'rapid-bottom');
    const firstBottom = bottom.findIndex((f) => f.gap <= 2);
    if (firstBottom < 0 || bottom.slice(firstBottom).some((f) => f.gap > 2))
      failures.push('rapid scroll rebounds after reaching bottom');
    const reading = painted.filter((f) => f.phase === 'reading-typing');
    if (reading.some((f) => Math.abs(f.top - trace.readingTop) > 1)) failures.push('typing moves the offset reader');
    console.log(JSON.stringify({ out, failures, frames: trace.frames.length, writes: trace.writes.length }));
    await harness.closeProof(proof);
  } finally {
    await context.close();
  }
  assert.deepEqual(failures, []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildChatProof();
  const browser = await chromium.launch({ headless: true });
  try {
    await runChatFlicker(browser, built, path.join(os.tmpdir(), `f322-flicker-${process.pid}`));
  } finally {
    await browser.close();
  }
}
