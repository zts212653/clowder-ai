import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';

// The fold rule itself lives in turn-absorption-summary and has its own tests; here only the wiring is under test:
// a message of yours whose body is folded into the answering reply paints nothing, so it must not extend a run.
vi.mock('../turn-absorption-summary', () => ({
  foldedSourceInvocationIdInTimeline: (message: { id: string }) => (message.id === 'folded' ? 'inv-1' : undefined),
}));

import { isLastOfOwnRun } from '../own-message-run';

const own = (id: string): ChatMessage => ({ id, type: 'user', content: id, timestamp: 1 });
const cat = (id: string): ChatMessage => ({ id, type: 'assistant', catId: 'opus', content: id, timestamp: 2 });

describe('isLastOfOwnRun and folded message bodies', () => {
  it('steps over a folded message of yours when looking for the run', () => {
    const [a, folded, b] = [own('a'), own('folded'), own('b')];
    expect(isLastOfOwnRun(a, [a, folded, b])).toBe(false);
    expect(isLastOfOwnRun(a, [a, folded, cat('x')])).toBe(true);
  });
});
