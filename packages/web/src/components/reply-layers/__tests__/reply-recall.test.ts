import { describe, expect, it } from 'vitest';
import type { RecallEvent } from '@/hooks/recall-types';
import type { ChatMessage } from '@/stores/chat-types';
import { buildReplyRecallProjections } from '../reply-recall';

const reply: ChatMessage = {
  id: 'reply',
  type: 'assistant',
  catId: 'opus',
  content: 'done',
  timestamp: 1,
  extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
};
const event = (id: string, over: Partial<RecallEvent> = {}): RecallEvent => ({
  id,
  catId: 'opus',
  invocationId: 'turn',
  query: 'F322',
  timestamp: 2,
  ...over,
});

describe('F322 S4 reply recall projection', () => {
  it('does not put an unavailable recall badge on a cross-thread input', () => {
    const crossPost: ChatMessage = {
      ...reply,
      lifecycle: { kind: 'input', orderKey: '1:reply', producerInvocationId: 'turn' },
      extra: {
        crossPost: { sourceThreadId: 'other-thread', sourceInvocationId: 'turn' },
        stream: { turnInvocationId: 'turn' },
      },
    };
    const projections = buildReplyRecallProjections({ messages: [crossPost], events: [], status: 'unavailable' });
    expect(projections.has('reply')).toBe(false);
  });
  it('binds only the exact cat turn and preserves the same event objects the memory panel groups', () => {
    const events = [event('search'), event('delivery', { source: 'push' })];
    const projection = buildReplyRecallProjections({ messages: [reply], events, status: 'ready' }).get('reply');
    expect(projection).toMatchObject({ invocationId: 'turn', catId: 'opus', status: 'ready' });
    expect(projection?.events).toEqual(events);
  });

  it('does not bind a parent-only historical operation to a child turn', () => {
    const projection = buildReplyRecallProjections({
      messages: [reply],
      events: [event('parent', { invocationId: 'parent' })],
      status: 'ready',
    });
    expect(projection.has('reply')).toBe(false);
  });

  it('marks the exact turn unavailable without inventing a zero-count event', () => {
    const projection = buildReplyRecallProjections({ messages: [reply], events: [], status: 'unavailable' }).get(
      'reply',
    );
    expect(projection).toEqual({ invocationId: 'turn', catId: 'opus', status: 'unavailable', events: [] });
  });

  it('keeps events already read for this turn when another recall source is unavailable', () => {
    const events = [event('known-search')];
    const projection = buildReplyRecallProjections({ messages: [reply], events, status: 'unavailable' }).get('reply');

    expect(projection).toEqual({ invocationId: 'turn', catId: 'opus', status: 'ready', events });
  });
});
