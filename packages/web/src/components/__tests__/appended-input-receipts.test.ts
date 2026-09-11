import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectAppendedInputReceipts } from '../AppendedInputReceipts';

const initial: ChatMessage = {
  id: 'source-initial',
  from: { kind: 'user', userId: 'co-creator' },
  type: 'user',
  content: '@狸花猫 开始',
  timestamp: new Date('2026-09-01T14:14:00.000Z').getTime(),
};

const appended: ChatMessage = {
  id: 'source-appended',
  from: { kind: 'user', userId: 'co-creator' },
  type: 'user',
  content: '@狸花猫 测试下追加消息的',
  timestamp: new Date('2026-09-01T14:14:08.000Z').getTime(),
};

const response: ChatMessage = {
  id: 'response-1',
  from: { kind: 'agent', catId: 'cat-1' },
  type: 'assistant',
  catId: 'cat-1',
  content: '收到',
  timestamp: initial.timestamp,
  lifecycle: {
    kind: 'response',
    orderKey: '1:response-1',
    invocationId: 'invocation-1',
    targetId: 'cat-1',
    inputEntryIds: ['entry-initial', 'entry-appended'],
    inputMessageIds: [initial.id, appended.id],
    status: 'completed',
    startedAt: initial.timestamp,
    completedAt: appended.timestamp + 1_000,
  },
};

describe('projectAppendedInputReceipts', () => {
  it('projects only inputs added after the initial dispatch input', () => {
    expect(projectAppendedInputReceipts(response, [appended, initial])).toEqual([appended]);
  });

  it('fails closed when lifecycle sources are unavailable', () => {
    expect(projectAppendedInputReceipts(response, [initial])).toEqual([]);
  });

  it('does not project ordinary response inputs as appended receipts', () => {
    if (response.lifecycle?.kind !== 'response') throw new Error('response fixture lifecycle missing');
    expect(
      projectAppendedInputReceipts(
        {
          ...response,
          lifecycle: { ...response.lifecycle, inputEntryIds: ['entry-initial'], inputMessageIds: [initial.id] },
        },
        [initial],
      ),
    ).toEqual([]);
  });

  it('does not mislabel initially coalesced messages as runtime appends', () => {
    if (response.lifecycle?.kind !== 'response') throw new Error('response fixture lifecycle missing');
    expect(
      projectAppendedInputReceipts(
        {
          ...response,
          lifecycle: {
            ...response.lifecycle,
            inputEntryIds: ['entry-initial'],
            inputMessageIds: [initial.id, appended.id],
          },
        },
        [initial, appended],
      ),
    ).toEqual([]);
  });
});
