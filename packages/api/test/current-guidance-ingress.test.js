import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { saveMessageDispositionPreference } from '../dist/config/user-preferences-store.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

// Real callback -> common admission -> automatic drain -> durable append and
// Queue/History reads. Only the provider is controlled; no runtime/model call.
test('published A2A guidance reaches the current turn through HTTP despite an older hidden input', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'current-guidance-ingress-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
  let processor;
  const failures = [];
  const calls = [];
  let privateEntry;
  const f = await appendRecoveryFixture(
    async (input) => {
      calls.push(input.messageIds);
      return { accepted: true, handle: {} };
    },
    {
      projectRoot,
      messageDisposition: 'next_work',
      onAdmitted: ({ threadId }) => {
        if (processor) void processor.requestDrain(threadId).catch((error) => failures.push(error));
      },
      beforeAdmission: async ({ queue }) => {
        privateEntry = (
          await queue.enqueueDurable({
            kind: 'private_input',
            threadId: 'thread',
            userId: 'owner',
            sourceId: 'older-private',
            from: { kind: 'system', service: 'test-future-work' },
            ownerAuthProvenance: 'strict',
            content: 'next-turn work',
            targetCats: ['opus'],
            intent: 'execute',
            autoExecute: true,
          })
        ).entry;
      },
    },
  );
  processor = f.processor;
  t.after(() => f.invocationTracker.cancelAll('thread', 'owner', 'test_cleanup'));
  const app = Fastify();
  t.after(() => app.close());
  const registry = new InvocationRegistry();
  const threadStore = { get: async (id) => ({ id, createdBy: 'owner', participants: ['codex', 'opus'] }) };
  const socketManager = { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} };
  const invocationRecordStore = new InvocationRecordStore();
  await app.register(callbacksRoutes, {
    registry,
    threadStore,
    messageStore: f.messageStore,
    invocationQueue: f.queue,
    invocationTracker: f.invocationTracker,
    queueProcessor: processor,
    invocationRecordStore,
    socketManager,
    router: { resolveExplicitTargets: async (targets) => targets },
  });
  await app.register(queueRoutes, {
    threadStore,
    messageStore: f.messageStore,
    invocationQueue: f.queue,
    invocationTracker: f.invocationTracker,
    queueProcessor: processor,
    invocationRecordStore,
    socketManager,
  });
  const auth = await registry.create('owner', 'codex', 'thread');
  const post = () =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: 'thread',
        targetCats: ['opus'],
        content: 'Please finish safely now.',
        clientMessageId: 'stop-guidance',
      },
    });
  const first = await post();
  assert.equal(first.statusCode, 200, first.body);
  const sourceId = first.json().messageId;
  assert.ok(sourceId, first.body);
  await waitFor(() => calls.length === 1);
  await processor.requestDrain('thread');
  assert.deepEqual(calls, [[sourceId]]);
  const source = await f.messageStore.getById(sourceId);
  assert.deepEqual(source.from, { kind: 'agent', catId: 'codex' });
  assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
  const response = await f.messageStore.getById(f.response.id);
  assert.deepEqual(response.lifecycle.inputMessageIds, [sourceId]);
  const view = await app.inject({
    method: 'GET',
    url: '/api/threads/thread/queue',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(view.statusCode, 200, view.body);
  assert.deepEqual(
    view.json().queue.map((entry) => entry.id),
    [f.admission.entry.id],
  );
  assert.ok(await f.queue.getDurableEntry('thread', privateEntry.id), 'hidden future input stays in its owner ledger');
  const replay = await post();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().messageId, sourceId);
  assert.equal(calls.length, 1, 'replaying the callback must not replay accepted guidance');
  assert.deepEqual(failures, []);
});
