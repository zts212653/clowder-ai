/**
 * F183 Phase D AC-D2 — `mergeReplaceHydrationMessages` IDB-origin filter.
 *
 * Goal: when API history hydration fires and a local message is `cachedFrom='idb'`,
 * it must be dropped (not preserved). Live state (no cachedFrom) is still
 * preserved via the existing stable-identity match. Live placeholders without
 * a history match are still pushed onto the merged timeline.
 *
 * Without this filter, an IDB cache message that the server has since deleted
 * would survive history hydration → ghost bubble.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

function makeMsg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm-default',
    type: 'assistant',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

describe('mergeReplaceHydrationMessages — AC-D2 IDB-origin filter', () => {
  it('drops cachedFrom=idb message when history does not contain it (server deleted)', () => {
    const history: ChatMessage[] = [];
    const current: ChatMessage[] = [makeMsg({ id: 'm-cached', cachedFrom: 'idb' })];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(0);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('preserves live placeholder (no cachedFrom) when history does not contain it', () => {
    const history: ChatMessage[] = [];
    const current: ChatMessage[] = [makeMsg({ id: 'live-1', isStreaming: true })];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe('live-1');
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('cachedFrom=idb with id-match in history → reconciled (existing same-id merge wins)', () => {
    const history: ChatMessage[] = [makeMsg({ id: 'm1', content: 'fresh-from-server' })];
    const current: ChatMessage[] = [makeMsg({ id: 'm1', content: 'stale-from-idb', cachedFrom: 'idb' })];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(1);
    // history version wins on id-match (same-id merge keeps history content baseline)
    expect(result.messages[0]!.content).toBe('fresh-from-server');
  });

  it('mixed: cached drops, live preserves, in-history reconciles — single hydration', () => {
    const history: ChatMessage[] = [makeMsg({ id: 'survives' })];
    const current: ChatMessage[] = [
      makeMsg({ id: 'survives', cachedFrom: 'idb' }), // reconciled to history
      makeMsg({ id: 'cached-deleted', cachedFrom: 'idb' }), // dropped
      makeMsg({ id: 'live-pending', isStreaming: true }), // preserved
    ];
    const result = mergeReplaceHydrationMessages(history, current, {});
    const ids = result.messages.map((m) => m.id).sort();
    expect(ids).toEqual(['live-pending', 'survives']);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  // 砚砚 R1 P1 — IDB cache must NEVER be selected by mergeSameIdHydrationMessage's
  // "richer current wins" path. Even if cached-IDB content is structurally richer,
  // server history must remain authoritative.
  it('砚砚 R1 P1: same-id richer cached IDB does NOT win over leaner history', () => {
    const history: ChatMessage[] = [makeMsg({ id: 'm1', content: 'thin server text', timestamp: 1000 })];
    const current: ChatMessage[] = [
      makeMsg({
        id: 'm1',
        cachedFrom: 'idb',
        // structurally richer: contentBlocks + thinking would normally beat plain content
        content: 'cached richer text',
        contentBlocks: [{ type: 'text', text: 'cached richer text' }],
        thinking: 'cached thinking buffer',
        timestamp: 2000,
      } as ChatMessage),
    ];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('thin server text');
    // Cache marker must not leak into the merged output
    expect(result.messages[0]!.cachedFrom).toBeUndefined();
    expect(result.messages[0]!.thinking).toBeUndefined();
  });

  it('砚砚 R1 P1: stream-key richer cached IDB does NOT replace history', () => {
    // streamKey match path: history has a callback bubble keyed by (cat:inv);
    // cached IDB carries the same (cat:inv) but as "richer-looking" stream form.
    // Without the top-of-loop cachedFrom guard this would call
    // shouldPreferCurrentMessage(msg, historyMsg) and write the cached msg verbatim.
    const history: ChatMessage[] = [
      makeMsg({
        id: 'callback-srv-1',
        catId: 'opus',
        extra: { stream: { invocationId: 'inv-A' } },
        content: 'server callback',
        timestamp: 5000,
      }),
    ];
    const current: ChatMessage[] = [
      makeMsg({
        id: 'msg-inv-A-opus', // different id → streamKey match wins
        catId: 'opus',
        cachedFrom: 'idb',
        extra: { stream: { invocationId: 'inv-A' } },
        // richer payload that would normally trigger replace
        content: 'cached richer streaming text',
        contentBlocks: [{ type: 'text', text: 'cached richer streaming text' }],
        thinking: 'cache thinking',
        timestamp: 6000,
      } as ChatMessage),
    ];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe('callback-srv-1');
    expect(result.messages[0]!.content).toBe('server callback');
    expect(result.messages[0]!.cachedFrom).toBeUndefined();
  });

  it('draft-orphan-shaped cachedFrom=idb still dropped (top-of-loop guard catches it)', () => {
    // After the R1 P1 fix the top-of-loop cachedFrom guard runs before the
    // draft-orphan filter, so a draft-`{inv}` carrying cachedFrom='idb' is
    // dropped by the cache guard. Either path lands on the same outcome:
    // a stale orphan never reaches mergedMsgs.
    const history: ChatMessage[] = [];
    const current: ChatMessage[] = [
      makeMsg({
        id: 'draft-inv-stale',
        cachedFrom: 'idb',
        catId: 'opus',
        extra: { stream: { invocationId: 'inv-stale' } },
      }),
    ];
    const result = mergeReplaceHydrationMessages(history, current, {});
    expect(result.messages).toHaveLength(0);
  });
});
