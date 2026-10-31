import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collapseV2Workspace, openWorkspaceTools } from './f307-workspace-open.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

async function wholeImageAction(page) {
  const action = page.getByTestId('workspace-media-chat-whole-work');
  if (!(await action.isVisible())) await page.getByLabel('图片更多操作', { exact: true }).click();
  return action;
}

/** Real Next/Chat/Workspace controls; intercepted sends are verified through the API schema and prompt projection. */
export function registerWholeImageChatJourney(openWork) {
  test(
    'image visible work: removed existing whole reference stays removed through A to B and visible reopen',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors, sent } = await openWork({ width: 1440, shell: 'v2', resetLocalStorage: false });
      try {
        const composer = page.getByLabel('消息输入框');
        const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
        await composer.fill('A里保留的原文字');
        // Existing unselected cards have no auto/user bit. Remove one through the original X, without bulk migration.
        await (await wholeImageAction(page)).click();
        await chip.waitFor();
        await chip.getByRole('button', { name: /移除上下文/ }).click();
        assert.equal(await chip.count(), 0);
        const sourceUrl = page.url();
        await collapseV2Workspace(page);
        const other = new URL(sourceUrl);
        other.pathname = '/thread/thread-media-other';
        await page.route('**/api/threads/thread-media-other', (route) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ id: 'thread-media-other', title: '另一条对话', projectPath: '/project/cat-cafe' }),
          }),
        );
        await page.goto(other.href, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-chat-container]').waitFor();
        await composer.fill('B自己的草稿');
        assert.equal(await chip.count(), 0);
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-chat-container]').waitFor();
        const tools = await openWorkspaceTools(page);
        await tools.getByTestId('workspace-launcher-search').fill('cover');
        await tools.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
        const visibleMedia = page.locator('[data-testid="workspace-content-review-media"]:visible');
        await visibleMedia.waitFor();
        assert.equal(await visibleMedia.count(), 1, 'exactly one retained owner is actually visible');
        const retainedOwners = await page.getByTestId('workspace-content-review-media').evaluateAll((images) =>
          images.map((image) => ({
            source: image.getAttribute('src'),
            hiddenParent: image.closest('[hidden], [aria-hidden="true"], .hidden')?.outerHTML.slice(0, 300),
            rect: image.getBoundingClientRect().toJSON(),
            surfaceId: image.closest('[data-surface-id]')?.getAttribute('data-surface-id'),
          })),
        );
        assert.equal(await chip.count(), 0);
        assert.equal(await composer.inputValue(), 'A里保留的原文字');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await visibleMedia.waitFor();
        assert.equal(await visibleMedia.count(), 1);
        assert.equal(await chip.count(), 0);
        assert.equal(sent.length, 0);
        await mkdir(EVIDENCE, { recursive: true });
        await page.screenshot({ path: `${EVIDENCE}/visible-work-removal-return.png` });
        await writeFile(
          `${EVIDENCE}/visible-work-removal-return.json`,
          JSON.stringify(
            {
              sent,
              errors,
              sourceUrl,
              otherThread: other.href,
              originalDraft: await composer.inputValue(),
              cards: await chip.count(),
              retainedOwners,
            },
            null,
            2,
          ),
        );
        assert.deepEqual(errors, []);
      } catch (error) {
        await mkdir(EVIDENCE, { recursive: true });
        await page.screenshot({ path: `${EVIDENCE}/visible-work-removal-failure.png` });
        await writeFile(
          `${EVIDENCE}/visible-work-removal-failure.json`,
          JSON.stringify(
            {
              error: String(error),
              sent,
              errors,
              url: page.url(),
              body: await page.locator('body').innerText(),
              images: await page.getByTestId('workspace-content-review-media').evaluateAll((images) =>
                images.map((image) => ({
                  source: image.getAttribute('src'),
                  rect: image.getBoundingClientRect().toJSON(),
                  hiddenParent: image.closest('[hidden], [aria-hidden="true"], .hidden')?.outerHTML.slice(0, 300),
                  surfaceId: image.closest('[data-surface-id]')?.getAttribute('data-surface-id'),
                })),
              ),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.unrouteAll({ behavior: 'wait' });
        await context.close();
      }
    },
  );
  for (const [slug, width, dark] of [
    ['desktop-light', 1440, false],
    ['390-dark', 390, true],
  ]) {
    test(
      `image visible work: unselected current picture goes only in the explicit send ${slug}`,
      { timeout: 90_000 },
      async () => {
        const { context, page, errors, sent } = await openWork({ width, dark, shell: 'v2' });
        try {
          const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
          assert.equal(await chip.count(), 0, 'opening is not an explicit persistent attachment operation');
          const composer = page.getByLabel('消息输入框');
          const words = '把当前画面改得清楚一点\n保留我的第二行';
          await composer.fill(words);
          await composer.click({ timeout: 4_000 });
          const screenshot = `${EVIDENCE}/visible-work-before-send-${slug}.png`;
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: screenshot });
          await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click({ timeout: 4_000 });
          await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]')?.value === '');
          assert.equal(sent.length, 1);
          const [body] = sent;
          assert.equal(body.content, words);
          assert.equal(body.contextAttachments.length, 1);
          const [media] = body.contextAttachments;
          assert.equal(media.source.locator.path, 'art/cover.png');
          assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
          assert.equal(media.source.reviewId, REVIEW_ID);
          assert.deepEqual(media.selections, []);
          const prompt = await modelProjection(body);
          assert.deepEqual(
            JSON.parse(prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<'))),
            body.contextAttachments,
          );
          assert.equal(await chip.count(), 0, 'temporary whole work never becomes an attachment card');
          await collapseV2Workspace(page);
          await composer.fill('作品关上后，这是一条普通消息');
          await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
          await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]')?.value === '');
          assert.equal(sent.length, 2);
          assert.equal(sent[1].contextAttachments, undefined, 'the closed work cannot leak into a subsequent send');
          await writeFile(
            `${EVIDENCE}/visible-work-${slug}.json`,
            `${JSON.stringify({ scope: 'intercepted native sender + own API schema/prompt projection, no model', sent }, null, 2)}\n`,
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/visible-work-failure-${slug}.png` });
          await writeFile(
            `${EVIDENCE}/visible-work-failure-${slug}.json`,
            `${JSON.stringify({ sent, error: String(error), dom: await page.locator('body').innerText(), composer: await page.getByLabel('消息输入框').boundingBox(), host: await page.getByTestId('contextual-workspace-host').boundingBox(), url: page.url() }, null, 2)}\n`,
          );
          throw error;
        } finally {
          await context.unrouteAll({ behavior: 'wait' });
          await context.close();
        }
      },
    );
  }

  for (const [slug, width, dark] of [
    ['desktop-light', 1440, false],
    ['390-dark', 390, true],
  ]) {
    test(
      `image Chat primary: whole work preserves the draft and leaves through one send ${slug}`,
      { timeout: 120_000 },
      async () => {
        const { context, page, errors, sent } = await openWork({ width, dark, shell: 'v2' });
        try {
          const composer = page.getByLabel('消息输入框');
          await composer.fill('原聊天里的整图修改想法');
          const whole = await wholeImageAction(page);
          await whole.waitFor({ timeout: 15_000 });
          assert.equal(await page.getByTestId('content-modification-entry').count(), 0);
          await whole.click();
          const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
          await chip.waitFor();
          assert.equal(await composer.inputValue(), '原聊天里的整图修改想法');
          assert.equal(sent.length, 0, 'adding a whole work cannot send or write a review');
          await whole.click();
          assert.equal(await chip.count(), 1, 'reopening the same whole work keeps one reference');
          assert.equal(await page.getByLabel('消息输入框').count(), 1, 'one chat input remains the only sender');
          await mkdir(EVIDENCE, { recursive: true });
          await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-${slug}.png` });
          if (width === 390) {
            await collapseV2Workspace(page);
            assert.equal(await composer.inputValue(), '原聊天里的整图修改想法');
            assert.equal(await chip.count(), 1, 'the single-column return keeps the same chat draft');
            await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-return-${slug}.png` });
          }
          await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
          assert.equal(sent.length, 1);
          const [body] = sent;
          assert.equal(body.content, '原聊天里的整图修改想法');
          assert.equal(body.contextAttachments.length, 1);
          const [media] = body.contextAttachments;
          assert.equal(media.kind, 'media');
          assert.equal(media.mediaType, 'image/png');
          assert.equal(media.source.locator.path, 'art/cover.png');
          assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
          assert.equal(media.source.reviewId, REVIEW_ID);
          assert.deepEqual(media.selections, []);
          const prompt = await modelProjection(body);
          const projected = JSON.parse(
            prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
          );
          assert.deepEqual(projected, body.contextAttachments);
          await writeFile(
            `${EVIDENCE}/image-chat-primary-payload-${slug}.json`,
            `${JSON.stringify({ scope: 'intercepted UI send validated by own API schema and prompt projection', body }, null, 2)}\n`,
          );
          await page.screenshot({ path: `${EVIDENCE}/image-chat-primary-sent-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'image Chat primary: composed text and the exact whole work survive return and reload before one send',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors, sent } = await openWork({ shell: 'v2' });
      try {
        const composer = page.getByLabel('消息输入框');
        const words = '整图改为薄荷绿\nkeep the gold star';
        await composer.fill('整图改为薄荷绿');
        await composer.press('Shift+Enter');
        await composer.pressSequentially('keep the gold star');
        assert.equal(await composer.inputValue(), words);
        await (await wholeImageAction(page)).click();
        const chip = page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]');
        await chip.waitFor();
        await composer.dispatchEvent('compositionstart', { data: '绿' });
        await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
        assert.equal(sent.length, 0, 'IME confirmation cannot send the whole-image request');
        assert.equal(await composer.inputValue(), words);
        await composer.dispatchEvent('compositionend', { data: '绿' });
        await collapseV2Workspace(page);
        await page.waitForFunction(
          ([threadId, expected]) => {
            const drafts = JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts') ?? '[]');
            const media = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
            return (
              drafts.some(([id, text]) => id === threadId && text === expected) &&
              media.some(([id, items]) => id === threadId && items.length === 1 && items[0].kind === 'media')
            );
          },
          [THREAD_ID, words],
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await chip.waitFor();
        assert.equal(await composer.inputValue(), words);
        assert.equal(sent.length, 0, 'restoring a draft cannot send');
        assert.equal(await chip.count(), 1);
        await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
        assert.equal(sent.length, 1);
        const [body] = sent;
        assert.equal(body.content, words);
        assert.equal(body.contextAttachments.length, 1);
        const [media] = body.contextAttachments;
        assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
        assert.equal(media.source.reviewId, REVIEW_ID);
        assert.equal(media.source.locator.path, 'art/cover.png');
        assert.deepEqual(media.selections, []);
        const prompt = await modelProjection(body);
        assert.deepEqual(
          JSON.parse(prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<'))),
          body.contextAttachments,
        );
        await writeFile(
          `${EVIDENCE}/image-chat-primary-restored-payload.json`,
          `${JSON.stringify({ words, body }, null, 2)}\n`,
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
}
