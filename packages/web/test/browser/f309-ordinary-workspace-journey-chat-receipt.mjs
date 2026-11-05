import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';
import { assertReadable, EVIDENCE, openChatPage } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, WORKTREE_ID } from './f309-ordinary-workspace-journey-fixture.mjs';

// Real Next shell, production CSS and the real ChatMessage; only the network is stubbed. The receipts are the
// system messages the server stores for a content modification (userId system, no cat, replyTo the person's
// message), so this proves how they read in the conversation, not that a real cat produced them.
const REQUEST_ID = `f309-modification-${'d'.repeat(64)}`;
const RAW = (state) =>
  [
    '[Host 作品修改回执]',
    '候选修改已返回，可打开对照后决定。原文件尚未因此改变。',
    `requestId: ${REQUEST_ID}`,
    'candidateRef: candidate-secret',
    `receiptRef: receipt-secret-${state}`,
    '这是系统投影，不是新的修改授权；打开后以当前请求详情为准。',
  ].join('\n');

const STATES = [
  { state: 'candidate', title: '提交了修改', detail: '原文件尚未因此改变。', action: '打开对照', dot: 'neutral' },
  { state: 'rejected', title: '未采用', detail: '修改和讨论已保留，原文件未变。', action: '打开对照', dot: 'neutral' },
  { state: 'applied', title: '已写回', detail: '修改已采用并写回原文件。', action: '打开文件', dot: 'success' },
  {
    state: 'conflict',
    title: '未写回：原文件已更改',
    detail: '修改已保留，未覆盖原文件。',
    action: '打开对照',
    dot: 'attention',
  },
  // The two media verdicts hand a decision back to the original task: no write-back, no wake, comparison not file.
  {
    state: 'approved',
    title: '已通过',
    detail: '结论已交还原任务；不代表任务完成，也没有写回文件。',
    action: '打开对照',
    dot: 'success',
  },
  {
    state: 'changes_requested',
    title: '已要求修改',
    detail: '已交还原任务；修改和讨论已保留。',
    action: '打开对照',
    dot: 'neutral',
  },
  {
    state: 'unknown',
    title: '写回结果未确认',
    detail: '修改已保留，请核对原文件。',
    action: '打开文件',
    dot: 'attention',
  },
];

const HUMAN = {
  from: { kind: 'user', userId: 'operator' },
  id: 'human-source',
  type: 'user',
  content: '请把第二段改得更短。',
  timestamp: 1,
};
const receiptMessages = STATES.map(({ state }, index) => ({
  from: { kind: 'system', service: 'content-modification' },
  id: `host-receipt-${state}`,
  type: 'system',
  catId: null,
  content: RAW(state),
  replyTo: 'human-source',
  timestamp: 2 + index,
  extra: {
    systemKind: 'content_modification_receipt',
    contentModificationReceiptV1: {
      v: 1,
      requestId: REQUEST_ID,
      sourceMessageId: 'human-source',
      targetCatId: 'codex-terra',
      taskId: 'task-1',
      state,
      ...(state === 'unknown' ? {} : { candidateRef: 'candidate-secret' }),
      receiptRef: `receipt-secret-${state}`,
      observedAt: 2 + index,
      followUp: { kind: 'none', reason: 'not_applicable' },
    },
  },
}));

/** What the named cat returned: text proposals. The journey fixture's file is a PNG, so this exercises the real
 * Workspace routing and panel, not the media comparison (that arrives with the media receipts). Several earlier
 * candidates come first so the named one starts well below the fold of the modification panel: the person is only
 * taken to it if it is actually scrolled into view. */
