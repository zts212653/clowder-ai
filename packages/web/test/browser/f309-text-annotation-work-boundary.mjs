import assert from 'node:assert/strict';
import path from 'node:path';
import { collapseV2Workspace } from './f307-workspace-open.mjs';

async function readDraft(page, threadId) {
  return page.evaluate((id) => {
    const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
    return new Map(drafts).get(id) ?? [];
  }, threadId);
}

async function selectOriginalWords(page, messageId, start, end, comment) {
  const original = page
    .locator('[data-message-id="' + messageId + '"]')
    .getByText('原作品，等你一起改。', { exact: true });
  // A real next selection starts with a pointer gesture, which retires the composer's deferred focus restore.
  await original.click();
  await page.evaluate(
    ({ id, start, end }) => {
      const message = document.querySelector('[data-message-id="' + id + '"]');
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf('原作品，等你一起改。');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at + start);
        range.setEnd(node, at + end);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('original publication words missing');
    },
    { id: messageId, start, end },
  );
  await page.getByTestId('message-selection-add-to-chat').click();
  await page.getByTestId('context-annotation-comment').fill(comment);
  await page.getByTestId('context-annotation-save').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '消息输入框');
  await original.click();
}

async function noTextBadgesOnWork(page, work) {
  const bounds = await work.boundingBox();
  assert.ok(bounds);
  for (const mark of await page.locator('[data-testid^="context-annotation-marker-"]:visible').all()) {
    const box = await mark.boundingBox();
    if (!box) continue;
    const overlap =
      Math.max(0, Math.min(box.x + box.width, bounds.x + bounds.width) - Math.max(box.x, bounds.x)) *
      Math.max(0, Math.min(box.y + box.height, bounds.y + bounds.height) - Math.max(box.y, bounds.y));
    assert.equal(overlap, 0, 'a text quote badge crossed into the work');
  }
}

async function waitForDecodedImage(page, rootSelector) {
  const selector = rootSelector + ' [data-testid="workspace-content-review-media"]';
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector);
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  }, selector);
  await page
    .locator(selector)
    .filter({ visible: true })
    .evaluate(async (image) => {
      await image.decode();
      await new Promise(requestAnimationFrame);
    });
}

