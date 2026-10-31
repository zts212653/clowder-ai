import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createCatId } from '@cat-cafe/shared';
import { validateCompanionReply } from '@clowder-ai/plugin-contract-beta28';
import { createCompanionClient } from '@clowder-ai/plugin-sdk-beta24/companion';
import { PUBLISHED_COMPANION_LETTER } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { FilePluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { modernCompanionInstallFixture } from './helpers/f317-companion-install-fixture.js';

test('the installed letter package and registry SDK traverse original draft, exact retry, history and body through Host', async (t) => {
  const f = await modernCompanionInstallFixture(t, '0.1.0-alpha.25');
  f.app.post('/api/concierge/thread', async () => ({ threadId: 'home' }));
  f.app.get('/api/threads/home', async () => ({ title: 'Letter home' }));
  let requests = 0;
  let executions = 0;
  let loseReceipt = true;
  f.app.post('/api/messages', async (request, reply) => {
    const body = request.body as { content: string; threadId: string; idempotencyKey: string };
    requests++;
    assert.equal(body.threadId, 'home');
    const result = f.messages.appendIdempotent({
      userId: 'modern-composition-owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'modern-composition-owner' },
      content: body.content,
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: body.idempotencyKey,
    });
    if (!result.idempotent) executions++;
    if (loseReceipt) {
      loseReceipt = false;
      return reply.code(503).send({ error: 'lost owner admission response' });
    }
    return { status: result.idempotent ? 'duplicate' : 'queued', userMessageId: result.message.id };
  });
  const makeClient = () =>
    createCompanionClient({
      request: async (command) => {
        assert.ok(f.launch.request);
        const reply = await f.launch.request(command);
        assert.ok(validateCompanionReply(reply), JSON.stringify(reply));
        return reply;
      },
      subscribe: () => () => {},
    });
  for (let i = 0; i < 40; i++)
    f.messages.append({
      userId: 'modern-composition-owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'modern-composition-owner' },
      content: `Older ${i}`,
      mentions: [],
      timestamp: i + 2,
    });
  const first = makeClient();
  f.config.ballSize = 43;
  const settings = await first.readSettings();
  assert.equal(settings.status, 'available');
  if (settings.status === 'available')
    assert.equal(settings.values.ballSize, 43, 'new ABI preserves the saved compact size');
  const initial = await first.readConversationDraft();
  assert.equal(initial.status, 'available');
  if (initial.status !== 'available') return;
  const saved = await first.saveConversationDraft(initial.revision, 'Letter A', initial.scopeRef);
  assert.equal(saved.status, 'available');
  if (saved.status !== 'available') return;
  const clientMessageId = randomUUID();
  const unknown = await first.submitConversationText('Letter A', clientMessageId, saved.revision, saved.scopeRef);
  assert.equal(unknown.delivery, 'unconfirmed');
  const client = makeClient();
  const recovered = await client.readConversationDraft();
  assert.equal(recovered.status, 'available');
  if (recovered.status !== 'available') return;
  assert.equal(recovered.submissions.length, 1);
  assert.equal(recovered.submissions[0]?.receipt.delivery, 'unconfirmed');
  assert.equal((await client.readConversationDelivery(clientMessageId, saved.scopeRef)).delivery, 'unconfirmed');
  assert.equal(requests, 1, 'SDK recreation and receipt reads never resend');
  const accepted = await client.submitConversationText('Letter A', clientMessageId, saved.revision, saved.scopeRef);
  assert.equal(accepted.delivery, 'accepted');
  if (accepted.delivery !== 'accepted') return;
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  assert.equal((await client.readConversationDelivery(clientMessageId, saved.scopeRef)).delivery, 'accepted');
  await assert.rejects(client.submitConversationText('Changed', clientMessageId, saved.revision, saved.scopeRef));
  await assert.rejects(client.submitConversationText('Letter A', randomUUID(), saved.revision, 'foreign-scope'));
  assert.equal(requests, 2);
  const text = `${'x'.repeat(15_999)}🐾${'y'.repeat(5000)}`;
  const answer = f.messages.append({
    userId: 'modern-composition-owner',
    threadId: 'home',
    from: { kind: 'agent', catId: createCatId('codex61-sol') },
    content: text,
    mentions: [],
    timestamp: Date.now() + 1,
    lifecycle: {
      kind: 'response',
      orderKey: 'reply',
      invocationId: 'inv',
      targetId: 'codex61-sol',
      inputEntryIds: ['entry'],
      inputMessageIds: [accepted.messageId],
      status: 'processing',
      startedAt: Date.now(),
    },
  });
  const page = await client.readConversationPage({ limit: 2 });
  assert.equal(page.status, 'available');
  if (page.status !== 'available') return;
  const row = page.messages.find((row) => row.id === answer.id);
  assert.ok(row);
  assert.deepEqual(row.inputMessageIds, [accepted.messageId]);
  assert.equal(row.responsePhase, 'processing');
  assert.equal(row.body.complete, false);
  let body = row.body;
  let full = row.text;
  while (!body.complete) {
    const next = await client.readConversationBody(body.continuation);
    assert.equal(next.status, 'available');
    if (next.status !== 'available') return;
    full += next.text;
    body = next.body;
  }
  assert.equal(full, text);
  assert.equal(
    page.messages.find((row) => row.id === accepted.messageId)?.deliveryReceipt?.messageId,
    accepted.messageId,
  );
  assert.equal(page.hasMoreOlder, true);
  assert.ok(page.olderCursor);
  const older = await client.readConversationPage({ before: page.olderCursor });
  assert.equal(older.status, 'available');
  if (older.status === 'available')
    assert.ok(older.messages.every((row) => !page.messages.some((prior) => prior.id === row.id)));
  assert.ok(answer.lifecycle?.kind === 'response');
  answer.lifecycle.status = 'completed';
  answer.lifecycle.completedAt = Date.now();
  const completed = await client.readConversationPage();
  assert.equal(completed.status, 'available');
  if (completed.status === 'available')
    assert.equal(completed.messages.find((row) => row.id === answer.id)?.responsePhase, 'completed');
  const inventory = await new FilePluginInventoryStore(f.runtime.paths.inventorySnapshotPath).snapshot();
  const installed = inventory.packages.find(
    (p) => p.pluginId === 'official.companion' && p.version === '0.1.0-alpha.25',
  );
  assert.ok(installed);
  if (f.actualArchive) {
    assert.equal(installed.packageDigest, PUBLISHED_COMPANION_LETTER.packageDigest);
    assert.equal((await fetch(f.launch.url)).status, 200);
    const stateSource = await (await fetch(new URL('reply-letter-state.mjs', f.launch.url))).text();
    assert.match(stateSource, /selectReplyPresentation/);
  }
  await client.disableCompanion();
  await assert.rejects(client.readConversationDraft());
  assert.equal(f.closes(), 1);
});

test('registry package bytes remain the admission authority after a content-preserving recompression', async (t) => {
  if (!process.env.F317_VERIFIED_LETTER_ARCHIVE) return;
  await assert.rejects(
    modernCompanionInstallFixture(t, '0.1.0-alpha.25', (bytes) => gzipSync(gunzipSync(bytes), { level: 1 })),
    /bytes do not match the official catalog digest/,
  );
});
