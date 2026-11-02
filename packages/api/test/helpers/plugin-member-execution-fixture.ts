import assert from 'node:assert/strict';
import { createCatId } from '@cat-cafe/shared';
import { lifecycleResponseIdempotencyKey } from '../../src/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { InMemoryTurnExecutionStore } from '../../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { createPluginMemberSessions } from '../../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './plugin-member-session-fixture.js';

export async function memberExecutionFixture({ providerStarted = true }: { providerStarted?: boolean } = {}) {
  const f = memberSessionFixture();
  const turns = new InMemoryTurnExecutionStore(),
    messages = new MessageStore();
  const service = () => createPluginMemberSessions({ ...f.deps, canonicalExecution: { turns, messages } });
  const port = service().forInstance(f.scope());
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'event-1',
    semanticCursor: 7,
    content: '本人局部变化',
  };
  const queued = await port.execute(input);
  const messageId = queued.messageId;
  assert.ok(messageId);
  const invocationId = 'exact-child';
  const response = messages.append({
    idempotencyKey: lifecycleResponseIdempotencyKey(invocationId),
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'agent', catId: createCatId('member') },
    content: '',
    mentions: [],
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: '100:exact-child',
      invocationId,
      targetId: 'member',
      inputEntryIds: ['queue-entry'],
      inputMessageIds: [messageId],
      status: 'processing',
      startedAt: 100,
    },
  });
  turns.createRunning({
    invocationId,
    parentInvocationId: 'queue-parent',
    userId: 'owner',
    threadId: 'game-thread',
    catId: createCatId('member'),
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    causal: { triggerMessageId: messageId, coveredMessageIds: [messageId] },
    startedAt: 100,
  });
  if (providerStarted) turns.markProviderStarted(invocationId, 101);
  const claim = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: input.executionId,
    invocationId,
    responseMessageId: response.id,
  };
  const host = () => service().hostExecutionsForInstance(f.scope());
  return {
    ...f,
    service,
    port,
    turns,
    messages,
    session,
    input,
    queued: { ...queued, messageId },
    claim,
    response,
    host,
  };
}
