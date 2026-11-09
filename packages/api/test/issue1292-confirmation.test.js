import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { routingConfirmationRequiredSchema, routingPreviewResponseSchema } from '@cat-cafe/shared/routing-preview';
import Fastify from 'fastify';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

it(
  'disabled explicit mention offers its configured successor only after confirmation',
  { timeout: 15000 },
  async (t) => {
    const h = successorFixture(t);
    const preview = await h.router.previewTargets('@opus work', { threadId: h.threadId });
    assert.equal(routingPreviewResponseSchema.safeParse(preview).success, true);
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.routingWarnings[0].kind, 'cat_disabled');
    assert.deepEqual(preview.targetCats, ['opus-5']);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      router: h.router,
      messageStore: h.messages,
      threadStore: h.threads,
      invocationQueue: h.queue,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    });
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { threadId: h.threadId, content: '@opus work', idempotencyKey: randomUUID() },
    };
    const rejected = await app.inject(request);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(routingConfirmationRequiredSchema.safeParse(rejected.json()).success, true);
    assert.equal(rejected.json().routingWarnings[0].alternatives[0].catId, 'opus-5');
    assert.deepEqual(await h.messages.getByThread(h.threadId), []);
    assert.deepEqual(await h.ledger.list(h.threadId), []);
    assert.deepEqual(h.threads.get(h.threadId).participants, []);
    const confirmed = await app.inject({
      ...request,
      payload: { ...request.payload, confirmedTargetCats: ['opus-5'] },
    });
    assert.equal(confirmed.statusCode, 202, confirmed.body);
    const [entry] = await h.ledger.list(h.threadId);
    assert.deepEqual(entry.targets, ['opus-5']);
    const completed = new Promise((resolve) =>
      h.processor.registerEntryCompleteHook(entry.id, (_id, status) => resolve(status)),
    );
    await h.processor.requestDrain(h.threadId);
    assert.equal(await completed, 'succeeded');
    assert.deepEqual(h.calls, ['opus-5']);
  },
);

for (const kind of ['private_input', 'conversation_input']) {
  it(`frozen system ${kind} cannot retarget through successor admission`, async (t) => {
    const h = successorFixture(t);
    const input = privateInput(h.threadId, { kind, allowConversationFallback: false });
    await assert.rejects(h.queue.enqueueDurable(input), /target/i);
    assert.deepEqual(await h.ledger.list(h.threadId), []);
    assert.deepEqual(h.calls, []);
  });
}

it('disabled explicit mention without an executable successor remains no-target', async (t) => {
  const h = successorFixture(t);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  const preview = await h.router.previewTargets('@opus work', { threadId: h.threadId });
  assert.deepEqual(preview.targetCats, []);
  assert.equal(preview.routingWarnings[0].kind, 'cat_disabled');
  assert.deepEqual(await h.ledger.list(h.threadId), []);
});

it('public system send honors the frozen recipient before atomic Message admission', async (t) => {
  const h = successorFixture(t);
  const input = privateInput(h.threadId, { kind: 'conversation_input', allowConversationFallback: false });
  await assert.rejects(
    h.queue.send(
      h.messages,
      {
        threadId: h.threadId,
        userId: 'owner',
        from: input.from,
        content: 'work',
        mentions: [],
        timestamp: 1,
        deliveryStatus: 'queued',
        idempotencyKey: randomUUID(),
      },
      input,
    ),
    /target/i,
  );
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
});
