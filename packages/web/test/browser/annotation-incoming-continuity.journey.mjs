import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD } from './fixtures/f322-chat-real-page-data.mjs';

// Actual ThreadChatSurface, history, message rows, action owner and composer.
// HTTP/socket inputs are controlled; no runtime service or Redis writes.
export async function runAnnotationIncomingContinuity(browser, built, evidenceDir) {
  const out = process.env.ANNOTATION_CONTINUITY_EVIDENCE_DIR ?? evidenceDir;
  if (out) await mkdir(out, { recursive: true });
  const context = await browser.newContext(
    out ? { recordVideo: { dir: out, size: { width: 1440, height: 900 } } } : {},
  );
  const harness = createChatProofHarness(context, built, out, []);
  const proof = await harness.openProof({ surface: true, sidebar: true });
  const { page } = proof;
  try {
    const paragraph = page.locator('[data-message-id="reading-cat"] p').filter({ hasText: '第7段' }).last();
    await paragraph.scrollIntoViewIfNeeded();
    const selected = await paragraph.evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(text.length, 30));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return range.toString();
    });
    await page.getByTestId('message-selection-add-to-chat').click();
    const editor = page.getByTestId('context-annotation-editor');
    const textarea = editor.getByTestId('context-annotation-comment');
    await textarea.fill('批注开头：');
    await editor.evaluate((node) => {
      window.__annotationNode = node;
      window.__annotationFrameFailures = [];
      window.__annotationProbeRunning = true;
      const observe = () => {
        if (!window.__annotationProbeRunning) return;
        const field = node.querySelector('textarea');
        if (
          !node.isConnected ||
          node.hasAttribute('inert') ||
          node.getAttribute('aria-hidden') === 'true' ||
          document.activeElement !== field
        )
          window.__annotationFrameFailures.push({
            time: performance.now(),
            connected: node.isConnected,
            inert: node.hasAttribute('inert'),
            focused: document.activeElement === field,
          });
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    });
    const observations = [];
    for (let index = 1; index <= 4; index++) {
      await page.evaluate(
        ({ threadId, index }) => {
          window.__f322Chat.incoming(threadId, {
            from: { kind: 'agent', catId: 'codex61-sol' },
            id: `incoming-${index}`,
            type: 'assistant',
            catId: 'codex61-sol',
            timestamp: Date.now(),
            content: `新消息 ${index}：` + '这是写批注期间到来的另一条消息。'.repeat(40),
          });
        },
        { threadId: index === 3 ? 'composer-proof-1' : CURRENT_THREAD, index },
      );
      await textarea.pressSequentially(`消息${index}到来后继续写。`, { delay: 65 });
      await page.waitForTimeout(650);
      assert.equal(await editor.locator('blockquote').innerText(), selected);
      observations.push(
        await editor.evaluate((node) => ({
          sameEditor: node === window.__annotationNode,
          text: node.querySelector('textarea').value,
          focused: node.querySelector('textarea') === document.activeElement,
          sourceBottom: document.querySelector('[data-message-id="reading-cat"]').getBoundingClientRect().bottom,
          portTop: document.querySelector('[data-chat-container]').getBoundingClientRect().top,
        })),
      );
      if (out) await page.screenshot({ path: path.join(out, `incoming-${index}.png`) });
    }
    await page.evaluate(() => {
      window.__annotationProbeRunning = false;
    });
    const failures = await page.evaluate(() => window.__annotationFrameFailures);
    assert.deepEqual(failures, [], 'every animation frame preserves an available, focused editor');
    assert(observations.every((row) => row.sameEditor && row.focused));
    assert(
      observations.some((row) => row.sourceBottom < row.portTop),
      'incoming messages actually clip the source',
    );
    assert.equal(
      await textarea.inputValue(),
      '批注开头：消息1到来后继续写。消息2到来后继续写。消息3到来后继续写。消息4到来后继续写。',
    );
    if (out)
      await writeFile(
        path.join(out, 'observations.json'),
        JSON.stringify({ selected, observations, failures }, null, 2),
      );
    await editor.getByTestId('context-annotation-save').click();
    await editor.waitFor({ state: 'hidden' });
    await page.getByTestId('context-annotations-summary').waitFor();
    assert.equal(await page.getByTestId('context-annotations-summary').innerText(), '1 annotation');

    await paragraph.scrollIntoViewIfNeeded();
    const marker = page.locator('[data-testid^="context-annotation-marker-"]').first();
    await marker.click();
    const reopened = await textarea.elementHandle();
    await textarea.fill('重新编辑已有批注：');
    const port = page.locator('[data-chat-container]');
    const bounds = await port.boundingBox();
    await page.mouse.move(bounds.x + 50, bounds.y + 50);
    await page.mouse.wheel(0, 4000);
    await page.evaluate(
      (threadId) =>
        window.__f322Chat.incoming(threadId, {
          from: { kind: 'agent', catId: 'codex61-sol' },
          id: 'incoming-reopened',
          type: 'assistant',
          catId: 'codex61-sol',
          timestamp: Date.now(),
          content: '编辑已有批注时再进一条消息。'.repeat(40),
        }),
      CURRENT_THREAD,
    );
    await textarea.pressSequentially('原文离屏后继续写。', { delay: 65 });
    assert.equal(await reopened.evaluate((node) => node.isConnected && node === document.activeElement), true);
    assert.equal(await editor.locator('blockquote').innerText(), selected);
    assert.equal(await textarea.inputValue(), '重新编辑已有批注：原文离屏后继续写。');
    if (out) await page.screenshot({ path: path.join(out, 'reopened-marker-offscreen.png') });
    await editor.getByTestId('context-annotation-save').click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('context-annotations-summary').innerText(), '1 annotation');
  } finally {
    await harness.closeProof(proof);
    await context.close();
  }
}

// Focused invocation reuses the normal resource-admitted browser runner.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildChatProof();
  const browser = await chromium.launch({ headless: true });
  try {
    await runAnnotationIncomingContinuity(browser, built);
  } finally {
    await browser.close();
  }
}