/** Extends the existing native PNG/WebP journeys: real quote UI, original composer and original media owner. */
export async function verifyTextAnnotationWorkBoundary(page, fixture, evidence, width) {
  const panel = page.getByTestId('workspace-panel-toggle');
  if ((await panel.getAttribute('aria-label')) === '收起 Workspace') await collapseV2Workspace(page);
  const source = page.locator('[data-message-id="' + fixture.publication.id + '"]');
  await source.scrollIntoViewIfNeeded();
  const composer = page.getByLabel('消息输入框', { exact: true });
  const originalComposer = await composer.elementHandle();
  const draftText = await composer.inputValue();
  await selectOriginalWords(page, fixture.publication.id, 0, 3, '保留原文字批注一');
  await selectOriginalWords(page, fixture.publication.id, 4, 9, '保留原文字批注二');
  const quotes = (await readDraft(page, fixture.owner.thread.id)).filter((item) => item.kind === 'quote');
  assert.equal(quotes.length, 2);
  await source.scrollIntoViewIfNeeded();
  const textMarks = page.locator('[data-testid^="context-annotation-marker-"]');
  await textMarks.nth(1).waitFor();
  assert.equal(await textMarks.filter({ visible: true }).count(), 2);
  await page.screenshot({ path: path.join(evidence, 'text-quotes-original.png') });

  await source.getByRole('button', { name: /打开作品/ }).click();
  const dialog = page.getByRole('dialog');
  const surface = dialog.getByTestId('workspace-content-review-surface');
  await surface.getByTestId('workspace-content-review-media').waitFor();
  await waitForDecodedImage(page, '[role="dialog"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid^="context-annotation-marker-"]'));
  await dialog.getByRole('button', { name: '圈选', exact: true }).click();
  const stage = await surface.getByTestId('review-media-stage').boundingBox();
  assert.ok(stage);
  await page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5, { steps: 6 });
  await page.mouse.up();
  assert.equal(await surface.getByTestId('review-pending-chat-mark').count(), 1);
  await noTextBadgesOnWork(page, dialog);
  const selected = (await readDraft(page, fixture.owner.thread.id)).find((item) => item.kind === 'media');
  assert.equal(selected.selections.length, 1);
  await page.screenshot({ path: path.join(evidence, 'text-quotes-floating.png') });

  await page.getByTestId('lightbox-open-workspace').click();
  const host = page.getByTestId('contextual-workspace-host');
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation') ===
      expected,
    width >= 768 ? 'artwork-work-mode' : 'narrow-work-composer',
  );
  await host.getByTestId('workspace-content-review-media').filter({ visible: true }).waitFor();
  await waitForDecodedImage(page, '[data-testid="contextual-workspace-host"]');
  await noTextBadgesOnWork(page, host);
  assert.equal(await composer.evaluate((node, original) => node === original, originalComposer), true);
  assert.equal(await host.getByTestId('review-pending-chat-mark').filter({ visible: true }).count(), 1);

  if (width >= 768) {
    const toggleFullWindow = async () => {
      await page.getByTestId('v2-workspace-chrome').getByLabel('更多 Workspace 操作', { exact: true }).click();
      await page
        .getByRole('menu', { name: '更多 Workspace 操作', exact: true })
        .getByRole('menuitemcheckbox', { name: '整窗', exact: true })
        .click();
    };
    await toggleFullWindow();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation') ===
        'artifact-full-window',
    );
    await noTextBadgesOnWork(page, host);
    await waitForDecodedImage(page, '[data-testid="contextual-workspace-host"]');
    assert.equal(await textMarks.filter({ visible: true }).count(), 0);
    assert.equal(await composer.evaluate((node, original) => node === original, originalComposer), true);
    assert.equal(await host.getByTestId('review-pending-chat-mark').filter({ visible: true }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'text-quotes-full-window.png') });
    await toggleFullWindow();
  }
  if (width >= 768) await page.getByTestId('artwork-work-mode-return').click();
  else await host.getByRole('button', { name: '‹ 聊天', exact: true }).click();
  await source.scrollIntoViewIfNeeded();
  await textMarks.first().waitFor();
  assert.equal(await textMarks.filter({ visible: true }).count(), 2);
  assert.equal(await composer.inputValue(), draftText);
  assert.equal(await composer.evaluate((node, original) => node === original, originalComposer), true);
  assert.deepEqual(
    (await readDraft(page, fixture.owner.thread.id)).filter((item) => item.kind === 'quote'),
    quotes,
  );
  assert.deepEqual(
    (await readDraft(page, fixture.owner.thread.id)).find((item) => item.kind === 'media'),
    selected,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  await source.scrollIntoViewIfNeeded();
  await textMarks.first().waitFor();
  assert.equal(await textMarks.filter({ visible: true }).count(), 2);
  assert.equal(await composer.inputValue(), draftText);
  assert.deepEqual(
    (await readDraft(page, fixture.owner.thread.id)).filter((item) => item.kind === 'quote'),
    quotes,
  );
  assert.deepEqual(
    (await readDraft(page, fixture.owner.thread.id)).find((item) => item.kind === 'media'),
    selected,
  );
  await page.screenshot({ path: path.join(evidence, 'text-quotes-restored.png') });
  await page.locator('[data-chat-container]').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid^="context-annotation-marker-"]'));
  assert.deepEqual(
    (await readDraft(page, fixture.owner.thread.id)).filter((item) => item.kind === 'quote'),
    quotes,
  );
  return {
    quoteIds: quotes.map((item) => item.id),
    mediaSelectionId: selected.selections[0].id,
    width,
    restored: true,
  };
}
