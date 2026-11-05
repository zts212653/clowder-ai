import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalWorktreeId } from './f307-real-surface-fixtures.mjs';
import { openWorkspaceTools } from './f307-workspace-open.mjs';
import { registerWholeImageChatJourney } from './f309-image-chat-primary.mjs';
import {
  assertFitsViewport,
  assertReadable,
  EVIDENCE,
  measureContrast,
  openChatPage,
} from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { REVIEW_ID, SOURCE_REVISION, THREAD_ID, WORKTREE_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { modelProjection } from './f309-ordinary-workspace-journey-text-quote.mjs';

// Real Next shell, production CSS, the real composer and the real artwork surface; the network is the journey
// fixture and the send is intercepted (nothing reaches a cat). The sent body is then run through the API's own send
// schema and prompt projection, so what is proven is what a cat would be handed for the places the person circled,
// not that a cat acted on them.
const TEXT_MIN_CONTRAST = 4.5;
const CHIP = '[data-testid="context-attachment-list"] [data-context-kind="media"]';
const MARKS = '[data-testid="review-pending-chat-mark"]';

const SEEDED = (id) => ({
  v: 1,
  id,
  kind: 'media',
  title: '窄屏设计稿.png',
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'wt-seeded', path: 'art/cover.png' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'review-seeded',
    expectedReviewRevision: 1,
  },
  selections: [
    {
      id: '1',
      selection: { kind: 'image-region', x: 411, y: 622, width: 733, height: 144 },
      instruction: '移除这里的字，其余保持不变',
    },
    { id: '2', selection: { kind: 'image-point', x: 987, y: 654 } },
  ],
});

// A sent image message whose request a cat took over. The owner's answers are a fixture: this proves how the line
// is joined, looks and behaves under the message, not that a real cat is working.
const REQUEST_ID = `f309-modification-${'e'.repeat(64)}`;
const DECOY_ID = `f309-modification-${'f'.repeat(64)}`;
const SENT_ID = 'human-media-sent';
const sentMessage = (timestamp = 1) => ({
  from: { kind: 'user', userId: 'operator' },
  id: SENT_ID,
  type: 'user',
  content: '这两处帮我处理一下',
  timestamp,
  contentBlocks: [
    { type: 'text', text: '这两处帮我处理一下' },
    { type: 'context_attachment', attachment: SEEDED('media-sent') },
  ],
});
const requestRecord = (requestId, messageId, sourceKind = 'human_message') => ({
  requestId,
  ownerUserId: 'operator',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  progress: { sourceMessageId: messageId, sourceKind },
  payload: { targetCatId: 'codex-sol', threadId: 'execution-thread' },
});
function requestDetail({ revision = 1, execution, cancelled = false } = {}) {
  return {
    stage: 'queued',
    candidates: [],
    acceptances: [],
    execution: execution
      ? { state: execution, messageId: 'carrier', targetCatId: 'codex-sol', observedAt: 1, evidenceRef: 'evidence' }
      : undefined,
    record: {
      ...requestRecord(REQUEST_ID, SENT_ID),
      revision,
      control: cancelled
        ? {
            state: 'cancelled',
            actorId: 'operator',
            cancelledAt: 1,
            receiptRef: 'receipt',
            taskResolution: 'preserved',
          }
        : undefined,
    },
  };
}
/**
 * The owner as the chat reads it: the context catalogue (one request that really came from this message, one that
 * came from another message) and the request itself. Every call is recorded for the assertions.
 */
function ownerApi({ taken = () => true, respond }) {
  return async (request, url, calls) => {
    if (url.pathname === '/api/content-modifications/context' && request.method() === 'POST') {
      calls.push(`context ${JSON.stringify(request.postDataJSON().source)}`);
      return {
        body: {
          requests: taken()
            ? [
                { record: requestRecord(REQUEST_ID, SENT_ID), stage: 'queued' },
                { record: requestRecord(DECOY_ID, 'human-other-message'), stage: 'queued' },
              ]
            : [{ record: requestRecord(DECOY_ID, 'human-other-message'), stage: 'queued' }],
          contexts: [{ requestIds: [REQUEST_ID], targetName: '烁烁' }],
        },
      };
    }
    if (url.pathname.startsWith(`/api/content-modifications/${DECOY_ID}`)) {
      calls.push(`DECOY ${request.method()}`);
      return { body: { error: 'not_found' }, status: 404 };
    }
    if (url.pathname.startsWith(`/api/content-modifications/${REQUEST_ID}`)) {
      calls.push(`${request.method()} ${url.pathname.slice(`/api/content-modifications/${REQUEST_ID}`.length)}`);
      return respond(request.method(), url.pathname);
    }
    return undefined;
  };
}

