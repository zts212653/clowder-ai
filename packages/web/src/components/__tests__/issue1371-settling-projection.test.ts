import type { LifecycleActiveRun } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectMessageDispatchAvatars } from '../MessageDispatchAvatars';

const source: ChatMessage = {
  id: 'm',
  type: 'user',
  content: 'review',
  timestamp: 1,
  lifecycle: {
    kind: 'input',
    orderKey: '1:m',
    dispatchRefs: [{ targetId: 'opus5', phase: 'dispatched', statusMessageId: 'r', dispatchedAt: 2 }],
  },
};
const response: ChatMessage = {
  id: 'r',
  type: 'assistant',
  catId: 'opus5',
  content: '',
  timestamp: 2,
  lifecycle: {
    kind: 'response',
    orderKey: '2:r',
    invocationId: 'primary',
    targetId: 'opus5',
    inputEntryIds: ['queue'],
    inputMessageIds: ['m'],
    status: 'processing',
    startedAt: 2,
  },
};
const run: LifecycleActiveRun = {
  threadId: 't',
  targetId: 'opus5',
  invocationId: 'primary',
  responseMessageId: 'r',
  inputEntryIds: ['queue'],
  inputMessageIds: ['m'],
  privateInputEntryIds: [],
  startedAt: 2,
};
describe('exact delivery remains owned by its response', () => {
  it('has one processing state while the exact response is active', () => {
    expect(projectMessageDispatchAvatars(source, [response], [run])[0]?.phase).toBe('processing');
  });
  it.each(
    [[], [{ ...run, invocationId: 'other' }], [{ ...run, responseMessageId: 'other' }], [run, run]].map((runs) => ({
      runs,
    })),
  )('missing, replaced or ambiguous execution cannot turn a delivered message into another pending input', ({
    runs,
  }) => {
    const projected = projectMessageDispatchAvatars(source, [response], runs);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.phase).toBe('delivered');
  });
});
