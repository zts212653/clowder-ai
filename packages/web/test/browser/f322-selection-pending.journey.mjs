import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  beginNativeReadingGesture,
  finishScrollProbeTrace,
  startScrollProbeTrace,
} from './f322-native-scroll-probe-state.mjs';

const triggerId = 'message-selection-add-to-chat';

async function selectAnswer(page, row) {
  const text = row.locator('[data-reply-output-kind="answer"] strong').first();
  await text.scrollIntoViewIfNeeded();
  await text.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByTestId(triggerId).waitFor({ state: 'visible' });
  return text;
}

/** Real Next row, real ResizeObserver/rAF ordering; only the neighboring content is controlled. */
export async function verifySelectionDuringPeerGrowth({ page, row }, out) {
  await row.evaluate((node) => {
    const column = node.closest('[data-thread-chat-reading-column]');
    const before = document.createElement('div');
    before.style.height = '1000px';
    column.prepend(before);
    const peer = document.createElement('div');
    peer.dataset.selectionPeer = '';
    peer.dataset.actionScrollProbe = 'after';
    peer.style.minHeight = '1200px';
    column.append(peer);
  });
  await startScrollProbeTrace(row);
  await beginNativeReadingGesture(page, row);
  const text = await selectAnswer(page, row);
  await text.evaluate((node) => {
    node.dataset.selectionProbeSource = '';
  });
  const frames = await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const peer = document.querySelector('[data-selection-peer]');
        const source = document.querySelector('[data-selection-probe-source]');
        const samples = [];
        window.selectionPeerTimer = setInterval(() => {
          const line = document.createElement('p');
          line.textContent = 'A neighboring message continues to grow.';
          peer.append(line);
          // Force actual column growth even before the first 1200px have filled.
          peer.style.minHeight = `${1200 + peer.childElementCount * 24}px`;
        }, 30);
        const sample = () => {
          const trigger = document.querySelector(`[data-testid="${id}"]`);
          samples.push({
            source: source.getBoundingClientRect().toJSON(),
            visible: Boolean(trigger && getComputedStyle(trigger).visibility === 'visible'),
            inert: Boolean(trigger?.inert),
          });
          if (samples.length < 120) requestAnimationFrame(sample);
          else resolve(samples);
        };
        requestAnimationFrame(sample);
      }),
    triggerId,
  );
  try {
    if (out) await writeFile(path.join(out, 'selection-peer-frames.json'), JSON.stringify(frames, null, 2));
    assert.deepEqual(
      frames.map(({ source }) => source),
      frames.map(() => frames[0].source),
      'the selected source must stay fixed while its neighboring message grows',
    );
    assert.equal(
      frames.filter(({ visible, inert }) => !visible || inert).length,
      0,
      'a readable selection must not disappear or become inert during toolbar remeasurement',
    );
    await page.getByTestId(triggerId).click();
    const editor = page.getByTestId('context-annotation-editor');
    const comment = editor.getByTestId('context-annotation-comment');
    await comment.fill('Keep this draft through incoming updates.');
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await row.evaluate((node) => {
      node.closest('[data-thread-chat-reading-column]').setAttribute('hidden', '');
    });
    assert.equal(await comment.inputValue(), 'Keep this draft through incoming updates.');
    assert(await comment.isVisible(), 'an opened draft retains its own visibility');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'hidden' });
  } finally {
    await page.evaluate(() => {
      clearInterval(window.selectionPeerTimer);
      document.querySelector('[data-thread-chat-reading-column]').removeAttribute('hidden');
    });
    await finishScrollProbeTrace(page, out, 'selection-peer-growth');
  }

  // Real source loss still revokes a fresh trigger, independently of toolbar geometry.
  for (const attribute of ['hidden', 'inert', 'aria-hidden']) {
    await selectAnswer(page, row);
    await row.evaluate((node, name) => {
      node.closest('[data-thread-chat-reading-column]').setAttribute(name, name === 'aria-hidden' ? 'true' : '');
    }, attribute);
    await page.waitForFunction((id) => {
      const trigger = document.querySelector(`[data-testid="${id}"]`);
      return !trigger || trigger.inert || getComputedStyle(trigger).visibility === 'hidden';
    }, triggerId);
    await row.evaluate((node, name) => {
      node.closest('[data-thread-chat-reading-column]').removeAttribute(name);
    }, attribute);
  }
  await selectAnswer(page, row);
  await row.evaluate((node) => {
    const port = node.closest('[data-chat-container]');
    port.scrollTop = port.scrollHeight;
  });
  await page.getByTestId(triggerId).waitFor({ state: 'hidden' });
  await selectAnswer(page, row);
  await page.evaluate(() => {
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByTestId(triggerId).waitFor({ state: 'hidden' });
  if (out) await page.screenshot({ path: path.join(out, 'selection-peer-complete.png') });
}
