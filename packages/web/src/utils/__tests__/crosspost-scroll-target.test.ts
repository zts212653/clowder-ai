import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  __resetPendingCrossPostScrollForTest,
  consumePendingCrossPostScroll,
  findCrossPostTargetMessageId,
  resolveCrossPostScrollTarget,
  setPendingCrossPostScroll,
} from '../crosspost-scroll-target';

type TestMsg = Pick<ChatMessage, 'id' | 'catId' | 'extra'>;

function mk(id: string, catId: string, stream?: { invocationId?: string; turnInvocationId?: string }): TestMsg {
  return { id, catId, extra: stream ? { stream } : undefined } as TestMsg;
}

describe('findCrossPostTargetMessageId', () => {
  it('matches by turnInvocationId (per-turn SoT) and returns the real message id', () => {
    const messages = [mk('msg-a', 'opus', { turnInvocationId: 'inv-turn-1', invocationId: 'parent-1' })];
    expect(findCrossPostTargetMessageId(messages, 'inv-turn-1', 'opus')).toBe('msg-a');
  });

  it('falls back to parent/chain invocationId when no turnInvocationId matches', () => {
    // Legacy bubbles / old messages carry only invocationId (no per-turn id).
    const messages = [mk('msg-b', 'opus', { invocationId: 'parent-2' })];
    expect(findCrossPostTargetMessageId(messages, 'parent-2', 'opus')).toBe('msg-b');
  });

  it('prefers a turnInvocationId match over parent invocationId (F194 Z3 multi-turn same parent)', () => {
    // opus turn1 and turn3 share the parent invocationId but have distinct per-turn ids.
    const messages = [
      mk('msg-turn1', 'opus', { invocationId: 'parent', turnInvocationId: 't1' }),
      mk('msg-codex', 'codex', { invocationId: 'parent', turnInvocationId: 't2' }),
      mk('msg-turn3', 'opus', { invocationId: 'parent', turnInvocationId: 't3' }),
    ];
    // cross-post stored the per-turn id of the 3rd turn → must land on turn3, not turn1.
    expect(findCrossPostTargetMessageId(messages, 't3', 'opus')).toBe('msg-turn3');
  });

  it('when cross-post stored the parent invocationId (multi-turn same cat), lands on that cats first turn', () => {
    // Backend (callbacks.ts) currently stores sourceInvocationId = the function-level invocationId,
    // which in an A2A chain can be the parent id shared by multiple turns. Without a per-turn match,
    // we fall through to the first bubble of that cat — still far better than scrolling to bottom.
    const messages = [
      mk('msg-turn1', 'opus', { invocationId: 'parent', turnInvocationId: 't1' }),
      mk('msg-turn3', 'opus', { invocationId: 'parent', turnInvocationId: 't3' }),
    ];
    expect(findCrossPostTargetMessageId(messages, 'parent', 'opus')).toBe('msg-turn1');
  });

  it('disambiguates by senderCatId when a parent invocationId is shared across an A2A chain', () => {
    const messages = [
      mk('msg-opus', 'opus', { invocationId: 'parent' }),
      mk('msg-codex', 'codex', { invocationId: 'parent' }),
    ];
    expect(findCrossPostTargetMessageId(messages, 'parent', 'codex')).toBe('msg-codex');
  });

  it('returns undefined when the source message is not in the loaded page (paged out)', () => {
    const messages = [mk('msg-x', 'opus', { turnInvocationId: 'other' })];
    expect(findCrossPostTargetMessageId(messages, 'inv-missing', 'opus')).toBeUndefined();
  });

  it('matches without catId filter when senderCatId is undefined', () => {
    const messages = [mk('msg-c', 'opus', { turnInvocationId: 'inv-z' })];
    expect(findCrossPostTargetMessageId(messages, 'inv-z', undefined)).toBe('msg-c');
  });

  it('returns undefined for an empty message list', () => {
    expect(findCrossPostTargetMessageId([], 'anything', 'opus')).toBeUndefined();
  });
});

