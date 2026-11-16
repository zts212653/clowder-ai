import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { composerDraftPutSchema } from '../../../api/src/routes/composer-draft-recall-helpers.ts';
import { sendMessageSchema } from '../../../api/src/routes/messages.schema.ts';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { CURRENT_THREAD, DRAFT } from './fixtures/f322-chat-real-page-data.mjs';

// Production message selection, annotation editor, thread switch, drafts and send.
// Controlled HTTP storage uses the actual API schemas; no provider or runtime writes.
const out = process.env.COMMENT_RETENTION_EVIDENCE_DIR;
if (out) await mkdir(out, { recursive: true });
const built = await buildChatProof();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const drafts = new Map([
  [
    CURRENT_THREAD,
    {
      draft: {
        version: 1,
        ownerUserId: 'owner-proof',
        threadId: CURRENT_THREAD,
        revision: 1,
        text: DRAFT,
        updatedAt: Date.now(),
      },
      revision: 1,
    },
  ],
]);
const attempts = [];
let refuseNextSend = true;
const reply = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const harness = createChatProofHarness(context, built, out, [], (api) => {
  const original = api.respond;
  api.respond = (request, url) => {
    const method = request.method();
    if (/^\/api\/threads\/composer-proof-\d+\/artifacts$/.test(url.pathname) && method === 'GET') {
      assert.equal(url.searchParams.get('view'), 'works');
      return reply({ view: 'works', artifacts: [], total: 0, complete: true, workLineage: 'resolved' });
    }
    const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/composer-draft$/);
    if (match) {
      const threadId = match[1];
      const current = drafts.get(threadId) ?? { draft: null, revision: 0 };
      if (method === 'GET') return reply(current);
      const body = request.postDataJSON();
      if (method === 'PUT' && !composerDraftPutSchema.safeParse(body).success)
        return reply({ error: 'invalid draft' }, 400);
      if (body.expectedRevision !== current.revision)
        return reply({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: current.revision }, 409);
      const revision = current.revision + 1;
      const next = {
        revision,
        draft:
          method === 'DELETE'
            ? null
            : {
                version: 1,
                ownerUserId: 'owner-proof',
                threadId,
                ...body,
                revision,
                updatedAt: Date.now(),
              },
      };
      drafts.set(threadId, next);
      return reply(method === 'DELETE' ? { cleared: true, revision } : next);
    }
    const receipt = url.pathname.match(/^\/api\/threads\/([^/]+)\/message-attempts\/([^/]+)$/);
    if (receipt && method === 'GET') {
      assert.equal(receipt[1], CURRENT_THREAD);
      assert.ok(attempts.some((attempt) => attempt.idempotencyKey === receipt[2]));
      const accepted = api.sent.findIndex((attempt) => attempt.idempotencyKey === receipt[2]);
      return reply(
        accepted < 0
          ? { status: 'unknown' }
          : { status: 'accepted', userMessage: { id: `accepted-${accepted + 1}`, timestamp: Date.now() } },
      );
    }
    if (url.pathname === '/api/messages' && method === 'POST') {
      const body = request.postDataJSON();
      attempts.push(body);
      assert.equal(sendMessageSchema.safeParse(body).success, true, 'actual send schema accepts the entire collection');
      if (refuseNextSend) {
        refuseNextSend = false;
        return reply({ error: 'fixture send refusal', code: 'QUEUE_FULL' }, 429);
      }
    }
    return original(request, url);
  };
});
let proof;
try {
  proof = await harness.openProof({ surface: true, followRoute: true });
  const { page, api } = proof;
  const proofUrl = page.url();
  let finalDraftWrite;
  for (let index = 0; index < 15; index++) {
    const paragraph = page
      .locator('[data-message-id="reading-cat"] p')
      .filter({ hasText: `第${(index % 7) + 1}段` })
      .last();
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.evaluate(
      (node, offset) => {
        const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 12);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      },
      Math.floor(index / 7) * 16,
    );
    await page.getByTestId('message-selection-add-to-chat').click();
    await page.getByTestId('context-annotation-comment').fill(`comment ${String(index + 1).padStart(2, '0')}`);
    if (index === 14)
      finalDraftWrite = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith('/composer-draft') &&
          response.request().postDataJSON().contentBlocks?.length === 15,
      );
    await page.getByTestId('context-annotation-save').click();
    await page.getByTestId('context-annotation-editor').waitFor({ state: 'hidden' });
  }
  const summary = page.getByTestId('context-annotations-summary');
  await finalDraftWrite;
  await page.waitForFunction(
    () => document.querySelector('[data-testid="context-annotations-summary"]')?.textContent === '15 annotations',
  );
  assert.equal(drafts.get(CURRENT_THREAD).draft.contentBlocks.length, 15);
  await page.locator('[data-thread-id="composer-proof-2"]').first().click();
  await page.waitForURL('**/thread/composer-proof-2');
  await summary.waitFor({ state: 'hidden' });
  await page.locator(`[data-thread-id="${CURRENT_THREAD}"]`).first().click();
  await page.waitForURL(`**/thread/${CURRENT_THREAD}`);
  await summary.waitFor();
  assert.equal(await summary.innerText(), '15 annotations');
  // A fresh page restores the server draft, without a session mirror covering up a rejected PUT.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(proofUrl, { waitUntil: 'networkidle' });
  await summary.waitFor();
  assert.equal(await summary.innerText(), '15 annotations');
  if (out) await page.screenshot({ path: path.join(out, 'fifteen-comments-restored.png') });
  const field = page.locator('textarea').last();
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/messages') && response.request().method() === 'POST',
    ),
    field.press('Enter'),
  ]);
  // Admission to the durable local attempt transfers the composer content to its
  // bubble. A retryable refusal retains that attempt, not a second editable draft.
  const failed = page.locator('[data-testid="send-attempt-status"][data-send-status="failed"]');
  await failed.waitFor();
  assert.equal(await field.inputValue(), '');
  await summary.waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'networkidle' });
  await failed.waitFor();
  for (let index = 1; index <= 15; index++)
    assert.equal(await page.getByText(`comment ${String(index).padStart(2, '0')}`, { exact: false }).count(), 1);
  if (out) await page.screenshot({ path: path.join(out, 'refused-send-restored.png') });
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/api/messages') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '重试发送这条消息', exact: true }).click(),
  ]);
  await page.locator('[data-testid="send-attempt-status"][data-send-status="accepted"]').waitFor();
  assert.equal(api.sent.length, 1);
  assert.equal(attempts.length, 2);
  const expected = Array.from({ length: 15 }, (_, index) => `comment ${String(index + 1).padStart(2, '0')}`);
  for (const sent of attempts)
    assert.deepEqual(
      sent.contextAttachments.map((item) => item.comment),
      expected,
    );
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  if (out)
    await writeFile(
      path.join(out, 'receipt.json'),
      JSON.stringify(
        {
          comments: 15,
          switchedAndReturned: true,
          restoredFromServer: true,
          refusedSendPreserved: true,
          refusedSendRestoredFromLocalAttempt: true,
          successfulSends: api.sent.length,
          browserErrors: proof.errors,
        },
        null,
        2,
      ),
    );
  console.log('PASS: 15 annotations → switch → return → server reload → refused attempt reload → complete retry');
} catch (error) {
  if (proof && out) await harness.captureFailure(proof.page, 'comment-retention', error);
  throw error;
} finally {
  if (proof) await harness.closeProof(proof);
  await context.close();
  await browser.close();
}