async function assertFits(page, locator, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal overflow, got ${overflow}px`);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    box && box.x >= 0 && box.x + box.width <= viewport.width + 1,
    `${label}: inside the window ${JSON.stringify(box)}`,
  );
}

/** Every word of the attachment (title, detail, number, label, instruction) is legible where it really sits. */
async function assertLegible(root, label, measured) {
  const spans = root.locator('span');
  let seen = 0;
  for (let index = 0; index < (await spans.count()); index += 1) {
    const item = spans.nth(index);
    const text = ((await item.textContent()) ?? '').trim();
    if (!text || (await item.locator('span').count()) > 0) continue;
    const ratio = await measureContrast(item, 'text');
    measured[`${label} | ${text}`] = Number(ratio.toFixed(2));
    assert.ok(ratio >= TEXT_MIN_CONTRAST, `${label}: "${text}" is ${ratio.toFixed(2)}:1, below ${TEXT_MIN_CONTRAST}:1`);
    seen += 1;
  }
  assert.ok(seen >= 4, `${label}: measured ${seen} words, expected the title, detail and each place`);
}

export function registerOrdinaryChatMediaJourney(suite) {
  async function openWork({ shell, ...options } = {}) {
    const sent = [];
    const chosenSuite = shell ? () => ({ ...suite(), baseUrl: `${suite().baseUrl}?shell=${shell}` }) : suite;
    const opened = await openChatPage(chosenSuite, {
      ...options,
      messages: [],
      handleApi: async (request, url) => {
        if (url.pathname === '/api/messages' && request.method() === 'POST') {
          sent.push(request.postDataJSON());
          return { body: { status: 'queued' } };
        }
        return undefined;
      },
    });
    const { page } = opened;
    const home = await openWorkspaceTools(page);
    await home.getByTestId('workspace-launcher-search').fill('cover');
    await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
    await page.getByTestId('workspace-content-review-media').waitFor({ timeout: 30_000 });
    return { ...opened, sent };
  }
  registerWholeImageChatJourney(openWork);

  test(
    'image canvas: exact sent work shows its original request and cancels without changing the composer',
    { timeout: 90_000 },
    async () => {
      let cancelled = false;
      const message = sentMessage();
      message.contentBlocks[1].attachment.source = {
        kind: 'workspace',
        locator: { worktreeId: canonicalWorktreeId(WORKTREE_ID), path: 'art/cover.png' },
        expectedSourceRevision: SOURCE_REVISION,
        reviewId: REVIEW_ID,
        expectedReviewRevision: 1,
      };
      const untaken = {
        ...structuredClone(message),
        id: 'human-media-untaken-later',
        timestamp: message.timestamp + 1,
      };
      const { context, page, calls, errors } = await openChatPage(
        () => ({ ...suite(), baseUrl: `${suite().baseUrl}?shell=v2` }),
        {
          messages: [message, untaken],
          handleApi: ownerApi({
            respond: (method, path) => {
              if (method === 'POST' && path.endsWith('/cancel')) cancelled = true;
              return { body: requestDetail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }) };
            },
          }),
        },
      );
      try {
        await page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]').waitFor();
        const composer = page.getByLabel('消息输入框');
        await composer.fill('另一个尚未发送的想法\n不要替我发送');
        await page.waitForFunction(
          (id) =>
            new Map(JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts') ?? '[]')).get(id) ===
            '另一个尚未发送的想法\n不要替我发送',
          THREAD_ID,
        );
        const home = await openWorkspaceTools(page);
        await home.getByTestId('workspace-launcher-search').fill('cover');
        await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
        const progress = page.getByTestId('image-work-progress').getByTestId('modification-progress');
        await progress.waitFor();
        assert.equal(await progress.getAttribute('data-state'), 'working');
        assert.equal(await progress.count(), 1, 'later untaken same-work B cannot conceal real request A');
        await page.getByRole('button', { name: '画笔', exact: true }).click();
        await page.getByRole('button', { name: '形状', exact: true }).click();
        await page.getByRole('button', { name: '矩形', exact: true }).click();
        const stage = await page.getByTestId('review-markup-layer').boundingBox();
        assert.ok(stage);
        await page.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(stage.x + stage.width * 0.35, stage.y + stage.height * 0.35, { steps: 4 });
        await page.mouse.up();
        await page.getByTestId('review-local-mark').waitFor();
        const refreshed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/content-modifications/context' &&
            response.request().postDataJSON().source.expectedReviewRevision === 2,
        );
        await page.getByRole('button', { name: '完成并保存', exact: true }).click();
        await page.getByTestId('review-saved-markup-layer').waitFor();
        await refreshed;
        assert.equal(
          await progress.getAttribute('data-state'),
          'working',
          'review-only advance retains the original executing request',
        );
        await page.screenshot({ path: `${EVIDENCE}/r1-image-work-progress.png` });
        await writeFile(
          `${EVIDENCE}/r1-image-work-progress.json`,
          JSON.stringify(
            {
              url: page.url(),
              activeMessageId: message.id,
              untakenMessageId: untaken.id,
              requestId: REQUEST_ID,
              source: message.contentBlocks[1].attachment.source,
              contextReads: calls.filter((call) => call.startsWith('context ')),
              errors,
            },
            null,
            2,
          ),
        );
        assert.ok(!calls.some((call) => call.startsWith('DECOY')), 'another Human request is never read');
        assert.equal(await page.getByTestId('workspace-content-review-surface').locator('textarea').count(), 0);
        await progress.getByRole('button', { name: '取消修改', exact: true }).click();
        await page.getByTestId('image-work-progress').locator('[data-state="cancelled_still_running"]').waitFor();
        assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
        assert.equal(await composer.inputValue(), '另一个尚未发送的想法\n不要替我发送');
        await page.screenshot({ path: `${EVIDENCE}/studio297-canvas-request-cancelled.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  const numbers = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));

  test(
    'image: circled places go into the one chat composer as numbered chips, and leave in one send',
    { timeout: 120_000 },
    async () => {
      const { context, page, errors, sent } = await openWork();
      try {
        // The accepted canvas sends regions straight into the one existing Chat composer.
        await page.getByRole('button', { name: '圈选', exact: true }).click();
        const box = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(box);
        for (const [x, y] of [
          [0.15, 0.2],
          [0.5, 0.6],
        ]) {
          await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * (x + 0.2), box.y + box.height * (y + 0.15));
          await page.mouse.up();
        }
        const chip = page.locator(CHIP);
        await chip.waitFor({ timeout: 15_000 });
        assert.equal(sent.length, 0, 'adding is not sending');
        assert.equal(await page.getByTestId('workspace-content-review-surface').locator('textarea').count(), 0);

        // One chip, two numbered places in the order they were added, and the same numbers on the picture.
        assert.equal(await page.locator(CHIP).count(), 1, 'one media attachment for one work');
        assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1', '2']);
        assert.deepEqual(await numbers(page.locator(`${MARKS} text`)), ['1', '2']);
        await page.screenshot({ path: `${EVIDENCE}/media-chat-composer-1440.png` });

        // Taking the first place away renumbers what the person sees, never what is sent: the survivor keeps id "2".
        await page.getByRole('button', { name: '移除选区 1', exact: true }).click();
        await page.waitForFunction(
          (selector) => document.querySelectorAll(selector).length === 1,
          `${CHIP} [data-selection-id]`,
        );
        assert.equal(await page.locator(`${CHIP} [data-selection-id]`).getAttribute('data-selection-id'), '2');
        assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1']);
        assert.deepEqual(await numbers(page.locator(`${MARKS} text`)), ['1']);
        assert.equal(await page.locator(MARKS).getAttribute('data-selection-id'), '2');
        assert.ok(((await chip.textContent()) ?? '').includes('图片 · 1处选区'));

        await page.getByLabel('消息输入框').fill('请处理这一处');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
        assert.equal(sent.length, 1);
        assert.equal(await page.locator(MARKS).count(), 0, 'the marks go with the chip');

        const [body] = sent;
        assert.equal(body.content, '请处理这一处');
        assert.equal(body.contextAttachments.length, 1);
        const [media] = body.contextAttachments;
        assert.equal(media.kind, 'media');
        assert.equal(media.mediaType, 'image/png');
        assert.equal(media.source.kind, 'workspace');
        assert.equal(media.source.locator.path, 'art/cover.png');
        assert.equal(media.source.expectedSourceRevision, SOURCE_REVISION);
        assert.equal(media.source.reviewId, REVIEW_ID);
        assert.equal(media.selections.length, 1);
        assert.equal(media.selections[0].id, '2', 'stable id: not renumbered after the first place was removed');
        assert.equal(media.selections[0].selection.kind, 'image-region');
        assert.ok(!('instruction' in media.selections[0]), 'the removed place took its words with it');
        // The real send schema and prompt projection hand the cat exactly what was sent.
        const prompt = await modelProjection(body);
        const projected = JSON.parse(
          prompt.slice(prompt.indexOf('<context_attachments>') + 21, prompt.lastIndexOf('<')),
        );
        assert.deepEqual(projected, body.contextAttachments);

        // Queue admission alone must not manufacture History. The four delivered-History
        // cases below verify the exact same attachment's readable message projection.
        const sentChip = page.locator('[data-chat-container] [data-context-kind="media"]');
        assert.equal(await sentChip.count(), 0, 'a pending source has no optimistic History bubble');
        assert.doesNotMatch(
          await page.locator('[data-chat-container]').innerText(),
          /image-region|sha256|review-|expectedSource/,
        );
        await page.screenshot({ path: `${EVIDENCE}/media-chat-admitted-1440.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  const measured = {};
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `image: the places read legibly in the composer chip and in the sent message (${label})`,
      { timeout: 90_000 },
      async () => {
        const slug = label.replaceAll(' ', '-');
        const message = {
          from: { kind: 'user', userId: 'operator' },
          id: 'human-media',
          type: 'user',
          content: '这两处帮我处理一下',
          timestamp: 1,
          contentBlocks: [
            { type: 'text', text: '这两处帮我处理一下' },
            { type: 'context_attachment', attachment: SEEDED('media-sent') },
          ],
        };
        const { context, page, errors } = await openChatPage(suite, {
          width,
          dark,
          messages: [message],
          sessionStorage: {
            'cat-cafe:thread-context-attachment-drafts': JSON.stringify([[THREAD_ID, [SEEDED('media-draft')]]]),
          },
        });
        try {
          const chip = page.locator(CHIP);
          await chip.waitFor({ timeout: 20_000 });
          const sentChip = page.locator('[data-message-id="human-media"] [data-context-kind="media"]');
          await sentChip.waitFor();
          assert.deepEqual(await numbers(page.locator(`${CHIP} [data-testid="media-selection-number"]`)), ['1', '2']);
          assert.deepEqual(await numbers(sentChip.locator('[data-testid="media-selection-number"]')), ['1', '2']);
          // Where the person can still take a place away, and where they cannot.
          assert.equal(await chip.getByRole('button', { name: '移除选区 1', exact: true }).count(), 1);
          assert.equal(await sentChip.getByRole('button').count(), 0);
          assert.ok(((await sentChip.textContent()) ?? '').includes('移除这里的字，其余保持不变'));
          assert.doesNotMatch(
            `${await chip.textContent()}${await sentChip.textContent()}`,
            /411|622|733|144|987|654|image-region|image-point|sha256|review-seeded/,
          );
          await assertFits(page, chip, `${label} composer chip`);
          await assertFits(page, sentChip, `${label} sent attachment`);
          await assertLegible(chip, `${label} composer chip`, measured);
          await assertLegible(sentChip, `${label} sent attachment`, measured);
          await writeFile(`${EVIDENCE}/contrast-media-chat.json`, `${JSON.stringify(measured, null, 2)}\n`);
          await page.screenshot({ path: `${EVIDENCE}/media-chat-chips-${slug}.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  const requestContrast = { values: {}, file: `${EVIDENCE}/contrast-media-request.json` };
  const bubbleOf = (page) => page.locator(`[data-message-id="${SENT_ID}"]`);
  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `image message: the request a cat took over shows live progress under it and cancels in place (${label})`,
      { timeout: 90_000 },
      async () => {
        let cancelled = false;
        const { context, page, calls, errors } = await openChatPage(suite, {
          width,
          dark,
          messages: [sentMessage()],
          handleApi: ownerApi({
            respond: (method, path) => {
              if (method === 'POST' && path.endsWith('/cancel')) {
                cancelled = true;
                return { body: requestDetail({ revision: 2, execution: 'running', cancelled: true }) };
              }
              return { body: requestDetail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }) };
            },
          }),
        });
        const slug = label.replaceAll(' ', '-');
        try {
          const bubble = bubbleOf(page);
          const row = bubble.getByTestId('modification-progress');
          await row.waitFor({ timeout: 20_000 });
          // Only the request that really came from this message: the other message's request is never read.
          assert.equal(await page.getByTestId('modification-progress').count(), 1);
          assert.ok(!calls.some((call) => call.startsWith('DECOY')), `the other message's request was read: ${calls}`);
          const asked = calls.find((call) => call.startsWith('context '));
          assert.ok(asked, `the owner was asked about the work: ${calls}`);
          assert.deepEqual(JSON.parse(asked.slice('context '.length)), SEEDED('x').source);
          assert.equal(await row.getAttribute('data-state'), 'working');
          assert.match(await row.locator('output').textContent(), /修改中 · 窄屏设计稿\.png 2\u00A0处/);
          // The person's own message stays theirs: nothing was written onto it.
          assert.equal(await bubble.getByTestId('content-modification-source').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} working`, requestContrast);
          const cancel = row.getByRole('button', { name: '取消修改' });
          assert.equal(await cancel.textContent(), '取消');
          await bubble.screenshot({ path: `${EVIDENCE}/media-request-working-${slug}.png` });

          await cancel.click();
          await bubble.locator('[data-testid="modification-progress"][data-state="cancelled_still_running"]').waitFor();
          assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'cancel is sent exactly once');
          assert.match(await row.textContent(), /修改已取消，执行仍在进行/);
          assert.match(await row.textContent(), /取消修改不会停止本轮执行。/);
          // No stop control is drawn until a stop handler exists.
          assert.equal(await row.getByRole('button').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} cancelled-still-running`, requestContrast);
          await bubble.screenshot({ path: `${EVIDENCE}/media-request-cancelled-${slug}.png` });
          if (width === 1440 && !dark) await page.screenshot({ path: `${EVIDENCE}/media-request-host-1440.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'image message: a takeover whose event was missed is found by the bounded look while the page is open, then the look stops',
    { timeout: 90_000 },
    async () => {
      let taken = false;
      const { context, page, calls, errors } = await openChatPage(suite, {
        messages: [sentMessage(Date.now())],
        handleApi: ownerApi({ taken: () => taken, respond: () => ({ body: requestDetail({ execution: 'running' }) }) }),
      });
      const until = async (condition, what, ms = 25_000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 200)))
          if (condition()) return;
        assert.fail(`timed out waiting for ${what}`);
      };
      try {
        const bubble = bubbleOf(page);
        await bubble.waitFor({ timeout: 20_000 });
        await until(() => calls.some((call) => call.startsWith('context ')), 'the first read of the owner');
        // Nothing is true to say yet, so nothing is drawn.
        assert.equal(await bubble.getByTestId('modification-progress').count(), 0);
        taken = true;
        await bubble.getByTestId('modification-progress').waitFor({ timeout: 25_000 });
        assert.equal(await bubble.getByTestId('modification-progress').getAttribute('data-state'), 'working');
        // The owner holds one request per message: once it is found nothing more is discovered, and the request's own
        // line keeps reading its own state. (This scene has no socket, so it exercises the fallback, not the event.)
        const contextReads = () => calls.filter((call) => call.startsWith('context ')).length;
        const reads = contextReads();
        await new Promise((done) => setTimeout(done, 9_000));
        assert.equal(contextReads(), reads, 'the look for a takeover stops once the request is found');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );
}