describe('pending cross-post scroll target', () => {
  beforeEach(() => __resetPendingCrossPostScrollForTest());

  it('consume returns the target set for the matching thread, then clears it (one-shot)', () => {
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'inv-1', senderCatId: 'opus' });
    expect(consumePendingCrossPostScroll('thread_a')).toEqual({
      threadId: 'thread_a',
      sourceInvocationId: 'inv-1',
      senderCatId: 'opus',
    });
    // one-shot: a second consume for the same thread returns null
    expect(consumePendingCrossPostScroll('thread_a')).toBeNull();
  });

  it('consume returns null when threadId does not match, and the pending target survives', () => {
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'inv-1' });
    expect(consumePendingCrossPostScroll('thread_b')).toBeNull();
    // mismatched consume must NOT clear the pending target meant for thread_a
    expect(consumePendingCrossPostScroll('thread_a')).not.toBeNull();
  });

  it('set overwrites any prior pending target (latest click wins)', () => {
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'inv-1' });
    setPendingCrossPostScroll({ threadId: 'thread_c', sourceInvocationId: 'inv-2' });
    expect(consumePendingCrossPostScroll('thread_a')).toBeNull();
    expect(consumePendingCrossPostScroll('thread_c')).toEqual({
      threadId: 'thread_c',
      sourceInvocationId: 'inv-2',
    });
  });

  it('consume returns null when nothing is pending', () => {
    expect(consumePendingCrossPostScroll('thread_a')).toBeNull();
  });
});

describe('resolveCrossPostScrollTarget', () => {
  beforeEach(() => __resetPendingCrossPostScrollForTest());

  it('returns null when there is no pending target for the thread', () => {
    const messages = [mk('m1', 'opus', { turnInvocationId: 'i1' })];
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: true })).toBeNull();
  });

  it('consumes the pending target on a hit, regardless of authoritative flag', () => {
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'i1', senderCatId: 'opus' });
    const messages = [mk('m1', 'opus', { turnInvocationId: 'i1' })];
    // a hit consumes even on a non-authoritative (IDB) pass
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: false })).toBe('m1');
    // consumed → second call returns null (no re-scroll on later renders)
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: true })).toBeNull();
  });

  it('tentative (non-authoritative) miss KEEPS pending so a later fresh load can still resolve', () => {
    // 砚砚 R1 P1: useChatHistory restores a stale IDB snapshot first, then replaces with a fresh
    // API page. A miss against the stale snapshot must NOT pre-consume the cross-post jump.
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'i1', senderCatId: 'opus' });
    const idbStale = [mk('m-other', 'opus', { turnInvocationId: 'other' })];
    // IDB phase (non-authoritative) miss → null, but pending must survive
    expect(resolveCrossPostScrollTarget('thread_a', idbStale, { authoritative: false })).toBeNull();
    // fresh authoritative API page contains the target → resolves on the next pass
    const freshPage = [
      mk('m1', 'opus', { turnInvocationId: 'i1' }),
      mk('m-other', 'opus', { turnInvocationId: 'other' }),
    ];
    expect(resolveCrossPostScrollTarget('thread_a', freshPage, { authoritative: true })).toBe('m1');
  });

  it('authoritative miss consumes pending (real paged-out, no infinite retry)', () => {
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'missing', senderCatId: 'opus' });
    const messages = [mk('m1', 'opus', { turnInvocationId: 'i1' })];
    // authoritative fresh page still misses → give up + consume
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: true })).toBeNull();
    // proven consumed: re-setting a matching pending resolves again
    setPendingCrossPostScroll({ threadId: 'thread_a', sourceInvocationId: 'i1', senderCatId: 'opus' });
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: true })).toBe('m1');
  });

  it('does not consume a pending target meant for a different thread', () => {
    setPendingCrossPostScroll({ threadId: 'thread_other', sourceInvocationId: 'i1', senderCatId: 'opus' });
    const messages = [mk('m1', 'opus', { turnInvocationId: 'i1' })];
    expect(resolveCrossPostScrollTarget('thread_a', messages, { authoritative: true })).toBeNull();
    // thread_other's pending must survive the mismatched resolve
    expect(resolveCrossPostScrollTarget('thread_other', messages, { authoritative: true })).toBe('m1');
  });
});
