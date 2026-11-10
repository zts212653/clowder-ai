import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { messagesRoutes } from '../../../../api/dist/routes/messages.js';
import { createCallbackContextFixture } from '../../../../api/test/helpers/callback-context-fixture.js';

const requireApi = createRequire(new URL('../../../../api/package.json', import.meta.url));

/** Actual compiled callback adoption, memory store, terminal CAS and History HTTP. */
export async function createCausalHistoryApi(t, prefix) {
  const f = await createCallbackContextFixture(t);
  f.response.content = '';
  const release = f.tracker.bindLifecycleOutputCursor(
    f.threadId,
    'opus',
    {
      invocationId: f.auth.invocationId,
      responseMessageId: f.response.id,
    },
    () => prefix,
  );
  t.after(() => release?.());
  // Enough real rows to leave the execution on an older History page.
  await Promise.all(Array.from({ length: 60 }, (_, index) => f.publish(`中间消息 ${index}`)));
  const source = await f.enqueue('后来输入：请给出处理结果。');
  const admission = await f.read();
  assert.equal(admission.statusCode, 200, admission.body);
  const adopted = f.messages.getById(f.response.id);
  assert.equal(adopted.lifecycle.appendBoundaries[0].inputMessageId, source.message.id);
  assert.equal(adopted.lifecycle.appendBoundaries[0].contentOffset, prefix.length);
  const content = `${prefix}真实存储重读的最终结果。`;
  const terminal = f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.auth.invocationId,
    status: 'completed',
    completedAt: Date.now(),
    content,
    mentions: [],
    origin: 'stream',
  });
  assert.equal(terminal.kind, 'applied', JSON.stringify(terminal));
  const app = requireApi('fastify')();
  t.after(() => app.close());
  // Isolated browser-session stand-in, not a real owner's cookies. Permission
  // rejection is covered separately by the actual anchor route tests.
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = f.userId;
  });
  await app.register(messagesRoutes, {
    registry: f.registry,
    messageStore: f.messages,
    router: {},
    threadStore: { get: async (id) => (id === f.threadId ? { id, createdBy: f.userId } : null) },
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
  });
  await app.ready();
  return { ...f, historyApp: app, sourceMessageId: source.message.id, content };
}