const CANDIDATE_REF = 'candidate-secret';
const REPLACEMENT = '改后的第二段';
const textCandidate = (ref, replacement) => ({
  kind: 'text',
  candidateRef: ref,
  proposal: {
    proposalRef: ref,
    requestId: REQUEST_ID,
    revision: 1,
    operationId: `operation-${ref}`,
    baseRevision: SOURCE_REVISION,
    resultRevision: `sha256:${'b'.repeat(64)}`,
    edits: [{ start: 0, end: 3, expectedText: '原文', replacement }],
    response: `已把第二段改短（${ref}）`,
    authorCatId: 'codex-terra',
    createdAt: 10,
    receiptRef: `receipt-${ref}`,
  },
});
const candidates = [
  ...[1, 2, 3, 4, 5, 6].map((n) => textCandidate(`candidate-earlier-${n}`, `较早的版本 ${n}`)),
  textCandidate(CANDIDATE_REF, REPLACEMENT),
];
/** The request the receipt points at: a file this chat can open, named by its durable F063 root. */
const requestView = () => ({
  stage: 'queued',
  candidates,
  acceptances: [],
  record: {
    requestId: REQUEST_ID,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: { sourceMessageId: 'human-source' },
    payload: {
      operationId: 'operation-request',
      targetCatId: 'codex-terra',
      threadId: 'execution-thread',
      intent: { body: '请把第二段改得更短。' },
      source: {
        kind: 'workspace',
        locator: { worktreeId: canonicalWorktreeId(WORKTREE_ID), path: 'art/cover.png' },
        expectedSourceRevision: SOURCE_REVISION,
        reviewId: REVIEW_ID,
        expectedReviewRevision: 1,
      },
    },
  },
});

