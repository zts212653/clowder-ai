import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD } from './fixtures/f322-chat-real-page-data.mjs';

describe('reply navigation owner', () => {
  // A real receipt inside ThreadChatSurface must hand navigation to its reading
  // owner. Component-only click tests cannot observe native scroll/reflow races.
  const evidence = process.env.REPLY_NAVIGATION_EVIDENCE_DIR;
  let browser, context, harness;
  const samples = [];
  let longReply = false;
  let pagedHistory = false;
  const catId = 'codex-astra';
  const now = Date.now();
  const responseId = 'lineage-response';
  const appendedId = 'lineage-appended';
  const messages = [
    {
      id: 'lineage-original',
      catId: null,
      from: { kind: 'user', userId: 'owner-proof' },
      type: 'user',
      content: '请看这条回复。',
      timestamp: now - 20000,
    },
    {
      id: responseId,
      type: 'assistant',
      catId,
      from: { kind: 'agent', catId },
      content: '这是应该停留的回复。\n\n点击后仍然可以从这里继续阅读。',
      timestamp: now - 19000,
      lifecycle: {
        kind: 'response',
        orderKey: `${now - 19000}:${responseId}`,
        invocationId: 'lineage-inv',
        targetId: catId,
        inputEntryIds: ['first-entry', 'append-entry'],
        inputMessageIds: ['lineage-original', appendedId],
        status: 'completed',
        startedAt: now - 19000,
        completedAt: now - 500,
      },
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `lineage-between-${index}`,
      catId: null,
      from: { kind: 'user', userId: 'owner-proof' },
      type: 'user',
      content: `中间消息 ${index}：${'继续讨论和阅读。'.repeat(30)}`,
      timestamp: now - 18000 + index,
    })),
    {
      id: appendedId,
      catId: null,
      from: { kind: 'user', userId: 'owner-proof' },
      type: 'user',
      content: '这条后来补进同一轮，点击下面的看回复。',
      timestamp: now - 1000,
      lifecycle: {
        kind: 'input',
        orderKey: `${now - 1000}:${appendedId}`,
        dispatchRefs: [
          {
            targetId: catId,
            phase: 'settled',
            statusMessageId: responseId,
            dispatchedAt: now - 900,
            appendAcceptance: 'accepted',
            inputRead: { status: 'read', at: now - 800 },
          },
        ],
      },
    },
  ];

  before(async () => {
    if (evidence) mkdirSync(evidence, { recursive: true });
    const built = await buildChatProof();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    harness = createChatProofHarness(context, built, evidence, samples, (api) => {
      const respond = api.respond;
      api.respond = (request, url) => {
        if (url.pathname === '/api/messages') {
          const allMessages = messages.map((message) =>
            longReply && message.id === responseId
              ? {
                  ...message,
                  content: Array.from(
                    { length: 8 },
                    (_, i) =>
                      `第 ${i + 1} 段：${'定位到回复开头后继续阅读，前面的消息完成排版也不应卷走标题。'.repeat(4)}`,
                  ).join('\n\n'),
                }
              : message,
          );
          if (pagedHistory && !url.searchParams.get('before')) {
            return {
              contentType: 'application/json',
              body: JSON.stringify({
                messages: allMessages.slice(2),
                hasMore: true,
              }),
            };
          }
          if (pagedHistory && url.searchParams.get('before')) {
            return {
              contentType: 'application/json',
              body: JSON.stringify({
                messages: allMessages.slice(0, 2),
                hasMore: false,
              }),
            };
          }
          return {
            contentType: 'application/json',
            body: JSON.stringify({
              messages: allMessages,
              hasMore: false,
            }),
          };
        }
        return respond(request, url);
      };
    });
  });
  after(async () => {
    await browser?.close();
    if (evidence) writeFileSync(path.join(evidence, 'samples.json'), JSON.stringify(samples, null, 2));
  });

  function measure() {
    const chat = document.querySelector('[data-chat-container]');
    const target = chat.querySelector('[data-message-id="lineage-response"]');
    const viewport = chat.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return {
      top: chat.scrollTop,
      max: chat.scrollHeight - chat.clientHeight,
      offset: rect.top - viewport.top,
      visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
      saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:composer-proof-0') ?? '{}').state,
    };
  }

  for (const [shell, width, tall = false, earlierReflow = false] of [
    ['v2', 1440],
    ['v2', 390],
    ['classic', 1440],
    ['classic', 390],
    ['v2', 1440, true],
    ['classic', 390, true],
    ['v2', 1440, false, true],
    ['classic', 390, false, true],
  ]) {
    test(
      `${shell} ${width}${tall ? ' tall' : ''}${earlierReflow ? ' earlier-reflow' : ''}: a late input receipt keeps its reply visible through passive updates`,
      { timeout: 60000 },
      async () => {
        longReply = tall;
        pagedHistory = false;
        const proof = await harness.openProof({ surface: true, sidebar: false, width });
        const { page } = proof;
        try {
          if (shell === 'classic') await page.evaluate(() => window.__f322Chat.presentation('classic'));
          if (earlierReflow) {
            await page.evaluate(() => {
              const earlier = document.querySelector('[data-message-viewport-id="lineage-original"]');
              earlier.style.height = '400px';
              earlier.style.overflow = 'hidden';
              const nativeScroll = Element.prototype.scrollIntoView;
              Element.prototype.scrollIntoView = function (...args) {
                nativeScroll.apply(this, args);
                if (this.getAttribute('data-message-id') === 'lineage-response') {
                  // Model an earlier placeholder finishing layout after native
                  // alignment. Keep the production navigation/settlement intact.
                  earlier.style.height = '1px';
                  Element.prototype.scrollIntoView = nativeScroll;
                }
              };
            });
          }
          const button = page
            .locator(`[data-message-viewport-id="${appendedId}"]`)
            .getByRole('button', { name: /看.*的回复/ });
          assert.match(await button.innerText(), /看回复 ↑/, 'appended message below an earlier reply points ↑');
          await button.click();
          await page.waitForFunction(() =>
            document.querySelector('[data-message-id="lineage-response"]')?.hasAttribute('data-message-jump-focus'),
          );
          await page.getByRole('button', { name: '回到刚才', exact: true }).waitFor();
          await page.waitForTimeout(1200); // Includes native smooth completion and passive ResizeObserver correction.
          const arrived = await page.evaluate(measure);
          samples.push({ shell, width, tall, earlierReflow, phase: 'arrived', ...arrived });
          assert.equal(arrived.visible, true, 'the reply must remain visible after the click settles');
          assert.ok(arrived.offset >= -1, 'every reply must retain its author/header after earlier rows settle');
          if (tall)
            assert.ok(Math.abs(arrived.offset) <= 1, 'a tall reply must land at its header after earlier rows settle');
          assert.equal(arrived.saved?.anchor, 'offset', 'the jump must replace bottom-follow intent');
          assert.equal(
            arrived.saved?.messageAnchor?.messageId,
            responseId,
            'the reading owner must remember the exact reply',
          );
          await page.evaluate(
            ({ threadId, now }) =>
              window.__f322Chat.incoming(threadId, {
                id: 'lineage-new-arrival',
                type: 'user',
                from: { kind: 'user', userId: 'owner-proof' },
                content: '定位后又到一条消息。'.repeat(30),
                timestamp: now,
              }),
            { threadId: CURRENT_THREAD, now },
          );
          await page.waitForTimeout(500);
          const updated = await page.evaluate(measure);
          samples.push({ shell, width, tall, earlierReflow, phase: 'updated', ...updated });
          assert.equal(updated.visible, true);
          assert.ok(
            Math.abs(updated.offset - arrived.offset) <= 1,
            'new content must not move the reply reading anchor',
          );
          if (evidence)
            await page.screenshot({
              path: path.join(
                evidence,
                `${shell}-${width}${tall ? '-tall' : ''}${earlierReflow ? '-earlier-reflow' : ''}-reply-stays-visible.png`,
              ),
            });
          await page
            .locator(`[data-appended-input-id="${appendedId}"]`)
            .getByRole('button', { name: '跳到原文', exact: true })
            .click();
          await page.waitForFunction((messageId) => {
            const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:composer-proof-0') ?? '{}').state;
            return saved?.anchor === 'offset' && saved.messageAnchor?.messageId === messageId;
          }, appendedId);
          await button.click();
          await page.waitForFunction(
            (messageId) =>
              JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:composer-proof-0') ?? '{}').state?.messageAnchor
                ?.messageId === messageId,
            responseId,
          );
          await page.getByRole('button', { name: '到最新', exact: true }).click();
          await page.waitForFunction(() => {
            const chat = document.querySelector('[data-chat-container]');
            const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:composer-proof-0') ?? '{}').state;
            return (
              saved?.anchor === 'bottom' && Math.abs(chat.scrollTop - (chat.scrollHeight - chat.clientHeight)) <= 1
            );
          });
          assert.equal(proof.api.sent.length, 0);
        } catch (error) {
          if (evidence)
            await harness.captureFailure(page, `${shell}-${width}${tall ? '-tall' : ''}-reply-navigation`, error);
          throw error;
        } finally {
          await harness.closeProof(proof);
        }
      },
    );
  }

  // The jump session is browser-local and restored on load, so a neighbouring case that ended with its bar up leaves it
  // on the next page. Dismiss it with the reader's own close control.
  async function clearLeftoverReturnBar(page) {
    const returnBtn = page.getByRole('button', { name: '回到刚才', exact: true });
    if ((await returnBtn.count()) === 0) return;
    await page.getByRole('button', { name: '关闭返回条', exact: true }).click();
    await returnBtn.waitFor({ state: 'detached', timeout: 3000 });
  }

  // You 2026-11-11 (clowder-ai#1920 thread, screenshot with arrow): the whole
  // strip under the header was dead — the return bar reserved a full-width row
  // and cut the reading column by ~56-76px for as long as it stayed. After an
  // in-thread jump the bar must float over the reading column's top edge and
  // leave the reading column exactly as tall as before.
  for (const [shell, width] of [
    ['v2', 1440],
    ['v2', 390],
    ['classic', 1440],
    ['classic', 390],
  ]) {
    test(
      `${shell} ${width}: the 回到刚才 bar floats over the reading column and never reserves a strip`,
      { timeout: 60000 },
      async () => {
        longReply = false;
        pagedHistory = false;
        const proof = await harness.openProof({ surface: true, sidebar: false, width });
        const { page } = proof;
        try {
          if (shell === 'classic') await page.evaluate(() => window.__f322Chat.presentation('classic'));
          const readingBox = () =>
            page.evaluate(() => {
              const rect = document.querySelector('[data-chat-container]').getBoundingClientRect();
              return { top: rect.top, height: rect.height };
            });
          const returnBtn = page.getByRole('button', { name: '回到刚才', exact: true });
          await clearLeftoverReturnBar(page);
          assert.equal(await returnBtn.count(), 0, 'precondition: no return bar before the jump');
          const before = await readingBox();
          await page
            .locator(`[data-message-viewport-id="${appendedId}"]`)
            .getByRole('button', { name: /看.*的回复/ })
            .click();
          await returnBtn.waitFor();
          await page.waitForTimeout(800);
          const during = await readingBox();
          assert.ok(
            Math.abs(during.top - before.top) <= 1 && Math.abs(during.height - before.height) <= 1,
            `the bar must not take reading space (before ${JSON.stringify(before)}, during ${JSON.stringify(during)})`,
          );
          const box = await returnBtn.boundingBox();
          assert.ok(
            box.y >= during.top - 1 && box.y + box.height <= during.top + 64,
            `the bar floats over the reading column's top edge (button y=${box.y}, h=${box.height}, column top=${during.top})`,
          );
          assert.ok(
            width - (box.x + box.width) >= 30,
            `the bar clears the right-edge message navigator rail (${width - (box.x + box.width)}px from the edge)`,
          );
          if (evidence)
            await page.screenshot({ path: path.join(evidence, `${shell}-${width}-return-bar-floating.png`) });
          await returnBtn.click();
          await page.waitForFunction(
            () => !Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === '回到刚才'),
          );
          const after = await readingBox();
          assert.ok(
            Math.abs(after.top - before.top) <= 1 && Math.abs(after.height - before.height) <= 1,
            `dismissing the bar must not resize the reading column either (${JSON.stringify(after)})`,
          );
        } catch (error) {
          if (evidence) await harness.captureFailure(page, `${shell}-${width}-return-bar-floating`, error);
          throw error;
        } finally {
          // The jump session is browser-local and survives reload; a failed run must not leak it into the next page.
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
          await harness.closeProof(proof);
        }
      },
    );
  }

  // The bar stays until used. A bar whose return point is gone (restored as 定位已中断 / 暂不可用) used to be a dead end:
  // 回到刚才 could not dismiss it. The reader can now say "I do not need to go back".
  for (const [shell, width] of [
    ['v2', 1440],
    ['classic', 390],
  ]) {
    test(
      `${shell} ${width}: the close control dismisses the return bar without moving the reader, and a reload does not bring it back`,
      { timeout: 60000 },
      async () => {
        longReply = false;
        pagedHistory = false;
        const proof = await harness.openProof({ surface: true, sidebar: false, width });
        const { page } = proof;
        try {
          if (shell === 'classic') await page.evaluate(() => window.__f322Chat.presentation('classic'));
          await clearLeftoverReturnBar(page);
          const returnBtn = page.getByRole('button', { name: '回到刚才', exact: true });
          await page
            .locator(`[data-message-viewport-id="${appendedId}"]`)
            .getByRole('button', { name: /看.*的回复/ })
            .click();
          await returnBtn.waitFor();
          await page.waitForTimeout(800);
          const scrollTop = () => page.evaluate(() => document.querySelector('[data-chat-container]').scrollTop);
          const atReply = await scrollTop();
          await page.getByRole('button', { name: '关闭返回条', exact: true }).click();
          await returnBtn.waitFor({ state: 'detached', timeout: 3000 });
          await page.waitForTimeout(400);
          assert.ok(
            Math.abs((await scrollTop()) - atReply) <= 1,
            'closing the bar must leave the reader where they are, not carry them back',
          );
          await page.reload();
          await page.waitForSelector('[data-chat-container]');
          await page.waitForTimeout(800);
          assert.equal(await returnBtn.count(), 0, 'a dismissed return bar must not be restored by a reload');
          assert.equal(proof.api.sent.length, 0);
        } catch (error) {
          if (evidence) await harness.captureFailure(page, `${shell}-${width}-return-bar-dismiss`, error);
          throw error;
        } finally {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
          await harness.closeProof(proof);
        }
      },
    );
  }

  for (const shell of ['v2', 'classic']) {
    test(
      `${shell}: cross-page unloaded reply loads on 看回复 ↑, lands at top with ring, and 回到刚才 restores origin`,
      { timeout: 60000 },
      async () => {
        longReply = true;
        pagedHistory = true;
        const proof = await harness.openProof({ surface: true, sidebar: false, width: 1280 });
        const { page } = proof;
        try {
          if (shell === 'classic') await page.evaluate(() => window.__f322Chat.presentation('classic'));
          assert.equal(await page.locator(`[data-message-id="${responseId}"]`).count(), 0);
          const departure = await page.evaluate(() => {
            const chat = document.querySelector('[data-chat-container]');
            const appended = chat.querySelector('[data-message-viewport-id="lineage-appended"]');
            return {
              scrollTop: chat.scrollTop,
              appendedBottomOffset: appended.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom,
            };
          });
          const button = page
            .locator(`[data-message-viewport-id="${appendedId}"]`)
            .getByRole('button', { name: /看.*的回复/ });
          assert.match(await button.innerText(), /看回复 ↑/);
          await button.click();
          await page.waitForFunction(() =>
            document.querySelector('[data-message-id="lineage-response"]')?.hasAttribute('data-message-jump-focus'),
          );
          const returnBtn = page.getByRole('button', { name: '回到刚才', exact: true });
          await returnBtn.waitFor();
          await page.waitForTimeout(800);
          const arrived = await page.evaluate(measure);
          assert.equal(arrived.visible, true);
          assert.ok(Math.abs(arrived.offset) <= 2, `tall paged reply lands at its opening (${arrived.offset}px)`);
          await returnBtn.click();
          await page.waitForFunction(
            () => !Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === '回到刚才'),
          );
          await page.waitForTimeout(400);
          const restored = await page.evaluate(() => {
            const chat = document.querySelector('[data-chat-container]');
            const appended = chat.querySelector('[data-message-viewport-id="lineage-appended"]');
            return {
              visible:
                appended.getBoundingClientRect().bottom > chat.getBoundingClientRect().top &&
                appended.getBoundingClientRect().top < chat.getBoundingClientRect().bottom,
              appendedBottomOffset: appended.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom,
            };
          });
          assert.equal(restored.visible, true, '回到刚才 brings the user back to the departure message');
          assert.ok(
            Math.abs(restored.appendedBottomOffset - departure.appendedBottomOffset) <= 8,
            '回到刚才 restores the departure viewport alignment after older pages prepend above',
          );
        } finally {
          pagedHistory = false;
          await harness.closeProof(proof);
        }
      },
    );
  }
});
