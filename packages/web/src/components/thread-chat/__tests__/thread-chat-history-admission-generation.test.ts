import { describe, expect, it, vi } from 'vitest';
import { createThreadChatHistoryAdmission } from '../thread-chat-history-admission';

function createBootstrapProbe() {
  let registrationGeneration: symbol | undefined;
  const startBootstrap = vi.fn(async (generation: symbol) => {
    registrationGeneration = generation;
  });
  const generation = () => {
    if (!registrationGeneration) throw new Error('bootstrap did not receive its registration generation');
    return registrationGeneration;
  };
  return { startBootstrap, generation };
}

describe('ThreadChatHistoryAdmission registration generation', () => {
  it('ignores stale completion after the same consumer registers a new generation', () => {
    const admission = createThreadChatHistoryAdmission();
    const consumerId = Symbol('strict-mode-consumer');
    const first = createBootstrapProbe();
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId,
      startBootstrap: first.startBootstrap,
    });
    cleanupFirst();

    const second = createBootstrapProbe();
    admission.register({
      threadId: 'thread-a',
      consumerId,
      startBootstrap: second.startBootstrap,
    });

    admission.completeBootstrap('thread-a', consumerId, first.generation(), 'failed');
    admission.completeBootstrap('thread-a', consumerId, second.generation(), 'succeeded');

    const lateConsumer = vi.fn(async () => {});
    admission.register({
      threadId: 'thread-a',
      consumerId: Symbol('late-consumer'),
      startBootstrap: lateConsumer,
    });

    expect(lateConsumer).not.toHaveBeenCalled();
    expect(second.generation()).not.toBe(first.generation());
  });
});
