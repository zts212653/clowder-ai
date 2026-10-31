import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertFitsViewport,
  assertReadable,
  EVIDENCE,
  openChatPage,
} from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';

// Real Next shell, production CSS and the real ChatMessage; the network is the journey fixture. The version the sent
// places name is the real `sha256:` of the real fixture file on disk, but the owner's answers (which message has a
// request, and how far it is) are a fixture: this proves how the line is joined to the message, looks and behaves,
// not that a real cat is working, and not the owner's by-message route (that has its own API test).
const FILE_NAME = 'f309-text-quote-journey.md';
const FILE_PATH = `packages/web/test/browser/fixtures/${FILE_NAME}`;
const REQUEST_ID = `f309-modification-${'a'.repeat(64)}`;
const SENT_ID = 'human-text-sent';
const UNTAKEN_ID = 'human-text-untaken';
const OLD_ID = 'human-text-old-quote';

async function fileRevision() {
  const bytes = await readFile(path.resolve(WEB_ROOT, '../..', FILE_PATH));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const quote = (id, revision, from, to) => ({
  v: 1,
  id,
  kind: 'quote',
  text: `${from}${to}`,
  selectionStart: from.length,
  selectionEnd: from.length + to.length,
  source: {
    kind: 'workspace_file',
    path: FILE_PATH,
    worktreeId: 'f063_root_v1_journey',
    language: 'markdown',
    ...(revision ? { revision } : {}),
  },
});
const textMessage = (id, attachments, timestamp = 1) => ({
  from: { kind: 'user', userId: 'operator' },
  id,
  type: 'user',
  content: '这几处帮我改一下',
  timestamp,
  contentBlocks: [
    { type: 'text', text: '这几处帮我改一下' },
    ...attachments.map((attachment) => ({ type: 'context_attachment', attachment })),
  ],
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
      requestId: REQUEST_ID,
      ownerUserId: 'operator',
      revision,
      createdAt: 1,
      updatedAt: 1,
      progress: { sourceMessageId: SENT_ID, sourceKind: 'human_message' },
      payload: { targetCatId: 'codex-sol', threadId: 'execution-thread' },
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
 * The owner as the chat reads it for a text request: the request of a message, asked by the message's own id (404 for
 * every message nobody took over), and the request by its own id. Every call is recorded for the assertions.
 */
function ownerApi({ taken = () => true, respond }) {
  return async (request, url, calls) => {
    const byMessage = /^\/api\/content-modifications\/by-message\/([^/]+)$/.exec(url.pathname);
    if (byMessage) {
      const messageId = decodeURIComponent(byMessage[1]);
      calls.push(`by-message ${messageId}`);
      if (messageId !== SENT_ID || !taken()) return { body: { error: 'not_found' }, status: 404 };
      return respond('GET', `/api/content-modifications/${REQUEST_ID}`);
    }
    if (url.pathname.startsWith(`/api/content-modifications/${REQUEST_ID}`)) {
      calls.push(`${request.method()} ${url.pathname.slice(`/api/content-modifications/${REQUEST_ID}`.length)}`);
      return respond(request.method(), url.pathname);
    }
    if (url.pathname.startsWith('/api/content-modifications/')) {
      calls.push(`UNEXPECTED ${request.method()} ${url.pathname}`);
      return { body: { error: 'not_found' }, status: 404 };
    }
    return undefined;
  };
}

export function registerOrdinaryChatTextRequestJourney(suite) {
  const contrast = { values: {}, file: `${EVIDENCE}/contrast-text-request.json` };
  const bubbleOf = (page, id = SENT_ID) => page.locator(`[data-message-id="${id}"]`);
  const sentPlaces = async () => {
    const revision = await fileRevision();
    return textMessage(SENT_ID, [
      quote('q1', revision, '暮色里的灯塔', ''),
      quote('q2', revision, '', 'salt on the window'),
    ]);
  };

  for (const [label, width, dark] of [
    ['desktop light', 1440, false],
    ['desktop dark', 1440, true],
    ['390px light', 390, false],
    ['390px dark', 390, true],
  ]) {
    test(
      `text message: the request a cat took over shows live progress under it and cancels in place (${label})`,
      { timeout: 90_000 },
      async () => {
        let cancelled = false;
        const revision = await fileRevision();
        const { context, page, calls, errors } = await openChatPage(suite, {
          width,
          dark,
          messages: [
            await sentPlaces(),
            textMessage(UNTAKEN_ID, [quote('q3', revision, 'a', 'b')], 2),
            textMessage(OLD_ID, [quote('q4', undefined, 'c', 'd')], 3),
          ],
          handleApi: ownerApi({
            respond: (method, requestPath) => {
              if (method === 'POST' && requestPath.endsWith('/cancel')) {
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
          // Only the message that was taken over has a line; the others were asked about (or, with no version, not
          // at all, because nobody can take such a quote over) and say nothing.
          assert.equal(await page.getByTestId('modification-progress').count(), 1);
          assert.ok(calls.includes(`by-message ${SENT_ID}`), `the owner was asked by the message: ${calls}`);
          assert.ok(calls.includes(`by-message ${UNTAKEN_ID}`), `the untaken message was asked about: ${calls}`);
          assert.ok(!calls.includes(`by-message ${OLD_ID}`), `a quote with no version is never asked about: ${calls}`);
          assert.ok(!calls.some((call) => call.startsWith('UNEXPECTED')), `no other owner read: ${calls}`);
          assert.equal(await row.getAttribute('data-state'), 'working');
          assert.match(await row.locator('output').textContent(), /修改中 · f309-text-quote-journey\.md 2 处/);
          // The person's own message stays theirs: nothing was written onto it.
          assert.equal(await bubble.getByTestId('content-modification-source').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} working`, contrast);
          const cancel = row.getByRole('button', { name: '取消修改' });
          assert.equal(await cancel.textContent(), '取消');
          await bubble.screenshot({ path: `${EVIDENCE}/text-request-working-${slug}.png` });

          await cancel.click();
          await bubble.locator('[data-testid="modification-progress"][data-state="cancelled_still_running"]').waitFor();
          assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1, 'cancel is sent exactly once');
          assert.match(await row.textContent(), /修改已取消，执行仍在进行/);
          assert.match(await row.textContent(), /取消修改不会停止本轮执行。/);
          assert.equal(await row.getByRole('button').count(), 0);
          await assertFitsViewport(page, row);
          await assertReadable(row, `${label} cancelled-still-running`, contrast);
          await bubble.screenshot({ path: `${EVIDENCE}/text-request-cancelled-${slug}.png` });
          if (width === 1440 && !dark) await page.screenshot({ path: `${EVIDENCE}/text-request-host-1440.png` });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      },
    );
  }

  test(
    'text message: a takeover whose event was missed is found by the bounded look while the page is open, then the look stops',
    { timeout: 90_000 },
    async () => {
      let taken = false;
      const fresh = { ...(await sentPlaces()), timestamp: Date.now() };
      const { context, page, calls, errors } = await openChatPage(suite, {
        messages: [fresh],
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
        await until(() => calls.includes(`by-message ${SENT_ID}`), 'the first read of the owner');
        // Nothing is true to say yet, so nothing is drawn.
        assert.equal(await bubble.getByTestId('modification-progress').count(), 0);
        taken = true;
        await bubble.getByTestId('modification-progress').waitFor({ timeout: 25_000 });
        assert.equal(await bubble.getByTestId('modification-progress').getAttribute('data-state'), 'working');
        // The owner holds one request per message: once found nothing more is discovered, and the request's own line
        // keeps reading its own state. (This scene has no socket, so it exercises the fallback, not the event.)
        const reads = () => calls.filter((call) => call.startsWith('by-message')).length;
        const before = reads();
        await new Promise((done) => setTimeout(done, 9_000));
        assert.equal(reads(), before, 'the look for a takeover stops once the request is found');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'text message: a viewer who cannot read the request sees only their own message',
    { timeout: 60_000 },
    async () => {
      const { context, page, calls } = await openChatPage(suite, {
        messages: [await sentPlaces()],
        handleApi: async (request, url, recorded) => {
          if (!url.pathname.startsWith('/api/content-modifications/')) return undefined;
          recorded.push(`${request.method()} ${url.pathname}`);
          return { body: { error: 'access_denied' }, status: 403 };
        },
      });
      try {
        await bubbleOf(page).waitFor({ timeout: 20_000 });
        await new Promise((done) => setTimeout(done, 5_000));
        assert.equal(await page.getByTestId('modification-progress').count(), 0);
        assert.equal(calls.length, 1, `refused once, then not asked again: ${calls}`);
      } finally {
        await context.close();
      }
    },
  );
}
