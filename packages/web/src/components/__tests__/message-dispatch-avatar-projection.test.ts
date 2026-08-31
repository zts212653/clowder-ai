import type { LifecycleActiveRun } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectMessageDispatchAvatars } from '../message-dispatch-avatar-projection';

const input = (phase: 'dispatched' | 'settled'): ChatMessage => ({
  id: 'input-1',
  from: { kind: 'user', userId: 'user-1' },
  type: 'user',
  content: 'hello',
  timestamp: 100,
  lifecycle: {
    kind: 'input',
    orderKey: '100:input-1',
    dispatchRefs: [{ targetId: 'opus', phase, statusMessageId: 'response-1' }],
  },
});

const response = (status: 'processing' | 'completed' | 'failed'): ChatMessage => ({
  id: 'response-1',
  from: { kind: 'agent', catId: 'opus' },
  type: 'assistant',
  catId: 'opus',
  content: status === 'completed' ? 'done' : '',
  timestamp: 110,
  lifecycle: {
    kind: 'response',
    orderKey: '110:child-1',
    invocationId: 'child-1',
    targetId: 'opus',
    inputEntryIds: ['entry-1'],
    inputMessageIds: ['input-1'],
    status,
    startedAt: 110,
    ...(status === 'processing' ? {} : { completedAt: 120 }),
  },
});

const activeRun: LifecycleActiveRun = {
  threadId: 'thread-1',
  targetId: 'opus',
  invocationId: 'child-1',
  responseMessageId: 'response-1',
  inputEntryIds: ['entry-1'],
  inputMessageIds: ['input-1'],
  privateInputEntryIds: [],
  startedAt: 110,
};

const completedSourceResponse = (phase: 'dispatched' | 'settled'): ChatMessage => ({
  id: 'source-response-1',
  from: { kind: 'agent', catId: 'codex' },
  type: 'assistant',
  catId: 'codex',
  content: '@opus continue',
  timestamp: 100,
  lifecycle: {
    kind: 'response',
    orderKey: '100:source-invocation',
    invocationId: 'source-invocation',
    targetId: 'codex',
    inputEntryIds: ['source-entry'],
    inputMessageIds: ['source-input'],
    status: 'completed',
    startedAt: 90,
    completedAt: 100,
    dispatchRefs: [{ targetId: 'opus', phase, statusMessageId: 'response-1' }],
  },
});

const downstreamResponse = (status: 'processing' | 'completed'): ChatMessage => {
  const message = response(status);
  if (message.lifecycle?.kind !== 'response') throw new Error('response fixture lost lifecycle metadata');
  return {
    ...message,
    lifecycle: {
      ...message.lifecycle,
      inputMessageIds: ['source-response-1'],
    },
  };
};

const deliveryFailure: ChatMessage = {
  id: 'delivery-failure-1',
  from: { kind: 'system', service: 'message-lifecycle' },
  type: 'system',
  content: 'target unavailable',
  timestamp: 120,
  lifecycle: {
    kind: 'delivery_failure',
    orderKey: '120:delivery-failure-1',
    status: 'failed',
    sourceEntryId: 'entry-1',
    inputMessageId: 'input-1',
    requestedTargets: ['opus'],
    reason: 'invalid_explicit_target',
    createdAt: 120,
  },
};

describe('projectMessageDispatchAvatars', () => {
  it('animates only when the dispatched ref, processing response, and exact ActiveRun agree', () => {
    expect(
      projectMessageDispatchAvatars(input('dispatched'), [input('dispatched'), response('processing')], [activeRun]),
    ).toEqual([{ targetId: 'opus', status: 'streaming', responseMessageId: 'response-1' }]);
    expect(
      projectMessageDispatchAvatars(input('dispatched'), [input('dispatched'), response('processing')], []),
    ).toEqual([]);
    expect(
      projectMessageDispatchAvatars(
        input('dispatched'),
        [input('dispatched'), response('processing')],
        [{ ...activeRun, invocationId: 'different-child' }],
      ),
    ).toEqual([]);
  });

  it('shows a static terminal avatar only after both input and response settle', () => {
    expect(projectMessageDispatchAvatars(input('settled'), [input('settled'), response('completed')], [])).toEqual([
      { targetId: 'opus', status: 'done', responseMessageId: 'response-1' },
    ]);
    expect(projectMessageDispatchAvatars(input('settled'), [input('settled'), response('failed')], [])).toEqual([
      { targetId: 'opus', status: 'error', responseMessageId: 'response-1' },
    ]);
    expect(
      projectMessageDispatchAvatars(input('dispatched'), [input('dispatched'), response('completed')], []),
    ).toEqual([]);
  });

  it('uses a completed response bubble itself as the next-hop dispatch anchor', () => {
    const source = completedSourceResponse('settled');
    const downstream = downstreamResponse('completed');

    expect(projectMessageDispatchAvatars(source, [source, downstream], [])).toEqual([
      { targetId: 'opus', status: 'done', responseMessageId: 'response-1' },
    ]);
    if (source.lifecycle?.kind !== 'response') throw new Error('source fixture lost response metadata');
    expect(
      projectMessageDispatchAvatars(
        {
          ...source,
          lifecycle: { ...source.lifecycle, status: 'processing', completedAt: undefined },
        },
        [downstream],
        [],
      ),
    ).toEqual([]);
  });

  it('projects a linked delivery failure as a terminal error', () => {
    const settledInput = input('settled');
    if (settledInput.lifecycle?.kind !== 'input') throw new Error('input fixture lost lifecycle metadata');
    const source: ChatMessage = {
      ...settledInput,
      lifecycle: {
        ...settledInput.lifecycle,
        dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: deliveryFailure.id }],
      },
    };

    expect(projectMessageDispatchAvatars(source, [source, deliveryFailure], [])).toEqual([
      { targetId: 'opus', status: 'error', responseMessageId: deliveryFailure.id },
    ]);
  });
});
