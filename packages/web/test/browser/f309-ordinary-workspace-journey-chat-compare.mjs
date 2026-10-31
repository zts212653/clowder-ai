import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';
import { EVIDENCE, measureContrast, openChatPage } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import {
  IMAGE_FIXTURE,
  REVIEW_ID,
  SOURCE_REVISION,
  WEB_ROOT,
  WORKTREE_ID,
} from './f309-ordinary-workspace-journey-fixture.mjs';

// Real Next shell, production CSS, the real ChatMessage, the real Workspace and the real K3 comparison; only the
// network is stubbed. The owner's answers (the request, both image versions, the accept and reject calls) are a
// fixture, so this proves how a returned image is compared and decided where the person is working, not that a real
// cat produced it or that a real file was written.
const REQUEST_ID = `f309-modification-${'9'.repeat(64)}`;
const CANDIDATE_REF = 'candidate-image-v2';
const ORIGINAL_CONTENT = 'content-original-cover';
const CANDIDATE_CONTENT = 'content-returned-cover';
const SENT_ID = 'human-image-request';
const RECEIPT_ID = 'host-receipt-image-candidate';
const WORKTREE = canonicalWorktreeId(WORKTREE_ID);

const ORIGINAL_BYTES = IMAGE_FIXTURE.bytes;
// A different, real PNG, so the two versions can be told apart by eye in the evidence.
const CANDIDATE_BYTES = readFileSync(path.resolve(WEB_ROOT, '../../assets/avatars/codex.png'));
const dimensions = (bytes) => ({ kind: 'image', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
const asset = (contentRef, bytes, digitChar) => ({
  contentRef,
  ownerRevision: 1,
  blobDigest: `sha256:${digitChar.repeat(64)}`,
  mediaType: 'image/png',
  media: dimensions(bytes),
  sourcePublication: { artifactRef: `artifact-${contentRef}`, sourceRef: `source-${contentRef}`, revision: 'r1' },
  ownerReceiptRef: `owner-receipt-${contentRef}`,
});
const ORIGINAL_ASSET = asset(ORIGINAL_CONTENT, ORIGINAL_BYTES, 'c');
const CANDIDATE_ASSET = asset(CANDIDATE_CONTENT, CANDIDATE_BYTES, 'e');

const FILE_SOURCE = {
  kind: 'workspace',
  locator: { worktreeId: WORKTREE, path: 'art/cover.png' },
  expectedSourceRevision: SOURCE_REVISION,
  reviewId: REVIEW_ID,
  expectedReviewRevision: 1,
};
const conversation = (kind, length, timestamp) =>
  Array.from({ length }, (_, index) => ({
    from: { kind: 'user', userId: 'operator' },
    id: `${kind}-${index}`,
    type: 'user',
    content: `${kind === 'earlier' ? '较早' : '之后'}的一条对话 ${index + 1}`,
    timestamp,
  }));
const sentMessage = {
  from: { kind: 'user', userId: 'operator' },
  id: SENT_ID,
  type: 'user',
  content: '请处理这一处',
  timestamp: 1,
  contentBlocks: [
    { type: 'text', text: '请处理这一处' },
    {
      type: 'context_attachment',
      attachment: {
        v: 1,
        id: 'media-sent',
        kind: 'media',
        title: 'cover.png',
        mediaType: 'image/png',
        source: FILE_SOURCE,
        selections: [{ id: '1', selection: { kind: 'image-region', x: 40, y: 30, width: 120, height: 90 } }],
      },
    },
  ],
};
const receiptMessage = {
  from: { kind: 'system', service: 'content-modification' },
  id: RECEIPT_ID,
  type: 'system',
  catId: null,
  content: '候选修改已返回。',
  replyTo: SENT_ID,
  timestamp: 2,
  extra: {
    systemKind: 'content_modification_receipt',
    contentModificationReceiptV1: {
      v: 1,
      requestId: REQUEST_ID,
      sourceMessageId: SENT_ID,
      targetCatId: 'codex-terra',
      taskId: 'task-image',
      state: 'candidate',
      candidateRef: CANDIDATE_REF,
      receiptRef: 'receipt-image-candidate',
      observedAt: 2,
      followUp: { kind: 'none', reason: 'not_applicable' },
    },
  },
};

// The receipt of a later write-back: its action opens the file itself, with no comparison.
const appliedReceiptMessage = {
  ...receiptMessage,
  id: 'host-receipt-image-applied',
  content: '修改已写回。',
  timestamp: 3,
  extra: {
    systemKind: 'content_modification_receipt',
    contentModificationReceiptV1: {
      ...receiptMessage.extra.contentModificationReceiptV1,
      state: 'applied',
      receiptRef: 'receipt-image-applied',
      observedAt: 3,
    },
  },
};

const baseView = (decisions) => ({
  stage: 'queued',
  execution: { state: 'finished', messageId: 'carrier', targetCatId: 'codex-terra', observedAt: 3, evidenceRef: 'e' },
  candidates: [
    {
      kind: 'media',
      candidateRef: CANDIDATE_REF,
      asset: CANDIDATE_ASSET,
      authorCatId: 'codex-terra',
      responses: [{ annotationId: 'place-1', disposition: 'addressed', explanation: '已按圈出的位置修改。' }],
    },
  ],
  acceptances: decisions.acceptances,
  rejections: decisions.rejections,
  writeback: {
    originRequestId: REQUEST_ID,
    locator: FILE_SOURCE.locator,
    baseRevision: SOURCE_REVISION,
    writable: true,
  },
  record: {
    requestId: REQUEST_ID,
    ownerUserId: 'operator',
    revision: 1 + decisions.acceptances.length + decisions.rejections.length,
    createdAt: 1,
    updatedAt: 1,
    progress: {
      sourceMessageId: SENT_ID,
      sourceKind: 'human_message',
      prepared: { kind: 'media', contentRef: ORIGINAL_CONTENT, ownerRevision: 1 },
    },
    payload: {
      operationId: 'operation-image-request',
      targetCatId: 'codex-terra',
      threadId: 'execution-thread',
      intent: { body: '请处理这一处' },
      source: FILE_SOURCE,
    },
  },
});

const WRITTEN_REVISION = `sha256:${'d'.repeat(64)}`;
const appliedAcceptance = {
  acceptance: {
    requestId: REQUEST_ID,
    ownerUserId: 'operator',
    acceptOperationId: 'accept-operation',
    candidateRef: CANDIDATE_REF,
    baseRevision: SOURCE_REVISION,
    locator: FILE_SOURCE.locator,
    humanReceiptRef: 'human-receipt',
    fileReceiptRef: 'file-receipt',
    acceptedAt: 5,
  },
  receipt: {
    receiptRef: 'file-receipt',
    ownerUserId: 'operator',
    locator: FILE_SOURCE.locator,
    baseRevision: SOURCE_REVISION,
    candidateRevision: `sha256:${'e'.repeat(64)}`,
    requestId: REQUEST_ID,
    candidateRef: CANDIDATE_REF,
    acceptOperationId: 'accept-operation',
    state: 'applied',
    appliedAt: 6,
    appliedSequence: 1,
    writtenRevision: WRITTEN_REVISION,
    currentRevision: WRITTEN_REVISION,
  },
};
// The file changed under the person since the request was made: nothing is written, the version stays.
const conflictAcceptance = {
  ...appliedAcceptance,
  receipt: {
    ...appliedAcceptance.receipt,
    state: 'conflict',
    writtenRevision: undefined,
    currentRevision: `sha256:${'f'.repeat(64)}`,
  },
};
const rejection = {
  requestId: REQUEST_ID,
  candidateRef: CANDIDATE_REF,
  ownerUserId: 'operator',
  actorId: 'operator',
  receiptRef: 'rejection-receipt',
  state: 'rejected',
  rejectedAt: 5,
};

/** The owner as the Workspace reads it; accept and reject change what the next read says, as the real owner does. */
function ownerApi({ accept = 'applied' } = {}) {
  const decisions = { acceptances: [], rejections: [] };
  const handler = async (request, url, calls) => {
    const { pathname } = url;
    const method = request.method();
    if (pathname === `/api/content-modifications/${REQUEST_ID}` && method === 'GET') {
      calls.push('GET request');
      return { body: baseView(decisions) };
    }
    if (pathname === `/api/content-modifications/${REQUEST_ID}/accept` && method === 'POST') {
      calls.push('POST accept');
      decisions.acceptances = [accept === 'conflict' ? conflictAcceptance : appliedAcceptance];
      return { body: {} };
    }
    if (pathname === `/api/content-modifications/${REQUEST_ID}/reject` && method === 'POST') {
      calls.push('POST reject');
      decisions.rejections = [rejection];
      return { body: {} };
    }
    if (pathname === '/api/content-modifications/context' && method === 'POST') {
      calls.push('POST context');
      return {
        body: {
          requests: [{ record: baseView(decisions).record, stage: 'queued' }],
          contexts: [
            {
              taskId: 'task-image',
              title: '处理封面',
              targetCatId: 'codex-terra',
              threadId: 'execution-thread',
              targetName: '小团团',
              threadTitle: '修改说明',
              completionRule: 'file-writeback-applied',
              requestIds: [REQUEST_ID],
              state: 'active',
              taskContext: { kind: 'text', taskId: 'task-image', expectedTaskRevision: 1 },
            },
          ],
          suggestedCatId: 'codex-terra',
        },
      };
    }
    if (pathname === '/api/workspace/edit-session' && method === 'POST') {
      calls.push('POST edit-session');
      return { body: { token: 'edit-token' } };
    }
    if (pathname === `/api/content-publications/${ORIGINAL_CONTENT}` && method === 'GET')
      return { body: { asset: ORIGINAL_ASSET } };
    if (pathname === `/api/content-publications/${ORIGINAL_CONTENT}/media/1`)
      return { raw: ORIGINAL_BYTES, contentType: 'image/png' };
    if (pathname === `/api/content-publications/${CANDIDATE_CONTENT}/media/1`)
      return { raw: CANDIDATE_BYTES, contentType: 'image/png' };
    // Production resolves a durable root id to itself; the shared fixture only knows the alias.
    if (pathname === '/api/workspace/resolve-file-source' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      return { body: { worktreeId: body.worktreeId, path: body.path, kind: 'file' } };
    }
    return undefined;
  };
  return handler;
}

export function registerOrdinaryChatCompareJourney(suite) {
  /** `later` is how much the person said after the receipt: the chat then opens with the receipt above the fold. */
  const open = ({ accept, later = 0, applied = false, ...options } = {}) =>
    openChatPage(suite, {
      ...options,
      messages: [
        ...conversation('earlier', 6, 0),
        sentMessage,
        receiptMessage,
        ...(applied ? [appliedReceiptMessage] : []),
        ...conversation('later', later, 4),
      ],
      handleApi: ownerApi({ accept }),
    });
  const receiptLine = (page) => page.locator(`[data-message-id="${RECEIPT_ID}"] [data-testid="modification-progress"]`);
  /** The returned version, opened from the conversation: the Workspace shows it, marked, next to the chat. */
  const openComparison = async (page) => {
    await receiptLine(page).waitFor({ timeout: 20_000 });
    await page.evaluate(() => {
      window.__chatBeforeOpen = document.querySelector('[data-chat-container]');
    });
    await receiptLine(page).getByRole('button', { name: '打开对照' }).click();
    const focused = page.locator('[data-testid="content-modification-result"][data-focused="true"]');
    await focused.waitFor({ state: 'visible', timeout: 30_000 });
    return focused;
  };

  test(
    'image candidate: the receipt opens the original and the returned version side by side with the chat, the chat untouched',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open();
      try {
        const focused = await openComparison(page);
        assert.equal(await focused.getAttribute('data-candidate-ref'), CANDIDATE_REF);
        const compare = focused.getByRole('region', { name: '版本对比' });
        await compare.waitFor({ timeout: 20_000 });
        // Both exact versions are on screen as real, decoded images.
        const decoded = await compare.locator('img').evaluateAll((images) =>
          images.map((image) => ({
            alt: image.getAttribute('alt'),
            width: image.naturalWidth,
            shown: !image.closest('[hidden]'),
          })),
        );
        assert.deepEqual(
          decoded.map((item) => item.alt),
          ['原版 v1', '候选版本 v1'],
        );
        assert.ok(
          decoded.every((item) => item.width > 0),
          `both versions decode: ${JSON.stringify(decoded)}`,
        );
        // Opening the comparison puts the comparison itself in front of the person, not just its header at the edge
        // of the panel: the viewport that holds the two pictures lies inside the window.
        const viewportBox = await compare.getByTestId('media-compare-viewport').boundingBox();
        const windowHeight = page.viewportSize()?.height ?? 0;
        assert.ok(
          viewportBox && viewportBox.y >= 0 && viewportBox.y + viewportBox.height <= windowHeight,
          `the compared pictures are in view, got ${JSON.stringify(viewportBox)} in a ${windowHeight}px window`,
        );
        // The artwork steps aside so the comparison has the room; the way back to it is one plain button.
        assert.equal(
          await page.getByTestId('workspace-review-artwork').isVisible(),
          false,
          'the artwork is not in the way of the comparison',
        );
        await page.getByTestId('workspace-return-to-artwork').waitFor({ state: 'visible' });
        assert.equal(
          await page.getByTestId('workspace-media-chat-whole-work').count(),
          0,
          'a comparison must not offer a whole-image action that still names the original file',
        );
        // The decision is in front of the person too, not behind a scroll inside a scroll: the topmost thing at both
        // ends of each button is the button itself, so nothing clips it.
        for (const name of ['采用并写回', '不采用']) {
          const reachable = await focused.getByRole('button', { name, exact: true }).evaluate((button) => {
            const box = button.getBoundingClientRect();
            const x = box.x + box.width / 2;
            return [box.y + 3, box.y + box.height - 3].every((y) => {
              const hit = document.elementFromPoint(x, y);
              return hit instanceof Element && button.contains(hit);
            });
          });
          assert.equal(reachable, true, `${name} is fully in front of the person`);
        }
        // Switching the view shows the other version and changes nothing in the owner.
        const mode = await compare.getAttribute('data-compare-mode');
        assert.ok(mode === 'side' || mode === 'toggle', `the compare has a mode, got ${mode}`);
        if (mode === 'toggle') {
          await compare.getByRole('button', { name: /候选版本 · v1/ }).click();
          assert.equal(await compare.getByRole('figure', { name: '候选版本' }).isVisible(), true);
        }
        // The chat is the same element it was before the Workspace took the file: nothing was rebuilt.
        const sameChat = await page.evaluate(
          () => window.__chatBeforeOpen === document.querySelector('[data-chat-container]'),
        );
        assert.equal(sameChat, true, 'the same chat container');
        assert.equal(await page.locator(`[data-message-id="${SENT_ID}"]`).count(), 1);
        assert.deepEqual(
          calls.filter((call) => call.startsWith('POST') && call !== 'POST context'),
          [],
          'looking at the comparison writes nothing',
        );
        await page.screenshot({ path: `${EVIDENCE}/media-compare-opened-1440.png` });
        await focused.screenshot({ path: `${EVIDENCE}/media-compare-candidate-1440.png` });
        // Back to the picture: the file is where it was, the comparison's panel stays open.
        await page.getByTestId('workspace-return-to-artwork').click();
        await page.getByTestId('workspace-review-artwork').waitFor({ state: 'visible' });
        assert.equal(await page.getByTestId('content-modification-panel').isVisible(), true);
        // And it is the very file the request was made on, decoded, in the same window.
        await page.waitForFunction(
          () => {
            const image = document.querySelector('[data-testid="review-media-stage"] img');
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
          },
          undefined,
          { timeout: 20_000 },
        );

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
  test(
    'image candidate: adopting it goes through the owner, says it was written back, and leaves the chat alone',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open();
      try {
        const focused = await openComparison(page);
        await focused.getByRole('button', { name: '采用并写回', exact: true }).click();
        const status = focused.locator('output');
        await status.filter({ hasText: '已写回原文件' }).waitFor({ timeout: 20_000 });
        assert.equal(calls.filter((call) => call === 'POST accept').length, 1, 'one accept');
        assert.ok(calls.includes('POST edit-session'), 'the write goes through an edit session');
        // Decided: the version stays on screen, and neither decision is offered again.
        assert.equal(await focused.getByRole('button', { name: '采用并写回', exact: true }).count(), 0);
        assert.equal(await focused.getByRole('button', { name: '不采用', exact: true }).count(), 0);
        assert.equal(await focused.getByRole('region', { name: '版本对比' }).count(), 1);
        await focused.screenshot({ path: `${EVIDENCE}/media-compare-adopted-1440.png` });
        assert.equal(
          await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
          true,
          'the same chat container',
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'image candidate: a file that changed meanwhile is not overwritten, and the returned version is kept',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open({ accept: 'conflict' });
      try {
        const focused = await openComparison(page);
        await focused.getByRole('button', { name: '采用并写回', exact: true }).click();
        await focused
          .locator('output')
          .filter({ hasText: '原文件已有改动，尚未写回；新版本已保留。' })
          .waitFor({ timeout: 20_000 });
        assert.equal(calls.filter((call) => call === 'POST accept').length, 1);
        assert.equal(await focused.getByRole('region', { name: '版本对比' }).count(), 1, 'the version is kept');
        assert.equal(await focused.getByRole('button', { name: '采用并写回', exact: true }).count(), 0);
        await focused.screenshot({ path: `${EVIDENCE}/media-compare-conflict-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'image candidate: not adopting it says so and keeps the version and the discussion',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open();
      try {
        const focused = await openComparison(page);
        await focused.getByRole('button', { name: '不采用', exact: true }).click();
        await focused.getByText('已拒绝此候选；候选和原讨论仍保留。').waitFor({ timeout: 20_000 });
        assert.equal(calls.filter((call) => call === 'POST reject').length, 1, 'one rejection');
        assert.equal(calls.filter((call) => call === 'POST accept').length, 0, 'rejecting writes nothing to the file');
        assert.equal(await focused.getByRole('region', { name: '版本对比' }).count(), 1, 'the version is kept');
        assert.equal(await focused.getByRole('button', { name: '采用并写回', exact: true }).count(), 0);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'image candidate: returning to the source brings the receipt it was opened from back in front of the person',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors } = await open({ later: 40 });
      try {
        await openComparison(page);
        // The person read on in the chat, which sits at its newest message: the receipt is no longer on screen.
        const receiptInChat = (id) => {
          const element = document.querySelector(`[data-message-id="${id}"]`);
          const chat = document.querySelector('[data-chat-container]');
          if (!element || !chat) return false;
          const box = element.getBoundingClientRect();
          const view = chat.getBoundingClientRect();
          return box.bottom > view.top && box.top < view.bottom;
        };
        await page.locator('[data-message-id="later-39"]').scrollIntoViewIfNeeded();
        await page.waitForFunction((id) => {
          const row = document.querySelector(`[data-message-id="${id}"]`);
          const chat = document.querySelector('[data-chat-container]');
          if (!row || !chat) return false;
          const box = row.getBoundingClientRect(),
            view = chat.getBoundingClientRect();
          return box.bottom <= view.top || box.top >= view.bottom;
        }, RECEIPT_ID);
        assert.equal(await page.evaluate(receiptInChat, RECEIPT_ID), false, 'the receipt starts out of sight');
        await page.getByRole('button', { name: '‹ 聊天', exact: true }).click();
        await page.waitForFunction(receiptInChat, RECEIPT_ID, { timeout: 15_000 });
        assert.equal(
          await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
          true,
          'the same chat container',
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
  test(
    'image candidate: opening the same file again from the chat shows the artwork, not the old comparison layout',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors } = await open({ applied: true });
      try {
        await openComparison(page);
        assert.equal(await page.getByTestId('workspace-review-artwork').isVisible(), false, 'comparing');
        // The person asks for the file itself, from a later receipt, while the comparison is still on screen.
        await page
          .locator('[data-message-id="host-receipt-image-applied"] [data-testid="modification-progress"]')
          .getByRole('button', { name: '打开文件' })
          .click();
        await page.getByTestId('workspace-review-artwork').waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await page.getByTestId('workspace-return-to-artwork').count(), 0, 'no comparison bar any more');
        assert.equal(
          await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
          true,
          'the same chat container',
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  const compareContrast = { values: {}, file: `${EVIDENCE}/contrast-media-compare.json` };
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `image candidate: the comparison and its decision read legibly and stay inside the window (${label})`,
      { timeout: 120_000 },
      async () => {
        const { context, page, errors } = await open({ width, dark });
        const slug = label.replaceAll(' ', '-');
        try {
          const focused = await openComparison(page);
          const compare = focused.getByRole('region', { name: '版本对比' });
          await compare.waitFor({ timeout: 20_000 });
          await compare.locator('img').first().waitFor({ state: 'attached' });
          await page.waitForFunction(
            () => [...document.querySelectorAll('section[aria-label="版本对比"] img')].every((image) => image.complete),
            undefined,
            { timeout: 20_000 },
          );
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `${label}: no horizontal overflow, got ${overflow}px`);
          // The way back to the artwork is on screen whatever the panel scrolled to.
          const back = await page.getByTestId('workspace-return-to-artwork').boundingBox();
          const windowHeight = page.viewportSize()?.height ?? 0;
          assert.ok(back && back.y >= 0 && back.y + back.height <= windowHeight, `${label}: the way back is in view`);
          // What the bar sits above must not hide behind it. At 390px the pane itself scrolls under the bar, and the
          // heading of the returned version (the first thing to read) is where the receipt's ask scrolls to.
          const headingLine = focused.locator('p').first();
          assert.match(
            (await headingLine.textContent()) ?? '',
            /^新版已返回/,
            `${label}: the first line is the heading`,
          );
          const heading = await headingLine.boundingBox();
          const bar = await page.getByTestId('workspace-return-to-artwork').locator('..').boundingBox();
          assert.ok(
            heading && bar && heading.y >= bar.y + bar.height - 0.5,
            `${label}: the heading of the returned version is not covered by the way-back bar (heading top ${heading?.y}, bar bottom ${bar ? bar.y + bar.height : 'none'})`,
          );
          // Every word the person has to read to decide: the heading, the modes, the explanation and both decisions.
          const words = focused.locator('p, button, label, figcaption, summary, output');
          let measured = 0;
          const unreadable = [];
          for (let index = 0; index < (await words.count()); index += 1) {
            const item = words.nth(index);
            // A control that is off (side by side needs a wider pane) is exempt from the contrast rule, as WCAG has it.
            if (!(await item.isVisible()) || (await item.isDisabled())) continue;
            const text = ((await item.textContent()) ?? '').trim();
            if (!text || (await item.locator('p, button, label, figcaption, summary, output').count()) > 0) continue;
            const ratio = await measureContrast(item, 'text-on-fill');
            compareContrast.values[`${label} | ${text}`] = Number(ratio.toFixed(2));
            if (ratio < 4.5) unreadable.push(`"${text}" ${ratio.toFixed(2)}:1`);
            measured += 1;
          }
          assert.deepEqual(unreadable, [], `${label}: words below 4.5:1`);
          assert.ok(measured >= 5, `${label}: measured ${measured} words`);
          await writeFile(compareContrast.file, `${JSON.stringify(compareContrast.values, null, 2)}\n`);
          await page.screenshot({ path: `${EVIDENCE}/media-compare-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }
}
