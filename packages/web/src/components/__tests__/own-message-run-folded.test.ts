import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';

import { isLastOfOwnRun } from '../own-message-run';

const own = (id: string): ChatMessage => ({
  id,
  type: 'user',
  from: { kind: 'user', userId: 'default-user' },
  content: id,
  timestamp: 1,
});
const cat = (id: string): ChatMessage => ({ id, type: 'assistant', catId: 'opus', content: id, timestamp: 2 });

describe('isLastOfOwnRun and retained source bodies', () => {
  it('counts an appended source as visible even after the response completed', () => {
    const [a, appended, reply] = [own('a'), own('appended'), cat('reply')];
    reply.lifecycle = {
      kind: 'response',
      orderKey: '2:reply',
      invocationId: 'exact-child',
      targetId: 'opus',
      inputEntryIds: ['entry-a', 'entry-appended'],
      inputMessageIds: [a.id, appended.id],
      startedAt: 0,
      completedAt: 3,
      status: 'completed',
    };
    expect(isLastOfOwnRun(a, [a, appended, reply])).toBe(false);
    expect(isLastOfOwnRun(appended, [a, appended, reply])).toBe(true);
  });
});
