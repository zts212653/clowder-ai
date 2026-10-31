import { describe, expect, it, vi } from 'vitest';
import { createThreadChatHistoryAdmission } from '../thread-chat-history-admission';

async function flushOwnerStart() {
  await Promise.resolve();
  await Promise.resolve();
}

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

describe('ThreadChatHistoryAdmission', () => {
  it('starts admitted bootstrap work synchronously from the registration effect', () => {
    const admission = createThreadChatHistoryAdmission();
    const bootstrap = vi.fn(async () => {});

    admission.register({ threadId: 'thread-a', consumerId: Symbol('first'), startBootstrap: bootstrap });

    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it('starts exactly one bootstrap for duplicate same-thread consumers', async () => {
    const admission = createThreadChatHistoryAdmission();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    admission.register({ threadId: 'thread-a', consumerId: Symbol('first'), startBootstrap: first });
    admission.register({ threadId: 'thread-a', consumerId: Symbol('second'), startBootstrap: second });
    await flushOwnerStart();

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it('owns different threads independently', async () => {
    const admission = createThreadChatHistoryAdmission();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    admission.register({ threadId: 'thread-a', consumerId: Symbol('a'), startBootstrap: first });
    admission.register({ threadId: 'thread-b', consumerId: Symbol('b'), startBootstrap: second });
    await flushOwnerStart();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('promotes one surviving consumer when the running owner leaves', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const cleanupFirst = admission.register({ threadId: 'thread-a', consumerId: firstId, startBootstrap: first });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: second });
    await flushOwnerStart();

    cleanupFirst();
    await flushOwnerStart();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('transfers a ready lease without re-running bootstrap', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const first = createBootstrapProbe();
    const second = vi.fn(async () => {});
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: first.startBootstrap,
    });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: second });
    await flushOwnerStart();

    admission.completeBootstrap('thread-a', firstId, first.generation(), 'succeeded');
    cleanupFirst();
    await flushOwnerStart();

    expect(second).not.toHaveBeenCalled();
  });

  it('retries a failed bootstrap when a late consumer joins', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const first = createBootstrapProbe();
    const second = vi.fn(async () => {});

    admission.register({ threadId: 'thread-a', consumerId: firstId, startBootstrap: first.startBootstrap });
    admission.completeBootstrap('thread-a', firstId, first.generation(), 'failed');
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: second });
    await flushOwnerStart();

    expect(first.startBootstrap).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('retries a failed bootstrap when its owner leaves a surviving consumer', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const first = createBootstrapProbe();
    const second = vi.fn(async () => {});
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: first.startBootstrap,
    });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: second });

    admission.completeBootstrap('thread-a', firstId, first.generation(), 'failed');
    cleanupFirst();
    await flushOwnerStart();

    expect(second).toHaveBeenCalledOnce();
  });

  it('ignores stale completion after a new owner generation starts', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const first = createBootstrapProbe();
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: first.startBootstrap,
    });
    const second = vi.fn(async () => {});
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: second });
    await flushOwnerStart();

    cleanupFirst();
    await flushOwnerStart();
    admission.completeBootstrap('thread-a', firstId, first.generation(), 'succeeded');

    const third = vi.fn(async () => {});
    admission.register({ threadId: 'thread-a', consumerId: Symbol('third'), startBootstrap: third });
    await flushOwnerStart();

    expect(second).toHaveBeenCalledOnce();
    expect(third).not.toHaveBeenCalled();
  });

  it('forgets readiness after the last consumer leaves', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const first = createBootstrapProbe();
    const cleanup = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: first.startBootstrap,
    });
    await flushOwnerStart();
    admission.completeBootstrap('thread-a', firstId, first.generation(), 'succeeded');
    cleanup();

    const remount = vi.fn(async () => {});
    admission.register({ threadId: 'thread-a', consumerId: Symbol('remount'), startBootstrap: remount });
    await flushOwnerStart();

    expect(remount).toHaveBeenCalledOnce();
  });

  it('coalesces an equal thread/request key onto the same promise', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    admission.register({ threadId: 'thread-a', consumerId: firstId, startBootstrap: async () => {} });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: async () => {} });
    const task = vi.fn(async () => 'result');

    const first = admission.runRequest({
      threadId: 'thread-a',
      consumerId: firstId,
      requestKey: 'messages:latest:replace',
      task,
    });
    const second = admission.runRequest({
      threadId: 'thread-a',
      consumerId: secondId,
      requestKey: 'messages:latest:replace',
      task,
    });

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ status: 'completed', value: 'result' });
    expect(task).toHaveBeenCalledOnce();
  });

  it('keeps different thread/request keys independent', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    admission.register({ threadId: 'thread-a', consumerId: firstId, startBootstrap: async () => {} });
    admission.register({ threadId: 'thread-b', consumerId: secondId, startBootstrap: async () => {} });
    const task = vi.fn(async () => 'result');

    const latest = admission.runRequest({
      threadId: 'thread-a',
      consumerId: firstId,
      requestKey: 'messages:latest:replace',
      task,
    });
    const cursor = admission.runRequest({
      threadId: 'thread-a',
      consumerId: firstId,
      requestKey: 'messages:cursor-1:prepend',
      task,
    });
    const otherThread = admission.runRequest({
      threadId: 'thread-b',
      consumerId: secondId,
      requestKey: 'messages:latest:replace',
      task,
    });

    expect(new Set([latest, cursor, otherThread]).size).toBe(3);
    await Promise.all([latest, cursor, otherThread]);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('does not let a stale promise finalizer delete its replacement', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: async () => {},
    });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: async () => {} });
    let resolveFirst: ((value: string) => void) | undefined;
    let resolveSecond: ((value: string) => void) | undefined;

    const first = admission.runRequest({
      threadId: 'thread-a',
      consumerId: firstId,
      requestKey: 'messages:latest:replace',
      task: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    });
    await flushOwnerStart();
    cleanupFirst();
    const secondTask = vi.fn(() => new Promise<string>((resolve) => (resolveSecond = resolve)));
    const second = admission.runRequest({
      threadId: 'thread-a',
      consumerId: secondId,
      requestKey: 'messages:latest:replace',
      task: secondTask,
    });
    await flushOwnerStart();

    resolveFirst?.('old');
    await first;
    const coalesced = admission.runRequest({
      threadId: 'thread-a',
      consumerId: secondId,
      requestKey: 'messages:latest:replace',
      task: secondTask,
    });

    expect(coalesced).toBe(second);
    expect(secondTask).toHaveBeenCalledOnce();
    resolveSecond?.('new');
    await second;
  });

  it('marks a shared request result abandoned when its origin consumer leaves', async () => {
    const admission = createThreadChatHistoryAdmission();
    const firstId = Symbol('first');
    const secondId = Symbol('second');
    const cleanupFirst = admission.register({
      threadId: 'thread-a',
      consumerId: firstId,
      startBootstrap: async () => {},
    });
    admission.register({ threadId: 'thread-a', consumerId: secondId, startBootstrap: async () => {} });
    let resolveFirst: ((value: string) => void) | undefined;

    const first = admission.runRequest({
      threadId: 'thread-a',
      consumerId: firstId,
      requestKey: 'messages:latest:replace',
      task: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    });
    const shared = admission.runRequest({
      threadId: 'thread-a',
      consumerId: secondId,
      requestKey: 'messages:latest:replace',
      task: async () => 'must-not-run',
    });

    expect(shared).toBe(first);
    cleanupFirst();
    resolveFirst?.('stale');

    await expect(shared).resolves.toEqual({ status: 'abandoned' });
  });

  it('clears a rejected request without creating a stale rejected chain', async () => {
    const admission = createThreadChatHistoryAdmission();
    const consumerId = Symbol('first');
    admission.register({ threadId: 'thread-a', consumerId, startBootstrap: async () => {} });

    await expect(
      admission.runRequest({
        threadId: 'thread-a',
        consumerId,
        requestKey: 'messages:latest:replace',
        task: async () => {
          throw new Error('network failed');
        },
      }),
    ).rejects.toThrow('network failed');

    await expect(
      admission.runRequest({
        threadId: 'thread-a',
        consumerId,
        requestKey: 'messages:latest:replace',
        task: async () => 'retry result',
      }),
    ).resolves.toEqual({ status: 'completed', value: 'retry result' });
  });
});
