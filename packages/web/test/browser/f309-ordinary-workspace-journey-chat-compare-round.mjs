import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { EVIDENCE, measureContrast, openChatPage } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { IMAGE_FIXTURE, WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';

// Real Next shell, production CSS, the real ChatMessage, the real Workspace with its publication resolver, the real
// Task round surface and its K3 comparison; only the network is stubbed. The owner's answers (the request, the
// review with its two rounds, the pictures, the decision) are a fixture, so this proves how a version a cat returned
// for a Task round is compared and decided from the conversation and how the person gets back, not that a real cat
// produced it or that a real Task was decided.
const REQUEST_ID = `f309-modification-${'8'.repeat(64)}`;
const REVIEW_ID = `review-${'7'.repeat(64)}`;
// A sibling Task's review on the same work: it can hold the very same version, and the work remembers it.
const SIBLING_REVIEW_ID = `review-${'9'.repeat(64)}`;
const CANDIDATE_REF = 'candidate-round-2';
// The owner's real publication coordinate shape: the Workspace opens nothing else.
const CONTENT = `prepared-media:${'6'.repeat(64)}`;
const SENT_ID = 'human-round-request';
const RECEIPT_ID = 'host-receipt-round-candidate';
const NATIVE_ID = 'native-returned-round-image';
const STAMP = '2026-10-04T04:00:00Z';
const TASK_ID = 'task-round';

const ORIGINAL_BYTES = IMAGE_FIXTURE.bytes;
// A different, real PNG, so the two rounds can be told apart by eye in the evidence.
const CANDIDATE_BYTES = readFileSync(path.resolve(WEB_ROOT, '../../assets/avatars/codex.png'));
const dimensions = (bytes) => ({ kind: 'image', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
const roundAsset = (number, bytes) => ({
  contentRef: CONTENT,
  ownerRevision: number,
  blobDigest: `sha256:${String(number).repeat(64)}`,
  mediaType: 'image/png',
  media: dimensions(bytes),
  ownerReceiptRef: `owner:${number}`,
  sourcePublication: {
    artifactRef: `/uploads/${number}.png`,
    sourceRef: 'message:round-source',
    revision: String(number),
  },
});
const SOURCE = { kind: 'artifact-review', reviewId: REVIEW_ID, round: 1, expectedReviewRevision: 3 };
const TASK_CONTEXT = {
  kind: 'media',
  taskId: TASK_ID,
  expectedTaskRevision: 1,
  reviewId: REVIEW_ID,
  expectedReviewRevision: 3,
  round: 1,
};
const conversation = (length, timestamp) =>
  Array.from({ length }, (_, index) => ({
    from: { kind: 'user', userId: 'operator' },
    id: `round-${timestamp}-${index}`,
    type: 'user',
    content: `${timestamp === 0 ? '较早' : '之后'}的一条对话 ${index + 1}`,
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
        id: 'media-sent-round',
        kind: 'media',
        title: '秋日封面',
        mediaType: 'image/png',
        source: SOURCE,
        taskContext: TASK_CONTEXT,
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
      taskId: TASK_ID,
      state: 'candidate',
      candidateRef: CANDIDATE_REF,
      receiptRef: 'receipt-round-candidate',
      observedAt: 2,
      followUp: { kind: 'none', reason: 'not_applicable' },
    },
  },
};
const nativeMessage = {
  from: { kind: 'agent', catId: 'codex-terra' },
  id: NATIVE_ID,
  type: 'assistant',
  catId: 'codex-terra',
  content: '返回的原生图片',
  timestamp: 3,
  contentBlocks: [{ type: 'image', url: '/uploads/2.png' }],
};

const requestView = () => ({
  stage: 'queued',
  execution: { state: 'finished', messageId: 'carrier', targetCatId: 'codex-terra', observedAt: 3, evidenceRef: 'e' },
  // A Task round has no file: the owner sends no write-back for it.
  candidates: [
    {
      kind: 'media',
      candidateRef: CANDIDATE_REF,
      asset: roundAsset(2, CANDIDATE_BYTES),
      authorCatId: 'codex-terra',
      responses: [{ annotationId: 'place-1', disposition: 'addressed', explanation: '已按圈出的位置修改。' }],
    },
  ],
  acceptances: [],
  rejections: [],
  record: {
    requestId: REQUEST_ID,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {
      sourceMessageId: SENT_ID,
      sourceKind: 'human_message',
      prepared: { kind: 'media', contentRef: CONTENT, ownerRevision: 1 },
      review: { reviewId: REVIEW_ID, round: 1, receiptRef: 'bind-receipt' },
    },
    payload: {
      operationId: 'operation-round-request',
      targetCatId: 'codex-terra',
      threadId: 'execution-thread',
      intent: { body: '请处理这一处' },
      source: SOURCE,
      taskContext: TASK_CONTEXT,
    },
  },
});

/** The review as the owner reads it: the first round was answered, the second one is waiting for the person. */
const reviewView = (decision) => ({
  review: {
    version: 2,
    reviewId: REVIEW_ID,
    revision: decision ? 4 : 3,
    title: '秋日封面',
    contentRef: CONTENT,
    task: { taskId: TASK_ID, threadId: 'execution-thread', ownerUserId: 'operator', observedRevision: 1 },
    createdAt: STAMP,
    updatedAt: STAMP,
    rounds: [
      {
        number: 1,
        openedAt: STAMP,
        state: 'changes_requested',
        asset: roundAsset(1, ORIGINAL_BYTES),
        annotations: [],
        responses: [],
      },
      {
        number: 2,
        openedAt: STAMP,
        state: decision ? 'approved' : 'awaiting_human',
        asset: roundAsset(2, CANDIDATE_BYTES),
        annotations: [],
        responses: [],
        ...(decision
          ? {
              decision: {
                outcome: 'approved',
                explanation: decision,
                actor: { kind: 'human', actorId: 'operator' },
                decidedAt: STAMP,
                receiptRef: 'decision-receipt',
              },
            }
          : {}),
      },
    ],
  },
  authority: { state: 'current', canWrite: true, taskRevision: 1, ownerCatId: 'codex-terra' },
  pendingVersion: false,
  continuation: {
    taskId: TASK_ID,
    expectedRevision: 1,
    artifactRef: 'content:round-cover',
    reviewEvidenceRef: 'review:original',
    ownerCatId: 'codex-terra',
  },
});

/** The owner as the Workspace reads it; the decision changes what the next read says, as the real owner does. */
const ownContext = (round) => ({
  reviewId: REVIEW_ID,
  round,
  taskId: TASK_ID,
  threadId: 'execution-thread',
  title: '秋日封面',
  taskTitle: '处理封面',
  threadTitle: '修改说明',
  targetCatId: 'codex-terra',
  targetName: '小团团',
  state: 'awaiting_human',
  taskState: 'active',
});
const siblingContext = (round) => ({
  ...ownContext(round),
  reviewId: SIBLING_REVIEW_ID,
  taskId: 'task-sibling',
  title: '另一个任务里的同一件作品',
  taskTitle: '处理另一张封面',
});
/** Which of the work's reviews the owner reports for the returned version: only its own, or its sibling too. */
const WORK_REVIEWS = {
  own: (round) => [ownContext(round)],
  'sibling first': (round) => [siblingContext(round), ownContext(round)],
  'sibling only': (round) => [siblingContext(round)],
};

function ownerApi({ reviews = 'own' } = {}) {
  const state = { decision: null };
  return async (request, url, calls) => {
    const { pathname } = url;
    const method = request.method();
    if (pathname === '/api/content-publications/resolve')
      return { body: { status: 'resolved', ownerUserId: 'operator', asset: roundAsset(2, CANDIDATE_BYTES) } };
    if (pathname === `/api/content-publications/${CONTENT}`)
      return { body: { asset: roundAsset(2, CANDIDATE_BYTES), currentOwnerRevision: 2 } };
    if (pathname === `/api/content-publications/${CONTENT}/media/2` || pathname === '/uploads/2.png')
      return { raw: CANDIDATE_BYTES, contentType: 'image/png' };
    if (pathname === `/api/content-modifications/${REQUEST_ID}` && method === 'GET') {
      calls.push('GET request');
      return { body: requestView() };
    }
    if (pathname === '/api/content-modifications/context' && method === 'POST') {
      calls.push('POST context');
      return {
        body: {
          requests: [{ record: requestView().record, stage: 'queued' }],
          contexts: [
            {
              taskId: TASK_ID,
              title: '处理封面',
              targetCatId: 'codex-terra',
              threadId: 'execution-thread',
              targetName: '小团团',
              threadTitle: '修改说明',
              requestIds: [REQUEST_ID],
              state: 'active',
              taskContext: TASK_CONTEXT,
            },
          ],
          suggestedCatId: 'codex-terra',
        },
      };
    }
    if (pathname === '/api/content-reviews/resolve' && method === 'POST') {
      calls.push('POST resolve');
      const target = JSON.parse(request.postData() ?? '{}');
      calls.push(`resolve ${target.contentRef}@${target.ownerRevision}`);
      return { body: { ownerUserId: 'operator', contexts: WORK_REVIEWS[reviews](target.ownerRevision) } };
    }
    // The sibling's review is never the one this receipt asks for: reading it is recorded so a scene can say so.
    if (pathname === `/api/artifact-reviews/${SIBLING_REVIEW_ID}`) {
      calls.push('GET sibling review');
      return { body: { error: 'not_found' }, status: 404 };
    }
    if (pathname === `/api/artifact-reviews/${REVIEW_ID}` && method === 'GET') {
      calls.push('GET review');
      return { body: reviewView(state.decision) };
    }
    if (pathname === `/api/artifact-reviews/${REVIEW_ID}/media/1`)
      return { raw: ORIGINAL_BYTES, contentType: 'image/png' };
    if (pathname === `/api/artifact-reviews/${REVIEW_ID}/media/2`)
      return { raw: CANDIDATE_BYTES, contentType: 'image/png' };
    if (pathname === `/api/artifact-reviews/${REVIEW_ID}/actions` && method === 'POST') {
      const command = JSON.parse(request.postData() ?? '{}');
      calls.push(`POST ${command.action?.kind} ${command.action?.outcome ?? ''}`.trim());
      state.decision = command.action?.explanation ?? '已通过';
      return { body: { view: reviewView(state.decision) } };
    }
    return undefined;
  };
}

export function registerOrdinaryChatCompareRoundJourney(suite) {
  /** `later` is how much the person said after the receipt: the chat then opens with the receipt above the fold. */
  const open = async ({ later = 0, reviews, native = false, ...options } = {}) => {
    const opened = await openChatPage(native ? () => ({ ...suite(), baseUrl: `${suite().baseUrl}?shell=v2` }) : suite, {
      ...options,
      messages: [
        ...conversation(6, 0),
        sentMessage,
        receiptMessage,
        ...(native ? [nativeMessage] : []),
        ...conversation(later, 4),
      ],
      handleApi: ownerApi({ reviews }),
    });
    if (native) {
      await opened.page.route('**/uploads/2.png', (route) =>
        route.fulfill({ contentType: 'image/png', body: CANDIDATE_BYTES }),
      );
      await opened.page.reload({ waitUntil: 'domcontentloaded' });
      await opened.page.locator('[data-chat-container]').waitFor();
    }
    return opened;
  };
  /** The work's generic entry remembers a review the person chose earlier; a receipt must not be taken there. */
  const rememberReview = (page, reviewId) =>
    page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [`cat-cafe:content-context:operator:${CONTENT}`, reviewId],
    );
  const receiptLine = (page) => page.locator(`[data-message-id="${RECEIPT_ID}"] [data-testid="modification-progress"]`);
  /** The returned round, opened from the conversation: the Workspace resolves the work to its round and compares. */
  const openComparison = async (page, calls = []) => {
    await receiptLine(page).waitFor({ timeout: 20_000 });
    await page.evaluate(() => {
      window.__chatBeforeOpen = document.querySelector('[data-chat-container]');
    });
    await receiptLine(page).getByRole('button', { name: '打开对照' }).click();
    const compare = page.getByTestId('artifact-media-compare');
    try {
      await compare.waitFor({ state: 'visible', timeout: 40_000 });
    } catch (error) {
      // Say what the person would have seen, not just that something did not appear.
      await page.screenshot({ path: `${EVIDENCE}/round-compare-failure.png` }).catch(() => {});
      const shown = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      throw new Error(
        `the comparison did not open; calls=${JSON.stringify(calls)}; on screen: ${shown.replace(/\s+/g, ' ').slice(0, 900)}`,
        { cause: error },
      );
    }
    return compare;
  };
  const decodedPictures = (compare) =>
    compare
      .locator('img')
      .evaluateAll((images) => images.map((image) => ({ alt: image.alt, width: image.naturalWidth })));

  for (const [width, closeNative] of [
    [1440, false],
    [390, false],
    [1440, true],
  ])
    test(
      `task round: candidate comparison reenters after ${closeNative ? 'closing the native image tab' : 'the native image'} at ${width}px`,
      { timeout: 120_000 },
      async () => {
        const { context, page, calls, errors } = await open({ native: true, width, dark: width === 390 });
        try {
          const compare = await openComparison(page, calls);
          await compare.getByRole('button', { name: '返回作品', exact: true }).click();
          await page.getByRole('button', { name: '‹ 聊天', exact: true }).click();
          // Direct receipt reentry remains the working control.
          await openComparison(page, calls);
          await compare.getByRole('button', { name: '返回作品', exact: true }).click();
          await page.getByRole('button', { name: '‹ 聊天', exact: true }).click();
          await page
            .locator(`[data-message-id="${NATIVE_ID}"]`)
            .getByRole('button', { name: '打开作品 图片', exact: true })
            .click();
          const round = page.locator('[data-testid="artifact-review-surface"]:visible');
          await round.getByRole('button', { name: '对比版本', exact: true }).waitFor({ timeout: 20_000 });
          assert.equal(
            await page.locator('[data-testid="artifact-media-compare"]:visible').count(),
            0,
            'plain native entry shows the round',
          );
          if (closeNative) {
            await page.getByRole('button', { name: /^关闭 图片/ }).click();
          } else await round.getByRole('button', { name: '‹ 聊天', exact: true }).click();
          await receiptLine(page).getByRole('button', { name: '打开对照', exact: true }).click();
          await page.getByTestId('artifact-media-compare').waitFor({ state: 'visible', timeout: 10_000 });
          assert.equal(
            await page.locator('[data-testid="artifact-media-compare"]:visible').count(),
            1,
            'one visible comparison without an extra click',
          );
          assert.equal(
            await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
            true,
          );
          await page.screenshot({ path: `${EVIDENCE}/round-reentry-${width}${closeNative ? '-closed' : ''}.png` });
          assert.deepEqual(errors, []);
          assert.deepEqual(
            calls.filter((call) => call.startsWith('POST') && !['POST resolve', 'POST context'].includes(call)),
            [],
          );
        } catch (error) {
          await page.screenshot({
            path: `${EVIDENCE}/round-reentry-${width}${closeNative ? '-closed' : ''}-failed.png`,
          });
          await writeFile(
            `${EVIDENCE}/round-reentry-${width}${closeNative ? '-closed' : ''}-failed.json`,
            JSON.stringify(
              {
                error: String(error),
                calls,
                errors,
                rounds: await page.locator('[data-testid="artifact-review-surface"]').evaluateAll((items) =>
                  items.map((el) => ({
                    visible: el.getBoundingClientRect().width > 0,
                    comparison: Boolean(el.querySelector('[data-testid="artifact-media-compare"]')),
                  })),
                ),
              },
              null,
              2,
            ),
          );
          throw error;
        } finally {
          await context.close();
        }
      },
    );

  test(
    'task round: the receipt opens the work at the returned round and goes straight to the comparison, the chat untouched',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open();
      try {
        const compare = await openComparison(page, calls);
        // The owner was asked for the returned version's own coordinates, and resolved them to the round that holds it.
        assert.ok(calls.includes(`resolve ${CONTENT}@2`), `the returned version was resolved: ${calls}`);
        // Both rounds are on screen as real, decoded pictures.
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('[data-testid="artifact-media-compare"] img')].every(
              (image) => image.complete,
            ),
          undefined,
          { timeout: 20_000 },
        );
        const pictures = await decodedPictures(compare);
        assert.equal(pictures.length, 2, `two versions: ${JSON.stringify(pictures)}`);
        assert.ok(
          pictures.every((item) => item.width > 0),
          `both decode: ${JSON.stringify(pictures)}`,
        );
        // The decision is in front of the person, not behind a scroll inside a scroll.
        const approve = page.getByRole('button', { name: '通过此版本', exact: true });
        await approve.waitFor({ state: 'visible' });
        const reachable = await approve.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const x = box.x + box.width / 2;
          return [box.y + 3, box.y + box.height - 3].every((y) => {
            const hit = document.elementFromPoint(x, y);
            return hit instanceof Element && button.contains(hit);
          });
        });
        assert.equal(reachable, true, 'the approve button is fully in front of the person');
        // Looking at the comparison writes nothing.
        assert.deepEqual(
          calls.filter((call) => call.startsWith('POST') && call !== 'POST context' && call !== 'POST resolve'),
          [],
          'no write while looking',
        );
        assert.equal(
          await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
          true,
          'the same chat container',
        );
        await page.screenshot({ path: `${EVIDENCE}/round-compare-opened-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'task round: approving this version goes through the review once and says so',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open();
      try {
        const compare = await openComparison(page, calls);
        await compare.getByRole('textbox', { name: '审阅结论说明' }).fill('这版可以，就用它。');
        await compare.getByRole('button', { name: '通过此版本', exact: true }).click();
        await compare.getByTestId('review-round-decision').waitFor({ timeout: 20_000 });
        assert.match((await compare.getByTestId('review-round-decision').textContent()) ?? '', /这版通过/);
        assert.equal(calls.filter((call) => call === 'POST decide approved').length, 1, 'one decision');
        assert.equal(await compare.getByRole('button', { name: '通过此版本', exact: true }).count(), 0, 'decided');
        // Deciding does not take the pictures away: both versions are still there, decoded, and the shown one is visible.
        await page.waitForFunction(
          () => {
            const images = [...document.querySelectorAll('[data-testid="artifact-media-compare"] img')];
            return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
          },
          undefined,
          { timeout: 15_000 },
        );
        const shown = await compare.locator('img:visible').count();
        assert.ok(shown >= 1, `a version stays on screen after the decision, ${shown} shown`);
        assert.equal(
          await page.evaluate(() => window.__chatBeforeOpen === document.querySelector('[data-chat-container]')),
          true,
          'the same chat container',
        );
        // The compare repaints after the review updates; a frame taken in that instant shows the picture's area empty,
        // although the version is decoded and in place (measured). The evidence frame is taken once it has settled.
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${EVIDENCE}/round-compare-approved-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'task round: returning to the source brings the receipt it was opened from back in front of the person',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open({ later: 40 });
      try {
        const compare = await openComparison(page, calls);
        const receiptInChat = (id) => {
          const element = document.querySelector(`[data-message-id="${id}"]`);
          const chat = document.querySelector('[data-chat-container]');
          if (!element || !chat) return false;
          const box = element.getBoundingClientRect();
          const view = chat.getBoundingClientRect();
          return box.bottom > view.top && box.top < view.bottom;
        };
        await page.evaluate(() => {
          const chat = document.querySelector('[data-chat-container]');
          chat.scrollTop = chat.scrollHeight;
          chat.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate(receiptInChat, RECEIPT_ID), false, 'the receipt starts out of sight');
        await compare.getByRole('button', { name: '返回作品', exact: true }).click();
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
    'task round: a work that belongs to a sibling Task too, remembered as the sibling, still opens the receipt own review',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open({ reviews: 'sibling first' });
      try {
        await receiptLine(page).waitFor({ timeout: 20_000 });
        await rememberReview(page, SIBLING_REVIEW_ID);
        const compare = await openComparison(page, calls);
        // The title the owner gives each review tells them apart on screen: this is the receipt's own.
        assert.match((await page.getByTestId('artifact-review-surface').textContent()) ?? '', /秋日封面/);
        assert.doesNotMatch((await page.locator('body').innerText()) ?? '', /另一个任务里的同一件作品/);
        assert.equal(calls.includes('GET sibling review'), false, "the sibling's review is never entered");
        assert.ok(calls.includes('GET review'), "the receipt's own review was read");
        assert.equal(await compare.getByRole('button', { name: '通过此版本', exact: true }).count(), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'task round: when the receipt own review no longer holds the version it says so in place and enters no sibling',
    { timeout: 120_000 },
    async () => {
      const { context, page, calls, errors } = await open({ reviews: 'sibling only' });
      try {
        await receiptLine(page).waitFor({ timeout: 20_000 });
        await rememberReview(page, SIBLING_REVIEW_ID);
        await receiptLine(page).getByRole('button', { name: '打开对照' }).click();
        const notice = page.getByRole('alert').filter({ hasText: '这份修改所属的审阅当前不可访问' });
        await notice.waitFor({ state: 'visible', timeout: 40_000 });
        assert.match((await notice.textContent()) ?? '', /没有改去打开这件作品的其他任务审阅/);
        const noticeRatio = await measureContrast(notice, 'text-on-fill');
        assert.ok(noticeRatio >= 4.5, `the notice reads at ${noticeRatio.toFixed(2)}:1`);
        assert.equal(await page.getByTestId('artifact-media-compare').count(), 0, 'no comparison');
        assert.equal(await page.getByTestId('artifact-review-surface').count(), 0, 'no review surface at all');
        assert.equal(calls.includes('GET sibling review'), false, "the sibling's review is never entered");
        assert.equal(await page.getByRole('combobox', { name: '作品讨论上下文' }).count(), 0, 'no sibling to choose');
        await page.screenshot({ path: `${EVIDENCE}/round-compare-review-not-held-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  const roundContrast = { values: {}, file: `${EVIDENCE}/contrast-round-compare.json` };
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `task round: the comparison and its decision read legibly and stay inside the window (${label})`,
      { timeout: 120_000 },
      async () => {
        const { context, page, calls, errors } = await open({ width, dark });
        const slug = label.replaceAll(' ', '-');
        try {
          const compare = await openComparison(page, calls);
          await page.waitForFunction(
            () =>
              [...document.querySelectorAll('[data-testid="artifact-media-compare"] img')].every(
                (image) => image.complete,
              ),
            undefined,
            { timeout: 20_000 },
          );
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `${label}: no horizontal overflow, got ${overflow}px`);
          const windowHeight = page.viewportSize()?.height ?? 0;
          // Comparison returns through the work's original source action.
          const back = compare.getByRole('button', { name: '返回作品', exact: true });
          const backBox = await back.boundingBox();
          assert.ok(
            backBox && backBox.y >= 0 && backBox.y + backBox.height <= windowHeight,
            `${label}: 返回作品 is in view`,
          );
          const words = compare.locator('p, button, label, figcaption, summary, output, h3, span, select');
          let measured = 0;
          const unreadable = [];
          for (let index = 0; index < (await words.count()); index += 1) {
            const item = words.nth(index);
            if (!(await item.isVisible()) || (await item.isDisabled().catch(() => false))) continue;
            const text = ((await item.textContent()) ?? '').trim();
            if (
              !text ||
              (await item.locator('p, button, label, figcaption, summary, output, h3, span, select').count()) > 0
            )
              continue;
            const ratio = await measureContrast(item, 'text-on-fill');
            roundContrast.values[`${label} | ${text.slice(0, 40)}`] = Number(ratio.toFixed(2));
            if (ratio < 4.5) unreadable.push(`"${text.slice(0, 40)}" ${ratio.toFixed(2)}:1`);
            measured += 1;
          }
          assert.deepEqual(unreadable, [], `${label}: words below 4.5:1`);
          assert.ok(measured >= 5, `${label}: measured ${measured} words`);
          await writeFile(roundContrast.file, `${JSON.stringify(roundContrast.values, null, 2)}\n`);
          await page.screenshot({ path: `${EVIDENCE}/round-compare-${slug}.png` });
          await back.click();
          const source = page.getByRole('button', { name: '‹ 聊天', exact: true });
          const sourceBox = await source.boundingBox();
          assert.ok(
            sourceBox && sourceBox.y >= 0 && sourceBox.y + sourceBox.height <= windowHeight,
            `${label}: the original conversation return is in view after leaving comparison`,
          );
          await source.click();
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }
}
