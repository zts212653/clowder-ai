import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { routeComposerDraft } from './f309-composer-workspace-owner.mjs';
import { EVIDENCE } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { routeThroughRealOwner } from './f309-ordinary-workspace-real-owner.mjs';

function quotes(draft) {
  return (draft?.contentBlocks ?? [])
    .filter((block) => block.type === 'context_attachment')
    .map((block) => block.attachment);
}

async function savedQuote(owner) {
  // Precondition only: the counterexample starts from a quote that the owner has already saved.
  for (let i = 0; i < 100; i++) {
    const draft = await owner.readDraft();
    if (quotes(draft).length === 1) return { draft, quote: quotes(draft)[0] };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the initial quote never reached the canonical owner');
}

export function registerFileQuotePersistenceJourneys({ openFromHome, addPlace, suite }) {
  for (const [label, width, dark] of [
    ['1440-light', 1440, false],
    ['390-dark', 390, true],
  ]) {
    test(`text annotation persistence: deletion survives immediate reload ${label}`, { timeout: 120000 }, async () => {
      await openFromHome({
        viewport: { width, height: 900 },
        dark,
        draft: '原聊天草稿\nkeep this separate',
        prefix: `f309-delete-reload-${label}`,
        run: async ({ page, surface, owner, sent, errors }) => {
          await addPlace(page, [], 'salt on the window', 'salt on the window', '只删除，不发送');
          const before = await savedQuote(owner);
          await surface.locator(`[data-pending-file-quote="${before.quote.id}"]`).click();
          await page.getByRole('button', { name: '删除批注', exact: true }).click();
          // No post-delete wait or owner-read barrier before the native browser reload.
          const hydration = page.waitForResponse(
            (item) =>
              new URL(item.url()).pathname === `/api/threads/${THREAD_ID}/composer-draft` &&
              item.request().method() === 'GET',
          );
          await page.reload({ waitUntil: 'domcontentloaded' });
          const restored = (await (await hydration).json()).draft;
          assert.deepEqual(quotes(restored), [], 'the first owner hydration must already retain the deletion');
          const reloadedSurface = page.getByTestId('workspace-content-review-surface');
          await reloadedSurface.getByText('salt on the window', { exact: false }).waitFor();
          assert.equal(await reloadedSurface.locator(`[data-pending-file-quote="${before.quote.id}"]`).count(), 0);
          await reloadedSurface.getByRole('button', { name: '返回来源', exact: true }).click();
          if (width === 390)
            await page
              .getByTestId('contextual-workspace-host')
              .getByRole('button', { name: /^(收起 Workspace|Collapse Workspace)$/ })
              .click();
          await page.waitForFunction(
            (expected) => document.querySelector('textarea[aria-label="消息输入框"]')?.value === expected,
            before.draft.text,
          );
          const after = await owner.readDraft();
          assert.deepEqual(quotes(after), []);
          assert.equal(after.text, before.draft.text);
          assert.equal(await page.getByLabel('消息输入框').inputValue(), before.draft.text);
          assert.equal(await page.getByTestId('context-annotations-summary').count(), 0);
          await page.getByLabel('消息输入框').scrollIntoViewIfNeeded();
          assert.equal(sent.length, 0);
          await mkdir(EVIDENCE, { recursive: true });
          await writeFile(
            `${EVIDENCE}/fast-delete-reload-${label}.json`,
            `${JSON.stringify({ before, after, sent: sent.length, draftRequests: owner.draftRequests })}\n`,
          );
          await page.screenshot({ path: `${EVIDENCE}/fast-delete-reload-${label}.png` });
          assert.deepEqual(errors, []);
        },
      });
    });

    test(
      `text annotation persistence: accepted send stays cleared after closing and cold opening ${label}`,
      { timeout: 120000 },
      async () => {
        await openFromHome({
          viewport: { width, height: 900 },
          dark,
          draft: '仅发送一次\n原正文',
          prefix: `f309-send-close-${label}`,
          run: async ({ page, surface, owner, context, sent, errors }) => {
            await addPlace(page, [], 'salt on the window', 'salt on the window', '保留原引用');
            const before = await savedQuote(owner);
            await surface.getByRole('button', { name: '返回来源', exact: true }).click();
            if (width === 390)
              await page
                .getByTestId('contextual-workspace-host')
                .getByRole('button', { name: /^(收起 Workspace|Collapse Workspace)$/ })
                .click();
            const url = page.url();
            const response = page.waitForResponse(
              (item) => new URL(item.url()).pathname === '/api/messages' && item.request().method() === 'POST',
            );
            await page.evaluate(() => {
              window.__f309SendAcknowledged = false;
              window.addEventListener('guide:confirm', (event) => {
                if (event.detail?.target === 'chat.input') window.__f309SendAcknowledged = true;
              });
            });
            await page.getByRole('button', { name: 'Send message', exact: true }).click();
            assert.equal((await response).status(), 200);
            // The canonical queued ACK is parsed before this event. Admission no longer invents a History bubble.
            await page.waitForFunction(() => window.__f309SendAcknowledged === true);
            await context.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
            const cold = await suite().browser.newContext({ viewport: { width, height: 900 } });
            try {
              if (dark) await cold.addInitScript(() => localStorage.setItem('theme', 'dark'));
              await routeThroughRealOwner(cold, owner, {
                extra: (route, target) => routeComposerDraft(route, target, owner),
              });
              const reopened = await cold.newPage();
              const hydrated = reopened.waitForResponse(
                (item) => new URL(item.url()).pathname === `/api/threads/${THREAD_ID}/composer-draft`,
              );
              await reopened.goto(url, { waitUntil: 'domcontentloaded' });
              const restored = (await (await hydrated).json()).draft;
              assert.equal(restored?.text ?? '', '', 'the first cold owner hydration cannot restore the sent draft');
              assert.deepEqual(quotes(restored), []);
              const after = await owner.readDraft();
              assert.equal(after?.text ?? '', '');
              assert.deepEqual(quotes(after), []);
              assert.equal(await reopened.getByLabel('消息输入框').inputValue(), '');
              assert.equal(await reopened.getByTestId('context-annotations-summary').count(), 0);
              await reopened.getByLabel('消息输入框').scrollIntoViewIfNeeded();
              assert.equal(sent.length, 1);
              assert.equal(sent[0].content, before.draft.text);
              assert.deepEqual(sent[0].contextAttachments, [before.quote]);
              await mkdir(EVIDENCE, { recursive: true });
              await writeFile(
                `${EVIDENCE}/send-close-reopen-${label}.json`,
                `${JSON.stringify({ before, after, body: sent[0], sent: sent.length, draftRequests: owner.draftRequests, scope: 'real Next and owner draft routes; one intercepted send, no model' })}\n`,
              );
              await reopened.screenshot({ path: `${EVIDENCE}/send-close-reopen-${label}.png` });
            } finally {
              await cold.unrouteAll({ behavior: 'ignoreErrors' });
              await cold.close();
            }
            assert.deepEqual(errors, []);
          },
        });
      },
    );
  }
}
