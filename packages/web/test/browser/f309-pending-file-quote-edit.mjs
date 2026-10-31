import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';

async function readDraftQuotes(page) {
  return page.evaluate((threadId) => {
    const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
    return drafts.find(([id]) => id === threadId)?.[1] ?? [];
  }, THREAD_ID);
}

async function waitForComments(page, comments) {
  await page.waitForFunction(
    ([threadId, expected]) => {
      const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
      const quotes = drafts.find(([id]) => id === threadId)?.[1] ?? [];
      return JSON.stringify(quotes.map((quote) => quote.comment)) === JSON.stringify(expected);
    },
    [THREAD_ID, comments],
  );
}

async function returnToChat(page, surface, width) {
  await surface.getByRole('button', { name: '返回来源', exact: true }).click();
  await page.getByTestId('workspace-launcher-home').waitFor();
  if (width === 390)
    await page
      .getByTestId('contextual-workspace-host')
      .getByRole('button', { name: /^(收起 Workspace|Collapse Workspace)$/ })
      .click();
}

/** All references start in an actual file selection; reads inspect the composer's own persisted draft. */
export function registerPendingFileQuoteEditJourneys({ openFromHome, addPlace, modelProjection, filePath }) {
  for (const [label, width, dark] of [
    ['1440-light', 1440, false],
    ['390-dark', 390, true],
  ]) {
    test(
      `text annotation editing: file numbers choose, edit and delete the same draft before one send ${label}`,
      {
        timeout: 120_000,
      },
      async () => {
        const draft = '原有聊天草稿\nkeep this separate';
        await openFromHome({
          viewport: { width, height: 900 },
          dark,
          draft,
          prefix: `f309-file-annotation-edit-${label}`,
          run: async ({ page, surface, posts, sent, errors }) => {
            await mkdir(EVIDENCE, { recursive: true });
            await writeFile(
              `${EVIDENCE}/file-annotation-entry-${label}.json`,
              `${JSON.stringify(
                {
                  url: page.url(),
                  viewport: page.viewportSize(),
                  input: await page.getByLabel('消息输入框').inputValue(),
                  draftMirror: await page.evaluate(() => sessionStorage.getItem('cat-cafe:thread-drafts')),
                },
                null,
                2,
              )}\n`,
            );
            assert.equal(
              await page.getByLabel('消息输入框').inputValue(),
              draft,
              'draft exists before any annotation is made',
            );
            await addPlace(page, posts, '暮色里的灯塔', '暮色里的灯塔', '第一处保留');
            await addPlace(page, posts, 'the keeper writes each turn', 'the keeper writes each turn', '第二处说明');
            await addPlace(page, posts, 'salt on the window', 'salt on the window', '第三处原样保留');
            await waitForComments(page, ['第一处保留', '第二处说明', '第三处原样保留']);
            const original = await readDraftQuotes(page);
            assert.equal(original.length, 3);
            const group = surface.locator(`[data-pending-file-quote="${original[0].id}:${original[1].id}"]`);
            await group.waitFor();
            await group.focus();
            await group.press('Enter');
            assert.equal(
              await page.getByTestId('context-annotation-comment').count(),
              0,
              'the group must ask which id',
            );
            const choose = page.getByRole('button', { name: '编辑第 2 处批注', exact: true });
            await choose.waitFor();
            await choose.press('Escape');
            assert.equal(await page.getByRole('dialog').count(), 0);
            assert.equal(await surface.isVisible(), true, 'canceling the choice keeps its file open');
            assert.deepEqual(await readDraftQuotes(page), original);
            await group.press('Enter');
            await choose.waitFor();
            await mkdir(EVIDENCE, { recursive: true });
            await page.screenshot({ path: `${EVIDENCE}/file-annotation-choice-${label}.png` });
            await choose.click();
            const editor = page.getByTestId('context-annotation-comment');
            assert.equal(await editor.inputValue(), '第二处说明');
            await editor.fill('改后的说明 · 绿');
            await editor.dispatchEvent('compositionstart', { data: '绿' });
            await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
            assert.deepEqual(await readDraftQuotes(page), original, 'IME confirmation cannot save or send');
            assert.equal(sent.length, 0);
            await editor.dispatchEvent('compositionend', { data: '绿' });
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            await editor.press('Shift+Enter');
            await editor.pressSequentially('keep this quote');
            const comment = '改后的说明 · 绿\nkeep this quote';
            const box = await page.getByTestId('context-annotation-editor').boundingBox();
            assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0, JSON.stringify(box));
            await page.screenshot({ path: `${EVIDENCE}/file-annotation-editor-${label}.png` });
            await editor.press('Enter');
            await waitForComments(page, ['第一处保留', comment, '第三处原样保留']);
            assert.deepEqual(await readDraftQuotes(page), [original[0], { ...original[1], comment }, original[2]]);
            await group.click();
            await page.getByRole('button', { name: '编辑第 1 处批注', exact: true }).click();
            await page.getByRole('button', { name: '删除批注', exact: true }).click();
            await waitForComments(page, [comment, '第三处原样保留']);
            const expected = [{ ...original[1], comment }, original[2]];
            assert.deepEqual(await readDraftQuotes(page), expected);
            await returnToChat(page, surface, width);
            assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.getByTestId('context-annotations-summary').waitFor();
            assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
            assert.deepEqual(await readDraftQuotes(page), expected);
            assert.equal(sent.length, 0, 'edit, delete, return and reload never send');
            // The workspace restores its retained file on reload, rather than reopening Home.
            await ensureWorkspaceOpen(page);
            await surface.getByTestId('workspace-content-review-text').waitFor();
            assert.equal(await surface.locator(`[data-owner-path="${filePath}"]`).count(), 1);
            await surface.locator(`[data-pending-file-quote="${expected[0].id}"]`).click();
            assert.equal(await editor.inputValue(), comment);
            await editor.press('Tab');
            assert.equal(
              await page
                .getByRole('button', { name: '删除批注', exact: true })
                .evaluate((node) => node === document.activeElement),
              true,
            );
            await page.keyboard.press('Escape');
            assert.equal(await page.getByTestId('context-annotation-editor').count(), 0);
            assert.equal(await surface.isVisible(), true, 'canceling the annotation keeps its file open');
            assert.deepEqual(await readDraftQuotes(page), expected);
            await returnToChat(page, surface, width);
            await page.getByRole('button', { name: 'Send message', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('[data-testid="context-annotations-summary"]'));
            assert.equal(sent.length, 1);
            assert.equal(sent[0].content, draft);
            assert.deepEqual(
              sent[0].contextAttachments,
              expected,
              'same ids, source, revision, selection and other quote',
            );
            assert.ok(expected.every((quote) => quote.source.path === filePath));
            const prompt = await modelProjection(sent[0]);
            assert.deepEqual(
              JSON.parse(prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<'))),
              expected,
            );
            const allowedPosts = new Set([
              '/api/workspace/content-reviews/prepare',
              '/api/workspace/search',
              '/api/workspace/resolve-file-source',
              `/api/threads/${THREAD_ID}/read/latest`,
              '/api/messages',
            ]);
            assert.ok(
              posts.every((url) => allowedPosts.has(url)),
              posts,
            );
            await writeFile(
              `${EVIDENCE}/file-annotation-edited-send-${label}.json`,
              `${JSON.stringify({ scope: 'actual Next controls, real file owner, intercepted one send; no model', original, body: sent[0], prompt }, null, 2)}\n`,
            );
            await page.screenshot({ path: `${EVIDENCE}/file-annotation-sent-${label}.png` });
            assert.deepEqual(errors, []);
          },
        });
      },
    );
  }
}
