import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { deduplicateRecallEvents, groupRecallEvents, recallEventResultLabel } from '../recall-feed-model';
import type { RecallEvent } from '../recall-types';

const event = (extra: Partial<RecallEvent> = {}): RecallEvent => ({
  id: 'e',
  catId: 'sonnet',
  invocationId: 'turn-one',
  query: 'F321',
  timestamp: 999999,
  ...extra,
});
const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'reply-one',
  type: 'assistant',
  catId: 'sonnet',
  content: 'reply',
  timestamp: 100,
  extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn-one' } },
  ...extra,
});
describe('F321 reply attribution', () => {
  it('never uses an incoming cross-post as the reply of its producer invocation', () => {
    const incoming = message({
      extra: {
        crossPost: { sourceThreadId: 'other-thread', sourceInvocationId: 'turn-one' },
        stream: { turnInvocationId: 'turn-one' },
      },
    });
    expect(groupRecallEvents([event()], [incoming])[0].messageId).toBeUndefined();
  });
  it('uses the exact invocation and reply timestamp even when correlation is late', () => {
    const groups = groupRecallEvents(
      [event()],
      [message(), message({ id: 'other', catId: 'codex61-sol', timestamp: 999999 })],
    );
    expect(groups[0]).toMatchObject({ catId: 'sonnet', messageId: 'reply-one', timestamp: 100 });
  });
  it('does not guess a missing reply from time or a shared parent with repeated cat turns', () => {
    const groups = groupRecallEvents(
      [event({ invocationId: 'parent' })],
      [
        message(),
        message({ id: 'repeat', extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn-two' } } }),
      ],
    );
    expect(groups[0].messageId).toBeUndefined();
    expect(groups[0].timestamp).toBeUndefined();
  });
  it('does not relabel a known child reply as a parent-only historical operation', () => {
    const groups = groupRecallEvents([event({ invocationId: 'parent' })], [message()]);
    expect(groups[0].messageId).toBeUndefined();
  });
  it('joins live and persisted operations using native identity despite different clocks', () => {
    const results = deduplicateRecallEvents(
      [event({ sourceEventId: 'turn-one:sonnet:tool-id', resultCount: 2 })],
      [event({ id: 'db', sourceEventId: 'turn-one:sonnet:tool-id', timestamp: 200, consumedCount: 1 })],
    );
    expect(results).toHaveLength(1);
    expect(recallEventResultLabel(results[0])).toBe('命中 2 条 · 之后读了 1 条');
  });
  it('keeps typed metadata and remaining candidates when a live preview is shorter', () => {
    const merged = deduplicateRecallEvents(
      [event({ results: [{ title: 'rich live title', anchor: 'a' }] })],
      [
        event({
          id: 'stored',
          results: [
            { title: 'a', anchor: 'a', sourceType: 'feature', consumed: true },
            { title: 'b', anchor: 'b', sourceType: 'decision', consumed: false },
          ],
        }),
      ],
    );
    expect(merged[0].results).toEqual([
      { title: 'rich live title', anchor: 'a', sourceType: 'feature', consumed: true },
      { title: 'b', anchor: 'b', sourceType: 'decision', consumed: false },
    ]);
  });
  it('keeps repeated same-query operations with distinct native identities separate', () => {
    expect(
      deduplicateRecallEvents([event({ sourceEventId: 'one' })], [event({ id: 'two', sourceEventId: 'two' })]),
    ).toHaveLength(2);
  });
  it('does not merge legacy operations without a caller identity', () => {
    expect(
      deduplicateRecallEvents([event({ catId: undefined })], [event({ id: 'legacy', catId: undefined })]),
    ).toHaveLength(2);
  });
  it.each([
    ['presented_unreported', '已递送·未回报'],
    ['drilled', '点开看过'],
    ['applied', '采用'],
    ['dismissed', '明确不用'],
    ['invalidated', '递送已失效'],
  ] as const)('renders cue %s with truthful status', (cueStatus, label) => {
    expect(recallEventResultLabel(event({ cueStatus }))).toBe(label);
  });
  it('does not replace recorded failure with a zero or stale count', () => {
    expect(recallEventResultLabel(event({ resultStatus: 'error', resultCount: 12 }))).toBe('召回失败');
  });
});
