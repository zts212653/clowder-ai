import { assembleIncrementalContext } from '../../dist/domains/cats/services/agents/routing/route-helpers.js';
import { cursorFor } from '../../dist/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

export async function proofFixture(store = new MessageStore(), mutate = (proof) => proof) {
  const source = await store.append({
    userId: 'user-1',
    threadId: 'thread-proof',
    catId: null,
    content: '@opus source already answered',
    mentions: ['opus'],
    timestamp: Date.now(),
  });
  const boundary = cursorFor((await store.getByThreadAfter('thread-proof', undefined, undefined, 'user-1'))[0]);
  const proof = mutate({
    v: 1,
    cursor: boundary,
    userId: 'user-1',
    threadId: 'thread-proof',
    catId: 'opus',
    turnInvocationId: 'child-opus',
    sourceMessageId: source.id,
  });
  const reply = await store.append({
    userId: 'user-1',
    threadId: 'thread-proof',
    catId: 'opus',
    content: 'completed answer',
    mentions: [],
    timestamp: Date.now(),
    origin: 'stream',
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child-opus' },
      causal: { kind: 'invocation_reply', triggerMessageId: source.id },
      deliveryBoundary: proof,
    },
  });
  return { store, source, reply, proof, boundary };
}

export async function coldContext(store, cursors, explicit) {
  return assembleIncrementalContext(
    { messageStore: store, deliveryCursorStore: cursors, invocationDeps: {} },
    'user-1',
    'thread-proof',
    'opus',
    explicit,
  );
}