export function registerOrdinaryChatReceiptJourney(suite) {
  const open = (options) =>
    openChatPage(suite, {
      ...options,
      messages: [HUMAN, ...receiptMessages],
      handleApi: async (request, url, calls) => {
        if (url.pathname === `/api/content-modifications/${REQUEST_ID}`) {
          calls.push(request.method());
          return { body: requestView() };
        }
        // The workspace panel lists the requests made on the open file; the receipt's request is the one.
        if (url.pathname === '/api/content-modifications/context' && request.method() === 'POST')
          return {
            body: {
              requests: [requestView()],
              contexts: [
                {
                  taskId: 'task-1',
                  title: '把第二段改短',
                  targetCatId: 'codex-terra',
                  threadId: 'execution-thread',
                  targetName: '小团团',
                  threadTitle: '修改说明',
                  completionRule: 'file-writeback-applied',
                  requestIds: [REQUEST_ID],
                  state: 'active',
                  taskContext: { kind: 'text', taskId: 'task-1', expectedTaskRevision: 1 },
                },
              ],
              suggestedCatId: 'codex-terra',
            },
          };
        // Production resolves a durable root id to itself; the shared fixture only knows the alias.
        if (url.pathname === '/api/workspace/resolve-file-source' && request.method() === 'POST') {
          const body = JSON.parse(request.postData() ?? '{}');
          return { body: { worktreeId: body.worktreeId, path: body.path, kind: 'file' } };
        }
        return undefined;
      },
    });

  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `Host receipts read as one plain line each in the accepted wording, legible on the real surface (${label})`,
      { timeout: 90_000 },
      async () => {
        const { context, page, errors } = await open({ width, dark });
        const slug = label.replaceAll(' ', '-');
        try {
          const rows = page.getByTestId('modification-progress');
          await rows.first().waitFor({ timeout: 20_000 });
          assert.equal(await rows.count(), STATES.length, 'one line per receipt');
          for (const [index, expected] of STATES.entries()) {
            const row = rows.nth(index);
            assert.equal(await row.getAttribute('data-state'), `receipt_${expected.state}`);
            const text = (await row.textContent()) ?? '';
            assert.ok(text.includes(expected.title), `${expected.state}: "${expected.title}" in "${text}"`);
            assert.ok(text.includes(expected.detail), `${expected.state}: "${expected.detail}" in "${text}"`);
            assert.ok(
              (await row.locator(`[data-indicator="${expected.dot}"]`).count()) === 1,
              `${expected.state} uses the ${expected.dot} dot`,
            );
            assert.equal(await row.getByRole('button', { name: expected.action }).count(), 1);
            await assertReadable(row, `${label} ${expected.state}`);
            // The action stays next to the words it opens instead of at the far edge of a wide chat column.
            const box = await row.boundingBox();
            assert.ok(box && box.width <= 460, `${expected.state}: the line is ${box?.width}px wide, over 460px`);
          }
          // The stored text carries the request, candidate and receipt coordinates; none of it reaches the reader.
          const page_text = (await page.locator('[data-chat-container]').textContent()) ?? '';
          assert.doesNotMatch(
            page_text,
            /requestId|candidateRef|receiptRef|candidate-secret|receipt-secret|f309-modification|Host 作品修改回执/,
          );
          // Each receipt is a centred Host line, never the right-aligned bubble of the person's own message.
          const alignments = await page.evaluate(() =>
            [...document.querySelectorAll('[data-message-id^="host-receipt-"]')].map(
              (node) => getComputedStyle(node).justifyContent,
            ),
          );
          assert.deepEqual(
            alignments,
            STATES.map(() => 'center'),
          );
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `no horizontal overflow, got ${overflow}px`);
          await page.locator('[data-chat-container]').screenshot({ path: `${EVIDENCE}/receipts-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'a receipt reads the request only when asked, then shows the candidate it names in the Workspace',
    { timeout: 90_000 },
    async () => {
      const { context, page, calls } = await open({});
      try {
        const candidateLine = page.getByTestId('modification-progress').first();
        await candidateLine.waitFor({ timeout: 20_000 });
        assert.deepEqual(calls, [], 'nothing is read while the receipts are only on screen');
        await candidateLine.getByRole('button', { name: '打开对照' }).click();
        await page.getByTestId('workspace-content-review-surface').waitFor({ timeout: 30_000 });
        // Opening the file is not enough: the receipt's own candidate has to be on screen, marked as the one asked for.
        const focused = page.locator('[data-testid="content-modification-result"][data-focused="true"]');
        await focused.waitFor({ state: 'visible', timeout: 30_000 });
        assert.equal(await focused.getAttribute('data-candidate-ref'), CANDIDATE_REF);
        const text = (await focused.textContent()) ?? '';
        assert.ok(text.includes(REPLACEMENT), `the candidate's own change is shown: "${text}"`);
        assert.ok(calls.length >= 1, 'the request was read once the reader asked');
        // It starts below the fold (six earlier candidates), so being on screen means it was really scrolled into view
        // of the container that scrolls it, not merely rendered somewhere in a long panel.
        const geometry = await focused.evaluate((element) => {
          const target = element.getBoundingClientRect();
          let parent = element.parentElement;
          while (parent) {
            const style = getComputedStyle(parent);
            if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) {
              const container = parent.getBoundingClientRect();
              return {
                scroller: 'container',
                scrollTop: parent.scrollTop,
                top: target.top - container.top,
                height: target.height,
                containerHeight: container.height,
                x: target.left,
                width: target.width,
              };
            }
            parent = parent.parentElement;
          }
          return {
            scroller: 'window',
            scrollTop: window.scrollY,
            top: target.top,
            height: target.height,
            containerHeight: window.innerHeight,
            x: target.left,
            width: target.width,
          };
        });
        assert.ok(geometry.scrollTop > 0, `the named candidate was scrolled to, got ${JSON.stringify(geometry)}`);
        assert.ok(
          geometry.top >= -1 && geometry.top < geometry.containerHeight - 8,
          `the named candidate starts inside its scroller, got ${JSON.stringify(geometry)}`,
        );
        const viewport = page.viewportSize();
        assert.ok(
          viewport && geometry.x >= 0 && geometry.x + geometry.width <= viewport.width + 1,
          'inside the window',
        );
        await page.screenshot({ path: `${EVIDENCE}/receipt-opened-candidate.png` });
      } finally {
        await context.close();
      }
    },
  );
}
