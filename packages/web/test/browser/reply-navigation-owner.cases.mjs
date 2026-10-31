import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
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
      api.respond = (request, url) =>
        url.pathname === '/api/messages'
          ? {
              contentType: 'application/json',
              body: JSON.stringify({
                messages: messages.map((message) =>
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
                ),
                hasMore: false,
              }),
            }
          : respond(request, url);
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
          await button.click();
          await page.waitForFunction(() =>
            document.querySelector('[data-message-id="lineage-response"]')?.hasAttribute('data-message-jump-focus'),
          );
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
});
