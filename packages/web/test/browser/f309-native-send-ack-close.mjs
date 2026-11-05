import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startComposerWorkspaceOwner } from './f309-composer-workspace-owner.mjs';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';

const TEXT = '仅发送一次\n原正文与中文说明';
const NEXT_TEXT = '发送期间刚打的新草稿\n必须保留';
const QUOTE = {
  v: 1,
  id: 'native-ack-quote',
  kind: 'quote',
  text: 'bookShelf',
  comment: '中文绿灯\n原引用仍在',
  source: { kind: 'workspace_file', path: 'docs/native-ack.md', revision: `sha256:${'a'.repeat(64)}` },
};
export function registerNativeSendAckCloseJourneys(beforeNative) {
  describe('native composer ACK-close', () => {
    let directory;
    let owner;
    let suite;

    before(async () => {
      await beforeNative();
      directory = await mkdtemp(path.join(tmpdir(), 'f309-native-ack-'));
      if (process.env.F309_NATIVE_ACK_EVIDENCE) await mkdir(process.env.F309_NATIVE_ACK_EVIDENCE, { recursive: true });
      const requireApi = createRequire(fileURLToPath(new URL('../../../api/package.json', import.meta.url)));
      owner = await startComposerWorkspaceOwner(path.join(directory, 'data'), {
        configure: async ({ app, draftStore }) => {
          await app.register(requireApi('@fastify/cors'), { origin: true, credentials: true });
          const { sendMessageSchema, buildMessageContentBlocks } = await import(
            '../../../api/dist/routes/messages.schema.js'
          );
          const { captureSentComposerDraftConsumption } = await import(
            '../../../api/dist/routes/sent-composer-draft-consumption.js'
          );
          const sent = [];
          const { InvocationQueue } = await import(
            '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js'
          );
          const queue = new InvocationQueue();
          app.get('/api/messages', () => ({
            messages: draftStore.getByThread(THREAD_ID, 50, 'operator'),
            hasMore: false,
          }));
          // This fixture commits a real private Human message but never starts a model or Queue execution.
          app.post('/api/messages', async (request) => {
            const body = sendMessageSchema.parse(request.body);
            const consume = await captureSentComposerDraftConsumption(
              draftStore,
              'operator',
              THREAD_ID,
              body.composerDraftRevision,
            );
            const from = { kind: 'user', userId: 'operator' };
            const admitted = await queue.send(
              draftStore,
              {
                userId: 'operator',
                threadId: THREAD_ID,
                from,
                mentions: ['codex-terra'],
                deliveryStatus: 'queued',
                idempotencyKey: body.idempotencyKey,
                timestamp: Date.now(),
                content: body.content,
                contentBlocks: buildMessageContentBlocks(body.content, body.contextAttachments),
              },
              {
                userId: 'operator',
                threadId: THREAD_ID,
                from,
                kind: 'conversation_input',
                content: body.content,
                targetCats: ['codex-terra'],
                intent: 'execute',
                ownerAuthProvenance: 'strict',
              },
            );
            assert.equal(admitted.outcome, 'enqueued');
            const message = admitted.message;
            sent.push({ request: body, stored: message, at: Date.now() });
            return {
              status: 'queued',
              userMessageId: message.id,
              userMessage: { id: message.id, timestamp: message.timestamp, contentBlocks: message.contentBlocks },
              ...(await consume(message)),
            };
          });
          return {
            sent,
            seed: () =>
              draftStore.putOwnerComposerDraft('operator', THREAD_ID, {
                expectedRevision: draftStore.getOwnerComposerDraft('operator', THREAD_ID)?.revision ?? 0,
                text: TEXT,
                contentBlocks: [{ type: 'context_attachment', attachment: QUOTE }],
                updatedAt: Date.now(),
              }),
          };
        },
      });
      suite = await startF309OrdinaryWorkspaceJourney({ apiUrl: owner.api });
    });

    after(async () => {
      await stopF309OrdinaryWorkspaceJourney(suite);
      await owner?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function shell(context) {
      const state = createReviewState();
      // Draft and message requests, including OPTIONS, never match a Playwright route.
      await context.route(
        new RegExp(`/api/(?!messages(?:[/?]|$)|threads/${THREAD_ID}/composer-draft(?:[/?]|$))`),
        async (route) => {
          if (new URL(route.request().url()).pathname === '/api/session') {
            return route.fulfill({ json: { userId: 'operator', csrfToken: 'private-native-csrf' } });
          }
          return fulfillFixtureApi(route, state, []);
        },
      );
    }

    for (const [label, width, dark, gateJson, newTyping] of [
      ['1440-light', 1440, false, false],
      ['390-dark', 390, true, false],
      ['1440-light-ack-consumption-pending', 1440, false, true],
      ['390-dark-ack-consumption-pending', 390, true, true],
      ['390-dark-new-typing', 390, true, true, true],
    ]) {
      test(
        `native composer: accepted send then quote-tag-hide close retains the clear ${label}`,
        { timeout: 120000 },
        async () => {
          const seeded = owner.seed();
          assert.equal(seeded.kind, 'updated');
          const start = owner.sent.length;
          const draftStart = owner.draftRequests.length;
          const context = await suite.browser.newContext({ viewport: { width, height: 900 } });
          const events = [];
          context.on('request', (request) => {
            if (/\/api\/(messages$|threads\/.*\/composer-draft$)/.test(new URL(request.url()).pathname)) {
              events.push({ event: 'request', method: request.method(), url: request.url(), at: Date.now() });
            }
          });
          if (dark) await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
          await context.addInitScript((gate) => {
            let released = false;
            window.addEventListener('f309-release-message-ack', () => {
              released = true;
            });
            const json = Response.prototype.json;
            Response.prototype.json = async function () {
              const value = await json.call(this);
              if (new URL(this.url, location.href).pathname === '/api/messages' && !Array.isArray(value.messages)) {
                console.debug(
                  'f309-native-ack:',
                  JSON.stringify({ event: 'client-ack-json', gated: gate, at: Date.now() }),
                );
                // Controlled scheduling probe: transport and stored acceptance remain native;
                // only delivery of the parsed ACK to application code is held until page exit.
                if (gate && !released)
                  await new Promise((resolve) => {
                    window.addEventListener('pagehide', resolve, { once: true });
                    window.addEventListener('f309-release-message-ack', resolve, { once: true });
                  });
              }
              return value;
            };
            window.addEventListener('pagehide', () => {
              console.debug('f309-native-ack:', JSON.stringify({ event: 'pagehide', at: Date.now() }));
            });
          }, gateJson);
          await shell(context);
          let cold;
          let page;
          try {
            page = await context.newPage();
            page.on('pageerror', (error) => events.push({ event: 'pageerror', error: String(error), at: Date.now() }));
            page.on('console', (message) => {
              if (message.text().startsWith('f309-native-ack: ')) events.push(JSON.parse(message.text().slice(17)));
            });
            await page.goto(`${suite.baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(
              (text) => document.querySelector('textarea[aria-label="消息输入框"]')?.value === text,
              TEXT,
            );
            await page.getByTestId('context-file-quote-tag').waitFor();
            const send = page.getByRole('button', { name: /^(发送消息|Send message)$/ });
            await send.waitFor();
            const [ack] = await Promise.all([
              page.waitForResponse(
                (item) => new URL(item.url()).pathname === '/api/messages' && item.request().method() === 'POST',
              ),
              send.click(),
            ]);
            assert.equal(ack.status(), 200);
            const ackBody = await ack.json();
            events.push({ event: 'http-ack', body: ackBody, at: Date.now() });
            await page.getByTestId('context-file-quote-tag').waitFor({ state: 'hidden' });
            if (newTyping) {
              await page.getByLabel('消息输入框').fill(NEXT_TEXT);
              // This separate preservation control observes the new edit's write. The four close counterexamples do not.
              const saved = page.waitForResponse(
                (item) =>
                  item.request().method() === 'PUT' &&
                  new URL(item.url()).pathname.endsWith('/composer-draft') &&
                  item.request().postDataJSON().text === NEXT_TEXT,
              );
              await page.evaluate(() => window.dispatchEvent(new Event('f309-release-message-ack')));
              assert.equal((await saved).status(), 200);
            }
            events.push({ event: 'quote-tag-hidden-close', at: Date.now() });
            await context.close();
            events.push({ event: 'closed', at: Date.now() });
            assert.equal(owner.sent.length - start, 1);
            assert.equal(owner.sent.at(-1).request.composerDraftRevision, seeded.draft.revision);
            assert.deepEqual(owner.sent.at(-1).request.contextAttachments, [QUOTE]);
            cold = await suite.browser.newContext({ viewport: { width, height: 900 } });
            if (dark) await cold.addInitScript(() => localStorage.setItem('theme', 'dark'));
            await shell(cold);
            const reopened = await cold.newPage();
            const hydration = reopened.waitForResponse(
              (item) => new URL(item.url()).pathname.endsWith('/composer-draft') && item.request().method() === 'GET',
            );
            await reopened.goto(`${suite.baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
            const hydrationResponse = await hydration;
            assert.equal(hydrationResponse.status(), 200, 'cold owner hydration must succeed');
            const first = await hydrationResponse.json();
            const evidence = process.env.F309_NATIVE_ACK_EVIDENCE ?? directory;
            await writeFile(
              path.join(evidence, `${label}.json`),
              JSON.stringify({
                events,
                first,
                hydrationStatus: hydrationResponse.status(),
                previewUrl: reopened.url(),
                viewport: { width, height: 900 },
                coldThemeRequested: dark ? 'dark' : 'light',
                owner: owner.readDraft(),
                sent: owner.sent.slice(start),
                draftRequests: owner.draftRequests.slice(draftStart),
              }),
            );
            assert.equal(first.draft?.ownerUserId, 'operator');
            assert.equal(first.draft?.threadId, THREAD_ID);
            assert.equal(first.draft?.revision, first.revision);
            assert.ok(Number.isSafeInteger(first.revision));
            const expectedText = newTyping ? NEXT_TEXT : '';
            assert.equal(first.draft.text, expectedText, 'first native owner hydration preserves only the new draft');
            assert.deepEqual(first.draft?.contentBlocks ?? [], []);
            await reopened.waitForFunction(
              (text) => document.querySelector('textarea[aria-label="消息输入框"]')?.value === text,
              expectedText,
            );
            assert.equal(await reopened.getByTestId('context-file-quote-tag').count(), 0);
            if (dark)
              await reopened.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
            await reopened.screenshot({ path: path.join(evidence, `${label}-cold-open.png`) });
          } catch (error) {
            const evidence = process.env.F309_NATIVE_ACK_EVIDENCE;
            if (evidence) {
              if (page && !page.isClosed()) {
                events.push({ event: 'visible-ui', text: await page.locator('body').innerText(), at: Date.now() });
                await page.screenshot({ path: path.join(evidence, `${label}-failure.png`) });
              }
              await writeFile(
                path.join(evidence, `${label}-failure.json`),
                JSON.stringify({
                  error: String(error),
                  events,
                  owner: owner.readDraft(),
                  sent: owner.sent.slice(start),
                  draftRequests: owner.draftRequests.slice(draftStart),
                }),
              );
            }
            throw error;
          } finally {
            await cold?.close();
            await context.close();
          }
        },
      );
    }
  });
}
