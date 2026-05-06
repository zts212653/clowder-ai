import { describe, expect, it } from 'vitest';
import { applyBubbleEvent, type BubbleReducerInput } from '@/stores/bubble-reducer';
import type { ChatMessage } from '@/stores/chat-types';

function streamPlaceholder(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-inv-1-codex',
    type: 'assistant',
    catId: 'codex',
    content: '',
    timestamp: 1000,
    isStreaming: true,
    origin: 'stream',
    extra: { stream: { invocationId: 'inv-1' } },
    ...overrides,
  };
}

function baseEvent(): BubbleReducerInput['event'] {
  return {
    type: 'stream_started',
    threadId: 'thread-1',
    actorId: 'codex',
    canonicalInvocationId: 'inv-1',
    bubbleKind: 'assistant_text',
    originPhase: 'stream',
    sourcePath: 'active',
    messageId: 'msg-inv-1-codex',
    timestamp: 1000,
  };
}

describe('F183 Phase B1 — BubbleReducer core', () => {
  it('creates placeholder ChatMessage from stream_started event', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: baseEvent(),
      currentMessages: [],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
    });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('appends content via stream_chunk to existing stable identity', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        timestamp: 1100,
        payload: { content: ' world' },
      },
      currentMessages: [streamPlaceholder({ content: 'hello' })],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].content).toBe('hello world');
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  // 云端 codex round 5 P1 (F183-B1.2.1): textMode='replace' 重写 bubble content（不
  // 累加），对齐 useAgentMessages.ts:991 patchThreadMessage('replace') 既有语义。
  it('replaces content via stream_chunk when textMode=replace (round 5 P1)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        timestamp: 1100,
        payload: { content: 'rewritten output', textMode: 'replace' },
      },
      currentMessages: [streamPlaceholder({ content: 'old content that should be gone' })],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].content).toBe('rewritten output');
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  // 默认 textMode='append'（不传也累加）— 防止 round 5 P1 修复带来的回归
  it('appends content via stream_chunk when textMode is omitted (round 5 P1 regression guard)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        timestamp: 1100,
        payload: { content: ' tail' },
      },
      currentMessages: [streamPlaceholder({ content: 'head' })],
    });

    expect(output.nextMessages[0].content).toBe('head tail');
  });

  // F183 Phase B1.2.4 — callback-specific upgrade policy（砚砚 verdict）。
  // reduceCallbackFinal 不能复用通用 findUpgradableLocalPlaceholder（stream
  // semantic 太宽）。callback 升级窄于 stream：
  //   - exact stable key match (extra.stream.invocationId === canonicalInvocationId): upgrade
  //   - rich/tool-only invocationless placeholder: upgrade（保留 legacy guard）
  //   - contentful invocationless live stream: 绝不能 hijack
  //   - 无 safe target: 创建 standalone callback bubble

  it('B1.2.4: callback upgrades exact-key match (existing canonical bubble)', () => {
    const existing = streamPlaceholder({ content: 'streaming...' });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [existing],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      content: 'final answer',
      isStreaming: false,
      origin: 'callback',
    });
  });

  it('B1.2.4: callback does NOT hijack contentful invocationless live stream', () => {
    // contentful invocationless live stream — 不能被不同 invocation 的 callback 收编
    const liveStream: ChatMessage = {
      id: 'msg-live-stream',
      type: 'assistant',
      catId: 'codex',
      content: 'I am streaming meaningful content',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: {} }, // invocationless (extra.stream.invocationId undefined)
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: 'inv-callback',
        messageId: 'msg-callback-new',
        timestamp: 1500,
        payload: { content: 'unrelated callback response' },
      },
      currentMessages: [liveStream],
    });

    // 关键：live stream bubble 必须保留，callback 创建 standalone
    expect(output.nextMessages).toHaveLength(2);
    const liveAfter = output.nextMessages.find((m) => m.id === 'msg-live-stream');
    expect(liveAfter, 'live stream bubble must be preserved').toBeDefined();
    expect(liveAfter?.content).toBe('I am streaming meaningful content');
    const callbackAfter = output.nextMessages.find((m) => m.id === 'msg-callback-new');
    expect(callbackAfter, 'standalone callback bubble must be created').toBeDefined();
    expect(callbackAfter?.content).toBe('unrelated callback response');
    expect(callbackAfter?.origin).toBe('callback');
    expect(callbackAfter?.isStreaming).toBe(false);
  });

  it('B1.2.4: callback creates standalone bubble when no upgradable target', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: 'inv-cb',
        messageId: 'msg-cb-standalone',
        timestamp: 1500,
        payload: { content: 'standalone' },
      },
      currentMessages: [], // 没有任何 placeholder
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-cb-standalone',
      content: 'standalone',
      isStreaming: false,
      origin: 'callback',
    });
  });

  it('B1.2.4: callback adopts rich/tool-only invocationless placeholder (legacy guard)', () => {
    // rich-block-only placeholder: empty content + has rich blocks，可以被 callback 收编
    const richPlaceholder: ChatMessage = {
      id: 'msg-rich-placeholder',
      type: 'assistant',
      catId: 'codex',
      content: '', // empty content
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: {
        stream: {}, // invocationless
        rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1 } as never] },
      },
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: 'inv-cb',
        messageId: 'msg-rich-placeholder',
        timestamp: 1500,
        payload: { content: 'callback adopts rich placeholder' },
      },
      currentMessages: [richPlaceholder],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-rich-placeholder',
      content: 'callback adopts rich placeholder',
      isStreaming: false,
      origin: 'callback',
    });
    // rich blocks 保留
    expect(output.nextMessages[0].extra?.rich?.blocks).toHaveLength(1);
  });

  // 砚砚 round 1 P1-1: 顶层 ambiguous guard 不能用通用 stream upgrade 候选
  // 否则 2 个 contentful invocationless live streams + explicit callback_final
  // → quarantine → callback authoritative content 丢失
  it('B1.2.4 round 1 P1-1: callback_final does NOT quarantine on multiple contentful invocationless streams', () => {
    const liveA: ChatMessage = {
      id: 'msg-live-A',
      type: 'assistant',
      catId: 'codex',
      content: 'streaming A content',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: {} },
    };
    const liveB: ChatMessage = {
      id: 'msg-live-B',
      type: 'assistant',
      catId: 'codex',
      content: 'streaming B content',
      timestamp: 1100,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: {} },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-callback',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-callback-X',
        timestamp: 1500,
        payload: { content: 'callback authoritative' },
      },
      currentMessages: [liveA, liveB],
    });

    // 关键：两个 contentful live stream 必须保留，callback 创建 standalone bubble
    expect(output.nextMessages).toHaveLength(3);
    expect(output.nextMessages.find((m) => m.id === 'msg-live-A')?.content).toBe('streaming A content');
    expect(output.nextMessages.find((m) => m.id === 'msg-live-B')?.content).toBe('streaming B content');
    const callback = output.nextMessages.find((m) => m.id === 'msg-callback-X');
    expect(callback, 'standalone callback bubble must be created').toBeDefined();
    expect(callback?.content).toBe('callback authoritative');
    expect(callback?.origin).toBe('callback');
    expect(callback?.isStreaming).toBe(false);
    // recoveryAction not 'quarantine'
    expect(output.recoveryAction).not.toBe('quarantine');
  });

  // 砚砚 round 1 P1-2 (reducer 端): 多个 rich/tool placeholders + 无 backend messageId
  // → ambiguous → 不升级，不重复 id
  it('B1.2.4 round 1 P1-2: callback_final does NOT pick id when multiple rich/tool placeholders ambiguous', () => {
    const richA: ChatMessage = {
      id: 'msg-rich-A',
      type: 'assistant',
      catId: 'codex',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: {
        stream: {},
        rich: { v: 1, blocks: [{ id: 'a1', kind: 'card', v: 1 } as never] },
      },
    };
    const richB: ChatMessage = {
      id: 'msg-rich-B',
      type: 'assistant',
      catId: 'codex',
      content: '',
      timestamp: 1100,
      isStreaming: true,
      origin: 'stream',
      extra: {
        stream: {},
        rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1 } as never] },
      },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-callback',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        // No messageId — reducer must not pick a target
        messageId: undefined,
        timestamp: 1500,
        payload: { content: 'callback' },
      },
      currentMessages: [richA, richB],
    });

    // 关键：两个 rich placeholder 都不被升级（ambiguous），callback 创建 standalone
    // 且 standalone id 不能等于其中任何一个 placeholder id（否则 dup id collision）
    const richAAfter = output.nextMessages.find((m) => m.id === 'msg-rich-A');
    const richBAfter = output.nextMessages.find((m) => m.id === 'msg-rich-B');
    expect(richAAfter?.content, 'rich A placeholder must NOT be hijacked').toBe('');
    expect(richBAfter?.content, 'rich B placeholder must NOT be hijacked').toBe('');
    const callback = output.nextMessages.find((m) => m.origin === 'callback');
    expect(callback, 'standalone callback bubble must be created').toBeDefined();
    expect(callback?.id).not.toBe('msg-rich-A');
    expect(callback?.id).not.toBe('msg-rich-B');
  });

  // 砚砚/云端 round 3 P1: 当 done/error 已 finalize rich/tool placeholder 后 callback
  // 才到，placeholder 仍是正确 target（empty content + rich/tool markers）。窄 policy
  // 不能因 isStreaming=false 拒绝；否则 callback 创建 standalone，placeholder 成 orphan。
  it('B1.2.4 round 3 P1: callback adopts finalized rich/tool placeholder (done arrived before callback)', () => {
    const finalizedRichPlaceholder: ChatMessage = {
      id: 'msg-rich-finalized',
      type: 'assistant',
      catId: 'codex',
      content: '', // empty content
      timestamp: 1000,
      isStreaming: false, // ← FINALIZED by done/error before callback arrives
      origin: 'stream',
      extra: {
        stream: {}, // invocationless
        rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1 } as never] },
      },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-cb',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-rich-finalized',
        timestamp: 1500,
        payload: { content: 'callback adopts finalized rich placeholder' },
      },
      currentMessages: [finalizedRichPlaceholder],
    });

    // 关键：finalized rich placeholder 必须被升级，不能创建 standalone（split bubble 回归）
    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-rich-finalized',
      content: 'callback adopts finalized rich placeholder',
      isStreaming: false,
      origin: 'callback',
    });
    expect(output.nextMessages[0].extra?.rich?.blocks).toHaveLength(1);
  });

  it('B1.2.4: callback id upgrade preserves backend messageId (existing → callback)', () => {
    // existing has local id; incoming callback has explicit backend messageId
    const existing = streamPlaceholder({ id: 'local-fallback-id', content: 'streaming...' });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-backend-id',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [existing],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].id, 'id must upgrade to backend messageId').toBe('msg-backend-id');
    expect(output.nextMessages[0].content).toBe('final answer');
    expect(output.nextMessages[0].origin).toBe('callback');
  });

  it('replaces stream placeholder via callback_final without splitting bubble', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [streamPlaceholder({ content: 'streaming...' })],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      content: 'final answer',
      isStreaming: false,
      origin: 'callback',
    });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('routes late stream_chunk after callback_final to catch-up (B1 follow-up)', () => {
    const finalized = streamPlaceholder({
      content: 'final answer',
      isStreaming: false,
      origin: 'callback',
      timestamp: 1500,
    });

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        timestamp: 1600,
        payload: { content: ' should be dropped' },
      },
      currentMessages: [finalized],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].content).toBe('final answer');
    expect(output.recoveryAction).toBe('catch-up');
  });

  // 砚砚 review P1-1: stable lookup 必须包含 bubbleKind（ADR-033 unique invariant）
  it('keeps thinking and assistant_text bubbles separate under same invocation (P1-1)', () => {
    const thinking: ChatMessage = {
      id: 'msg-inv-1-codex-thinking',
      type: 'assistant',
      catId: 'codex',
      content: '',
      thinking: 'pondering...',
      timestamp: 900,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_started',
        bubbleKind: 'assistant_text',
        timestamp: 1000,
      },
      currentMessages: [thinking],
    });

    expect(output.nextMessages).toHaveLength(2);
    expect(output.nextMessages.find((m) => m.id === 'msg-inv-1-codex-thinking')).toBeDefined();
    expect(output.nextMessages.find((m) => m.id === 'msg-inv-1-codex')).toBeDefined();
    expect(output.violations).toEqual([]);
  });

  // 砚砚 review P1-2: incoming validation 必须发现 canonical-split
  it('detects canonical-split via incoming validation (P1-2)', () => {
    const existing: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'older invocation',
      timestamp: 1000,
      origin: 'callback',
      extra: { stream: { invocationId: 'inv-old' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'history_hydrate',
        canonicalInvocationId: 'inv-new',
        originPhase: 'callback/history',
        sourcePath: 'hydration',
        messageId: 'msg-inv-1-codex',
        timestamp: 2000,
      },
      currentMessages: [existing],
    });

    expect(output.violations.length).toBeGreaterThanOrEqual(1);
    expect(output.violations.some((v) => v.violationKind === 'canonical-split')).toBe(true);
    expect(output.recoveryAction).toBe('sot-override');
  });

  // 砚砚 re-review P1 (round 2): invocationless event 不能误合并到既有"无 invocationId"消息
  it('does not merge invocationless event into existing message without invocationId (re-review P1)', () => {
    const existingLocal: ChatMessage = {
      id: 'local-thread-1-codex-500-0',
      type: 'assistant',
      catId: 'codex',
      content: 'pre-existing local',
      timestamp: 500,
      origin: 'stream',
      // No extra.stream.invocationId → local-only existing
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        canonicalInvocationId: undefined,
        messageId: undefined,
        timestamp: 1234,
        seq: 7,
        payload: { content: 'should NOT merge' },
      },
      currentMessages: [existingLocal],
    });

    // Existing untouched (still has 'pre-existing local')
    const existing = output.nextMessages.find((m) => m.id === 'local-thread-1-codex-500-0');
    expect(existing).toBeDefined();
    expect(existing?.content).toBe('pre-existing local');
    // New local-only message created (different id), not appended to existing
    expect(output.nextMessages).toHaveLength(2);
    const incoming = output.nextMessages.find((m) => m.id !== 'local-thread-1-codex-500-0');
    expect(incoming?.id).toMatch(/^local-thread-1-codex-1234-7$/);
  });

  // 砚砚 re-review round 3 P1: canonical event 必须升级 local-only placeholder
  // ADR-033 单调升级链 draft/local → stream → callback/history
  it('callback_final does NOT hijack contentful local-only placeholder (B1.2.4 narrowed from round 3 P1)', () => {
    // F183 Phase B1.2.4 (砚砚 verdict): callback 升级不复用 stream 通用 upgrade。
    // contentful invocationless local placeholder 可能属于不同 invocation 的 live stream，
    // callback 绝不能 hijack。Round 3 P1 的 "no orphan" 属性由 useAgentMessages-level
    // invocation lineage 上下文解决（explicit invocationId 路径可在 wire-up 时显式判断），
    // reducer 层接受 "orphan over hijack" tradeoff。
    const localPlaceholder: ChatMessage = {
      id: 'local-thread-1-codex-500-0',
      type: 'assistant',
      catId: 'codex',
      content: 'partial stream',
      timestamp: 500,
      isStreaming: true,
      origin: 'stream',
      // No extra.stream.invocationId → local-only placeholder
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-inv-1-codex',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [localPlaceholder],
    });

    // narrowed policy: 2 messages (standalone callback + placeholder preserved)
    expect(output.nextMessages).toHaveLength(2);
    const callback = output.nextMessages.find((m) => m.id === 'msg-inv-1-codex');
    expect(callback, 'standalone callback must be created').toBeDefined();
    expect(callback?.content).toBe('final answer');
    expect(callback?.origin).toBe('callback');
    expect(callback?.isStreaming).toBe(false);
    const placeholder = output.nextMessages.find((m) => m.id === 'local-thread-1-codex-500-0');
    expect(placeholder?.content, 'live local placeholder content must NOT be hijacked').toBe('partial stream');
  });

  it('upgrades local-only placeholder when canonical stream_chunk arrives (round 3 P1)', () => {
    const localPlaceholder: ChatMessage = {
      id: 'local-thread-1-codex-500-0',
      type: 'assistant',
      catId: 'codex',
      content: 'partial',
      timestamp: 500,
      isStreaming: true,
      origin: 'stream',
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        canonicalInvocationId: 'inv-1',
        timestamp: 800,
        payload: { content: ' continued' },
      },
      currentMessages: [localPlaceholder],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      catId: 'codex',
      content: 'partial continued',
      isStreaming: true,
      extra: { stream: { invocationId: 'inv-1' } },
    });
  });

  // 砚砚 re-review round 4 P1: 多个 local placeholder 候选时不能 heuristic merge
  // ADR-033 不变量 #6: 禁止 warn 后启发式 merge
  it('refuses heuristic upgrade when multiple local placeholders match (round 4 P1)', () => {
    const localA: ChatMessage = {
      id: 'local-thread-1-codex-100-0',
      type: 'assistant',
      catId: 'codex',
      content: 'placeholder A',
      timestamp: 100,
      isStreaming: true,
      origin: 'stream',
    };
    const localB: ChatMessage = {
      id: 'local-thread-1-codex-200-0',
      type: 'assistant',
      catId: 'codex',
      content: 'placeholder B',
      timestamp: 200,
      isStreaming: true,
      origin: 'stream',
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-1',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-inv-1-codex',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [localA, localB],
    });

    // No heuristic merge: both placeholders untouched
    expect(output.nextMessages.find((m) => m.id === 'local-thread-1-codex-100-0')?.content).toBe('placeholder A');
    expect(output.nextMessages.find((m) => m.id === 'local-thread-1-codex-200-0')?.content).toBe('placeholder B');
    // F183 Phase B1.2.4 (砚砚 round 1 P1-1): callback_final 不再被通用 ambiguous
    // guard quarantine — narrow callback policy 不 hijack contentful local placeholders，
    // 而是创建 standalone callback bubble，保留 callback authoritative content。
    expect(output.nextMessages.find((m) => m.id === 'msg-inv-1-codex')).toBeDefined();
    expect(output.nextMessages.find((m) => m.id === 'msg-inv-1-codex')?.content).toBe('final answer');
    // recoveryAction is 'none' (no quarantine) — narrow callback policy 直接走 standalone path
    expect(output.recoveryAction).not.toBe('quarantine');
  });

  // 砚砚 re-review round 5 P1: incoming proxy 必须保留 bubbleKind shape
  // 否则 deriveBubbleKindFromMessage 永远返回 assistant_text，非 text kind 的
  // canonical-split / phase-regression 都会漏检
  it('detects canonical-split for thinking incoming (round 5 P1)', () => {
    const existingThinking: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      thinking: 'older thinking',
      timestamp: 1000,
      origin: 'callback',
      extra: { stream: { invocationId: 'inv-old' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'thinking_chunk',
        canonicalInvocationId: 'inv-new',
        bubbleKind: 'thinking',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'msg-inv-1-codex',
        timestamp: 2000,
      },
      currentMessages: [existingThinking],
    });

    const violation = output.violations.find((v) => v.violationKind === 'canonical-split');
    expect(violation).toBeDefined();
    // Round 5 P1: violation.bubbleKind must reflect event.bubbleKind ('thinking'),
    // not be misderived as 'assistant_text' due to incoming proxy missing thinking shape
    expect(violation?.bubbleKind).toBe('thinking');
    expect(output.recoveryAction).toBe('sot-override');
  });

  it('detects canonical-split for tool_or_cli incoming (round 5 P1)', () => {
    const existingTool: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      toolEvents: [{ id: 't1', kind: 'tool_use', name: 'shell' } as never],
      timestamp: 1000,
      origin: 'callback',
      extra: { stream: { invocationId: 'inv-old' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        canonicalInvocationId: 'inv-new',
        bubbleKind: 'tool_or_cli',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'msg-inv-1-codex',
        timestamp: 2000,
      },
      currentMessages: [existingTool],
    });

    const violation = output.violations.find((v) => v.violationKind === 'canonical-split');
    expect(violation).toBeDefined();
    expect(violation?.bubbleKind).toBe('tool_or_cli');
    expect(output.recoveryAction).toBe('sot-override');
  });

  // 云端 codex round 6 P1: hydrated callback 无明确 streaming marker 不应被升级
  // findUpgradableLocalPlaceholders 必须 require isStreaming === true + origin === 'stream'
  it('does not upgrade hydrated callback message lacking streaming markers (round 6 P1)', () => {
    const hydratedCallback: ChatMessage = {
      id: 'msg-old-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'historical content',
      timestamp: 500,
      // No isStreaming (undefined) — common for hydrated messages
      origin: 'callback',
      // No extra.stream.invocationId — common for callback without explicit metadata
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        canonicalInvocationId: 'inv-1',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-inv-1-codex',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [hydratedCallback],
    });

    // hydratedCallback NOT upgraded — original content preserved
    const original = output.nextMessages.find((m) => m.id === 'msg-old-codex');
    expect(original).toBeDefined();
    expect(original?.content).toBe('historical content');
    // New canonical bubble created instead of hijacking historical one
    const created = output.nextMessages.find((m) => m.id === 'msg-inv-1-codex');
    expect(created).toBeDefined();
    expect(created?.content).toBe('final answer');
  });

  // 砚砚 round 7 P1: ensureMessageId canonical fallback 必须带 bubbleKind
  // 否则同 invocation 下 thinking + assistant_text 共存时 fallback id 撞车
  it('generates fallback id with bubbleKind suffix when messageId omitted (round 7 P1)', () => {
    const result = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        type: 'stream_started',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        // messageId omitted → fallback path
        timestamp: 1000,
      },
      currentMessages: [],
    });

    expect(result.nextMessages).toHaveLength(1);
    // Fallback id must include bubbleKind so coexisting kinds don't collide
    expect(result.nextMessages[0].id).toBe('msg-inv-1-codex-assistant_text');
  });

  // 砚砚 round 7 P2 修正：late stream_started phase-regression 应 quarantine 不是 catch-up
  // 仅 stream_chunk 是 B1 follow-up 已知 race exception 走 catch-up；其他 type 默认 quarantine
  it('routes late stream_started after callback to quarantine with violation (round 7 P2)', () => {
    const finalized: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'final answer',
      timestamp: 1500,
      isStreaming: false,
      origin: 'callback',
      extra: { stream: { invocationId: 'inv-1' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_started',
        timestamp: 1600,
      },
      currentMessages: [finalized],
    });

    expect(output.recoveryAction).toBe('quarantine');
    expect(output.violations.some((v) => v.violationKind === 'phase-regression')).toBe(true);
  });

  // 砚砚 round 8 P2: 同 ts 无 seq 的两个 invocationless events 必须生成不同 id
  // event.seq ?? 0 会让 fallback id 撞车
  it('generates unique fallback ids for invocationless events with same timestamp and no seq (round 8 P2)', () => {
    const evt = () => ({
      type: 'stream_started' as const,
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: undefined,
      bubbleKind: 'assistant_text' as const,
      originPhase: 'stream' as const,
      sourcePath: 'active' as const,
      messageId: undefined,
      timestamp: 1000,
      // seq omitted intentionally
    });

    const r1 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: [] });
    const r2 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: r1.nextMessages });

    expect(r1.nextMessages).toHaveLength(1);
    expect(r2.nextMessages).toHaveLength(2);
    const ids = r2.nextMessages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2); // distinct ids, no collision
  });

  // 砚砚 round 9 P2: reducer 必须 deterministic — 同输入必须同输出
  it('produces deterministic id for same input + same currentMessages (round 9 P2)', () => {
    const evt = () => ({
      type: 'stream_started' as const,
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: undefined,
      bubbleKind: 'assistant_text' as const,
      originPhase: 'stream' as const,
      sourcePath: 'active' as const,
      messageId: undefined,
      timestamp: 1000,
    });

    const out1 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: [] });
    const out2 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: [] });

    // Same input + same currentMessages → same output id (no hidden mutable state)
    expect(out1.nextMessages[0].id).toBe(out2.nextMessages[0].id);
  });

  // 砚砚 round 10 P2: deriveLocalFallbackSeq 必须 max+1 不是 count
  // count 路径在 suffix 有 gap 时复用已存在 id（如已有 -1 但缺 -0，count=1 → -1 撞）
  it('does not collide with existing local id when suffix has gap (round 10 P2)', () => {
    const existing: ChatMessage = {
      id: 'local-thread-1-codex-1000-1',
      type: 'assistant',
      catId: 'codex',
      content: 'existing local with non-zero suffix',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
    };

    const result = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        type: 'stream_started',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: undefined,
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: undefined,
        timestamp: 1000,
      },
      currentMessages: [existing],
    });

    expect(result.nextMessages).toHaveLength(2);
    const ids = result.nextMessages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2); // distinct, no collision with -1
  });

  // 砚砚 round 11 P1: timestamp ?? Date.now() 让 reducer 非确定性
  // 同 input + 缺 timestamp + 缺 canonical id → 多次 apply 必须同 output id
  it('produces deterministic id when event.timestamp is omitted (round 11 P1)', () => {
    const evt = () => ({
      type: 'stream_started' as const,
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: undefined,
      bubbleKind: 'assistant_text' as const,
      originPhase: 'stream' as const,
      sourcePath: 'active' as const,
      messageId: undefined,
      // timestamp omitted intentionally
    });

    const r1 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: [] });
    const r2 = applyBubbleEvent({ threadId: 'thread-1', event: evt(), currentMessages: [] });

    // Same input → same output id (no Date.now() leakage)
    expect(r1.nextMessages[0].id).toBe(r2.nextMessages[0].id);
  });

  // 砚砚 round 12 P1: callback_final 命中 stream placeholder 时必须升级 id 到 backend messageId
  // 否则 stream fallback id 会持续保留，破坏 hydration / id-based reconciliation
  it('upgrades stream placeholder id to backend messageId on callback_final (round 12 P1)', () => {
    const streamBubble: ChatMessage = {
      id: 'msg-inv-1-codex-assistant_text', // fallback id (no backend messageId during streaming)
      type: 'assistant',
      catId: 'codex',
      content: 'streaming...',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
    };

    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        messageId: 'backend-id-real-001',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        timestamp: 1500,
        payload: { content: 'final answer' },
      },
      currentMessages: [streamBubble],
    });

    expect(output.nextMessages).toHaveLength(1);
    // id MUST be upgraded to backend messageId, not stay as fallback
    expect(output.nextMessages[0].id).toBe('backend-id-real-001');
    expect(output.nextMessages[0].content).toBe('final answer');
    expect(output.nextMessages[0].isStreaming).toBe(false);
  });

  // 砚砚 review P2: 缺 canonical id 必须用 local-only id，不能造稳定-looking id
  it('uses local-only id when canonicalInvocationId missing, not "placeholder" magic (P2)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        canonicalInvocationId: undefined,
        messageId: undefined,
        timestamp: 1234,
        seq: 7,
      },
      currentMessages: [],
    });

    expect(output.nextMessages).toHaveLength(1);
    const id = output.nextMessages[0].id;
    expect(id).not.toContain('placeholder');
    expect(id).toMatch(/^local-thread-1-codex-1234-7$/);
  });

  // F183 Phase B1.3 — reducer expansion: done / error / timeout terminal events.
  // done: invocation lifecycle marker → finalize matching streaming bubbles
  //       (no new bubble; mark isStreaming=false on stable-key match).
  // error / timeout: visible system_status bubble carrying the error message.

  it('B1.3: done event marks existing streaming bubble isStreaming=false (preserves content + id)', () => {
    const streaming = streamPlaceholder({ content: 'partial answer' });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'done',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
      },
      currentMessages: [streaming],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      content: 'partial answer',
      isStreaming: false,
    });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.3: done event finalizes ALL bubbles for the same invocation+cat (text + tool/rich co-existing)', () => {
    const text = streamPlaceholder({ id: 'text-1', content: 'analysis', isStreaming: true });
    const tool = streamPlaceholder({
      id: 'tool-1',
      content: '',
      isStreaming: true,
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read', timestamp: 900 }],
    });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'done',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
      },
      currentMessages: [text, tool],
    });

    expect(output.nextMessages).toHaveLength(2);
    expect(output.nextMessages[0]).toMatchObject({ id: 'text-1', isStreaming: false });
    expect(output.nextMessages[1]).toMatchObject({ id: 'tool-1', isStreaming: false });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.3: done event no-op when no matching bubble for invocation+cat (silent, no violation)', () => {
    const otherInv = streamPlaceholder({
      id: 'msg-inv-2-codex',
      content: 'other invocation alive',
      extra: { stream: { invocationId: 'inv-2' } },
    });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'done',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
      },
      currentMessages: [otherInv],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({ id: 'msg-inv-2-codex', isStreaming: true });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.3: invocationless done is reducer no-op (lifecycle handled by side-effects in caller)', () => {
    const streaming = streamPlaceholder({ content: 'streaming' });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'done',
        canonicalInvocationId: undefined,
        bubbleKind: 'system_status',
        timestamp: 1500,
      },
      currentMessages: [streaming],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({ isStreaming: true });
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.3: error event adds visible system error bubble with cat + content', () => {
    const streaming = streamPlaceholder({ content: 'streaming when error fires' });
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: { error: 'Provider returned 503' },
      },
      currentMessages: [streaming],
    });

    expect(output.nextMessages).toHaveLength(2);
    // Existing assistant_text bubble preserved (error doesn't auto-finalize streaming;
    // that's the caller's terminal-orchestration responsibility).
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      content: 'streaming when error fires',
      isStreaming: true,
    });
    // New system_status bubble carries the error.
    expect(output.nextMessages[1]).toMatchObject({
      type: 'system',
      variant: 'error',
      catId: 'codex',
      content: 'Error: Provider returned 503',
    });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.3: timeout event adds visible system error bubble (same shape as error)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'timeout',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: { error: 'Stream timed out' },
      },
      currentMessages: [],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      type: 'system',
      variant: 'error',
      catId: 'codex',
      content: 'Error: Stream timed out',
    });
    expect(output.recoveryAction).toBe('none');
  });

  // 砚砚 R1 P1 (B1.3 review): repeated error/timeout for same canonical invocation
  // must NOT duplicate system_status bubble — ADR-033 不变量 #4 同
  // (actor, invocationId, kind) 唯一性也覆盖 system_status。
  // Fix: errorBubble 带 extra.stream.invocationId；findExistingByStableKey 命中时
  // 替换同一 bubble 内容，不追加第二条。invocationless error 不参与 stable key（ADR
  // #4 invocationless 是 local-only），允许追加 standalone bubble。
  it('B1.3 砚砚 R1 P1: repeated error for same invocation updates same system_status bubble (no duplicate id)', () => {
    const first = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: { error: 'first error' },
      },
      currentMessages: [],
    });
    expect(first.nextMessages).toHaveLength(1);
    expect(first.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex-system_status',
      type: 'system',
      variant: 'error',
      content: 'Error: first error',
    });
    expect(first.violations).toEqual([]);

    const second = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1600,
        payload: { error: 'second error (more detail)' },
      },
      currentMessages: first.nextMessages,
    });
    // CRITICAL: second error replaces first bubble's content, no duplicate
    expect(second.nextMessages).toHaveLength(1);
    expect(second.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex-system_status',
      type: 'system',
      variant: 'error',
      content: 'Error: second error (more detail)',
    });
    expect(second.violations).toEqual([]);
    expect(second.recoveryAction).toBe('none');
  });

  it('B1.3 砚砚 R1 P1: timeout after error for same invocation also dedups to same system_status bubble', () => {
    const errorRes = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: { error: 'transient error' },
      },
      currentMessages: [],
    });
    const timeoutRes = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'timeout',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1700,
        payload: { error: 'stream timeout' },
      },
      currentMessages: errorRes.nextMessages,
    });
    expect(timeoutRes.nextMessages).toHaveLength(1);
    expect(timeoutRes.nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex-system_status',
      content: 'Error: stream timeout',
    });
    expect(timeoutRes.violations).toEqual([]);
  });

  it('B1.3 砚砚 R1 P1: invocationless error appends standalone bubble with local-only id (no stable key)', () => {
    const first = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        canonicalInvocationId: undefined,
        messageId: undefined,
        timestamp: 1500,
        seq: 0,
        payload: { error: 'first invocationless' },
      },
      currentMessages: [],
    });
    const second = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        canonicalInvocationId: undefined,
        messageId: undefined,
        timestamp: 1600,
        seq: 1,
        payload: { error: 'second invocationless' },
      },
      currentMessages: first.nextMessages,
    });
    // invocationless events are local-only — both errors stand alone with distinct ids
    expect(second.nextMessages).toHaveLength(2);
    expect(second.nextMessages[0].id).not.toBe(second.nextMessages[1].id);
    expect(second.nextMessages[0].id.startsWith('local-')).toBe(true);
    expect(second.nextMessages[1].id.startsWith('local-')).toBe(true);
  });

  it('B1.3: error event with no payload.error falls back to "Unknown error"', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
      },
      currentMessages: [],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].content).toBe('Error: Unknown error');
  });

  // F183 Phase B1.4 — invocationless callback wire-up via reducer。
  // 旧 path: replacementTarget (recently finalized stream bubble) + patchMessage 直接修改。
  // 新 path: 把 replacementTarget.id 当 messageId hint 传给 reducer；reducer 在 invocationless
  // event + messageId hit 现有气泡时就地 patch（不创建新 standalone bubble）。
  it('B1.4: invocationless callback with messageId hint patches existing bubble in place', () => {
    const existing: ChatMessage = {
      id: 'msg-stream-target',
      type: 'assistant',
      catId: 'codex',
      content: 'partial stream content',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      // invocationless — 真实 replacementTarget 场景：rich/tool placeholder 没绑 invocationId
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: undefined, // invocationless
        bubbleKind: 'assistant_text',
        messageId: 'msg-stream-target', // hint: patch this id
        timestamp: 1500,
        payload: { content: 'final callback answer' },
      },
      currentMessages: [existing],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-stream-target',
      content: 'final callback answer',
      isStreaming: false,
      origin: 'callback',
    });
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.4: invocationless callback with messageId hint pointing to non-existent bubble falls back to makePlaceholder (creates new)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: undefined,
        bubbleKind: 'assistant_text',
        messageId: 'msg-cb-fresh-id',
        timestamp: 1500,
        payload: { content: 'standalone callback' },
      },
      currentMessages: [], // no target bubble
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      id: 'msg-cb-fresh-id',
      content: 'standalone callback',
      isStreaming: false,
      origin: 'callback',
    });
  });

  // F183 Phase B1.5 — error reducer enrichment for active path wire-up:
  // caller pre-builds rich display content (errorSubtype labels) + extra.timeoutDiagnostics,
  // passes via payload.content + payload.extra. reduceErrorEvent uses these as-is.
  it('B1.5: error event with payload.content uses it as full display text (no Error: prefix added)', () => {
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: { content: 'Error: Provider returned 503 (运行时错误)' },
      },
      currentMessages: [],
    });
    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      type: 'system',
      variant: 'error',
      content: 'Error: Provider returned 503 (运行时错误)',
    });
  });

  it('B1.5: error event with payload.extra merges into bubble.extra (timeoutDiagnostics)', () => {
    const diagnostics = {
      silenceDurationMs: 30000,
      processAlive: true,
      lastEventType: 'text',
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'error',
        bubbleKind: 'system_status',
        messageId: undefined,
        timestamp: 1500,
        payload: {
          content: 'Error: Stream timed out',
          extra: { timeoutDiagnostics: diagnostics },
        },
      },
      currentMessages: [],
    });
    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      content: 'Error: Stream timed out',
      extra: expect.objectContaining({
        timeoutDiagnostics: diagnostics,
      }),
    });
  });

  it('B1.4: invocationless callback WITHOUT messageId hint creates standalone bubble (no hijack of unrelated existing bubble)', () => {
    // 没 messageId hint 时不能扫所有气泡找 invocationless target —— 那会 hijack
    // 别的 invocation 的 stream bubble。caller 没传 hint = caller 不知道 patch 哪条 = 创建新
    const unrelated: ChatMessage = {
      id: 'msg-unrelated',
      type: 'assistant',
      catId: 'codex',
      content: 'unrelated stream',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'callback_final',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        canonicalInvocationId: undefined,
        bubbleKind: 'assistant_text',
        messageId: undefined, // NO hint
        timestamp: 1500,
        payload: { content: 'orphan callback' },
      },
      currentMessages: [unrelated],
    });

    // unrelated 留着；callback 落 standalone 新 bubble
    expect(output.nextMessages).toHaveLength(2);
    expect(output.nextMessages.find((m) => m.id === 'msg-unrelated')).toMatchObject({
      content: 'unrelated stream',
      isStreaming: true,
      origin: 'stream',
    });
    expect(output.nextMessages.find((m) => m.id !== 'msg-unrelated')).toMatchObject({
      content: 'orphan callback',
      isStreaming: false,
      origin: 'callback',
    });
  });

  // F183 Phase B1.6 — tool_event reducer: append toolEvent to existing
  // assistant_text bubble's toolEvents field (UI-compat data model). 当前 UI
  // 把 tool events 当 assistant_text 子字段 toolEvents 渲染，reducer 维持这个
  // 约定不另开 tool_or_cli kind bubble（ADR-033 设计的 tool_or_cli 独立 bubble
  // 留给后续 UI 重构落地）。
  it('B1.6: tool_event appends toolEvent to existing assistant_text bubble for same invocation', () => {
    const existingText: ChatMessage = {
      id: 'msg-inv-tool-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'analyzing...',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-tool' } },
    };
    const toolEvent = {
      id: 'te-1',
      type: 'tool_use' as const,
      label: 'codex → Read',
      detail: '{"path":"/foo"}',
      timestamp: 1100,
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-tool',
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent },
      },
      currentMessages: [existingText],
    });

    expect(output.nextMessages).toHaveLength(1);
    const updated = output.nextMessages[0];
    expect(updated.id).toBe('msg-inv-tool-codex');
    expect(updated.toolEvents).toHaveLength(1);
    expect(updated.toolEvents?.[0]).toEqual(toolEvent);
    expect(output.violations).toEqual([]);
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.6: tool_event appends to existing toolEvents array (preserves prior events)', () => {
    const priorEvent = { id: 'te-0', type: 'tool_use' as const, label: 'codex → list', timestamp: 900 };
    const existingText: ChatMessage = {
      id: 'msg-inv-tool2-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-tool2' } },
      toolEvents: [priorEvent],
    };
    const newEvent = {
      id: 'te-1',
      type: 'tool_result' as const,
      label: 'codex ← result',
      detail: 'ok',
      timestamp: 1200,
    };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-tool2',
        messageId: undefined,
        timestamp: 1200,
        payload: { toolEvent: newEvent },
      },
      currentMessages: [existingText],
    });

    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0].toolEvents).toEqual([priorEvent, newEvent]);
  });

  it('B1.6: tool_event with no existing assistant bubble is reducer no-op (caller seeds via legacy)', () => {
    // 砚砚 R1 P1 (B1.6 review): empty content + toolEvents 的 placeholder 跟后续
    // stream_chunk(assistant_text) 会触发 canonical-split。改成 no-op，由 caller
    // (active path 的 ensureActiveAssistantMessage / bg 的等价语义) 负责 bubble
    // 的创建出口。reducer 在此场景下不修改 messages，wire-up 通过引用相等检测
    // no-op 后回退 legacy appendToolEvent。
    const toolEvent = {
      id: 'te-2',
      type: 'tool_use' as const,
      label: 'codex → Run',
      timestamp: 1100,
    };
    const currentMessages: ChatMessage[] = [];
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-fresh',
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent },
      },
      currentMessages,
    });

    expect(output.nextMessages).toBe(currentMessages); // 引用相等：reducer 没改
    expect(output.recoveryAction).toBe('none');
  });

  it('B1.6: cli_output event uses same path as tool_event (UI compat) — no-op when no existing bubble', () => {
    const cliEvent = { id: 'cli-1', type: 'cli_output' as const, label: 'stdout', detail: 'hello', timestamp: 1100 };
    const currentMessages: ChatMessage[] = [];
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'cli_output',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-cli',
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent: cliEvent },
      },
      currentMessages,
    });

    expect(output.nextMessages).toBe(currentMessages); // 引用相等：reducer 没改
    expect(output.recoveryAction).toBe('none');
  });

  // F183 Phase B1.6 (砚砚 R2 P1 regression test): active path 真实序列。
  // 1) caller (ensureActiveAssistantMessage) seed empty assistant_text bubble；
  // 2) tool_event arrives → reducer append toolEvent；
  // 3) stream_chunk(same id, bubbleKind='assistant_text') arrives；
  // 4) 关键：没 canonical-split violation, content 落到同一气泡, toolEvents 保留。
  // 这个序列在 R2 之前会因为 step 2 后的 bubble 推断成 tool_or_cli + step 3
  // incoming assistant_text 不同 stable key 触发 canonical-split + sot-override
  // 让 text content 丢失。R2 修法：deriveBubbleKindFromMessage 把 stream-bound
  // streaming UI-compat container（empty + toolEvents + isStreaming + origin='stream'
  // + invocationId）视作 assistant_text。
  it('B1.6 砚砚 R2 P1: seed → tool_event → stream_chunk same id 不触发 canonical-split, content + toolEvents 共存', () => {
    // step 1: seed (legacy ensureActiveAssistantMessage 的等价产物)
    const seed: ChatMessage = {
      id: 'msg-inv-tool-seq-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-tool-seq' } },
    };

    // step 2: tool_event → reducer append toolEvent on existing bubble
    const toolEvent = { id: 'te-1', type: 'tool_use' as const, label: 'codex → Read', timestamp: 1100 };
    const r1 = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-tool-seq',
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent },
      },
      currentMessages: [seed],
    });
    expect(r1.recoveryAction).toBe('none');
    expect(r1.nextMessages).toHaveLength(1);
    expect(r1.nextMessages[0].toolEvents).toHaveLength(1);

    // step 3: stream_chunk same id, bubbleKind='assistant_text'
    const r2 = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'stream_chunk',
        bubbleKind: 'assistant_text',
        canonicalInvocationId: 'inv-tool-seq',
        messageId: 'msg-inv-tool-seq-codex',
        timestamp: 1200,
        payload: { content: 'analysis text' },
      },
      currentMessages: r1.nextMessages,
    });

    // step 4: 关键断言 — 无 violation + content 落 + toolEvents 保留
    expect(r2.recoveryAction).toBe('none');
    expect(r2.violations).toEqual([]);
    expect(r2.nextMessages).toHaveLength(1);
    expect(r2.nextMessages[0]).toMatchObject({
      id: 'msg-inv-tool-seq-codex',
      content: 'analysis text',
    });
    expect(r2.nextMessages[0].toolEvents).toHaveLength(1);
  });

  // F183 follow-up (2026-05-04): live path can receive thinking before tools/text.
  // ensureActiveAssistantMessage seeds the canonical stream container, then
  // setMessageThinking fills `thinking`. That container is still the user-facing
  // assistant_text bubble; later tool/text events must land on it instead of
  // splitting into a second bubble that disappears only after F5/history hydrate.
  it('F183-R: thinking-first canonical stream container accepts tool_event + stream_chunk without phantom split', () => {
    const seedWithThinking: ChatMessage = {
      id: 'msg-inv-thinking-first-opus',
      type: 'assistant',
      catId: 'opus',
      content: '',
      thinking: 'same thinking preview',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-thinking-first' } },
    };

    const toolEvent = { id: 'te-thinking-first', type: 'tool_use' as const, label: 'opus → rg', timestamp: 1100 };
    const afterTool = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        actorId: 'opus',
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-thinking-first',
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent },
      },
      currentMessages: [seedWithThinking],
    });

    expect(afterTool.recoveryAction).toBe('none');
    expect(afterTool.violations).toEqual([]);
    expect(afterTool.nextMessages).toHaveLength(1);
    expect(afterTool.nextMessages[0]).toMatchObject({
      id: 'msg-inv-thinking-first-opus',
      thinking: 'same thinking preview',
    });
    expect(afterTool.nextMessages[0].toolEvents).toEqual([toolEvent]);

    const afterText = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        actorId: 'opus',
        type: 'stream_chunk',
        bubbleKind: 'assistant_text',
        canonicalInvocationId: 'inv-thinking-first',
        messageId: 'msg-inv-thinking-first-opus',
        timestamp: 1200,
        payload: { content: 'visible stdout' },
      },
      currentMessages: afterTool.nextMessages,
    });

    expect(afterText.recoveryAction).toBe('none');
    expect(afterText.violations).toEqual([]);
    expect(afterText.nextMessages).toHaveLength(1);
    expect(afterText.nextMessages[0]).toMatchObject({
      id: 'msg-inv-thinking-first-opus',
      content: 'visible stdout',
      thinking: 'same thinking preview',
    });
    expect(afterText.nextMessages[0].toolEvents).toEqual([toolEvent]);
  });

  it('F183-R: finalized thinking-first canonical stream container accepts late stream_chunk without phantom split', () => {
    const seedWithThinking: ChatMessage = {
      id: 'msg-inv-late-thinking-opus',
      type: 'assistant',
      catId: 'opus',
      content: '',
      thinking: 'same thinking preview',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-late-thinking' } },
    };

    const afterDone = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        actorId: 'opus',
        type: 'done',
        bubbleKind: 'assistant_text',
        canonicalInvocationId: 'inv-late-thinking',
        messageId: 'msg-inv-late-thinking-opus',
        timestamp: 1100,
      },
      currentMessages: [seedWithThinking],
    });

    expect(afterDone.recoveryAction).toBe('none');
    expect(afterDone.nextMessages).toHaveLength(1);
    expect(afterDone.nextMessages[0]).toMatchObject({
      id: 'msg-inv-late-thinking-opus',
      isStreaming: false,
      thinking: 'same thinking preview',
    });

    const afterLateText = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        actorId: 'opus',
        type: 'stream_chunk',
        bubbleKind: 'assistant_text',
        canonicalInvocationId: 'inv-late-thinking',
        messageId: 'msg-inv-late-thinking-opus',
        timestamp: 1200,
        payload: { content: 'late stdout' },
      },
      currentMessages: afterDone.nextMessages,
    });

    expect(afterLateText.recoveryAction).toBe('none');
    expect(afterLateText.violations).toEqual([]);
    expect(afterLateText.nextMessages).toHaveLength(1);
    expect(afterLateText.nextMessages[0]).toMatchObject({
      id: 'msg-inv-late-thinking-opus',
      content: 'late stdout',
      thinking: 'same thinking preview',
      isStreaming: false,
    });
  });

  // F183 Phase B1.6 (cloud P1): reduceToolEvent must restrict target to
  // assistant_text bubbles. ADR-033 允许 thinking + assistant_text 在同
  // invocation 共存；如果 reducer 不区分 kind 直接拿第一个 streaming assistant
  // bubble，tool event 会落到 thinking bubble，UI-compat 模型 (toolEvents on
  // assistant_text) 失败。
  it('B1.6 cloud P1: reduceToolEvent only appends toolEvent to assistant_text bubble (not thinking) when both co-exist', () => {
    const thinkingBubble: ChatMessage = {
      id: 'msg-thinking-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      thinking: 'reasoning step 1',
      timestamp: 1000,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-coexist' } },
    };
    const assistantTextBubble: ChatMessage = {
      id: 'msg-text-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'partial answer',
      timestamp: 1100,
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-coexist' } },
    };
    const toolEvent = { id: 'te-1', type: 'tool_use' as const, label: 'codex → Read', timestamp: 1200 };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: 'inv-coexist',
        messageId: undefined,
        timestamp: 1200,
        payload: { toolEvent },
      },
      currentMessages: [thinkingBubble, assistantTextBubble],
    });

    // 两条 bubble 都保留
    expect(output.nextMessages).toHaveLength(2);
    // thinking bubble 不应该收到 toolEvent
    const thinkingAfter = output.nextMessages.find((m) => m.id === 'msg-thinking-codex');
    expect(thinkingAfter?.toolEvents).toBeUndefined();
    // assistant_text bubble 应该收到 toolEvent
    const textAfter = output.nextMessages.find((m) => m.id === 'msg-text-codex');
    expect(textAfter?.toolEvents).toHaveLength(1);
    expect(textAfter?.toolEvents?.[0]).toEqual(toolEvent);
  });

  // F183 follow-up (R2/R4/R5 close blocker, 2026-05-02): 铲屎官 报告
  // A→B→A 模式下第二个 A 的回复会"滑到第一个 A 的折叠里"。砚砚 R1 怀疑
  // store 层 invocation binding 错（或 UI sort/collapse 错）。用 RED probe
  // 先把 store 层钉死：reducer 应该按 (catId, invocationId, bubbleKind)
  // 三件套创建 3 条独立稳定气泡。
  describe('F183 follow-up: A→B→A invocation binding', () => {
    function eventFor(
      actor: string,
      inv: string,
      type: BubbleReducerInput['event']['type'],
      content?: string,
    ): BubbleReducerInput['event'] {
      return {
        type,
        threadId: 'thread-1',
        actorId: actor,
        canonicalInvocationId: inv,
        bubbleKind: 'assistant_text',
        originPhase: type === 'callback_final' ? 'callback/history' : 'stream',
        sourcePath: type === 'callback_final' ? 'callback' : 'active',
        messageId: `msg-${inv}-${actor}`,
        timestamp: Date.now(),
        ...(content ? { payload: { content } } : {}),
      };
    }

    it('A→B→A reducer keeps 3 stable bubbles, A2 content NOT in A1', () => {
      // Step 1: A inv-A1 stream + content
      let { nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('opus', 'inv-A1', 'stream_chunk', 'A1 first reply'),
        currentMessages: [],
      });
      expect(nextMessages).toHaveLength(1);
      expect(nextMessages[0]?.content).toBe('A1 first reply');

      // Step 2: B inv-B1 stream + content
      ({ nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('codex', 'inv-B1', 'stream_chunk', 'B1 reply'),
        currentMessages: nextMessages,
      }));
      expect(nextMessages).toHaveLength(2);
      expect(nextMessages.find((m) => m.catId === 'codex')?.content).toBe('B1 reply');

      // Step 3: A inv-A2 (NEW invocation) stream + content
      ({ nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('opus', 'inv-A2', 'stream_chunk', 'A2 second reply'),
        currentMessages: nextMessages,
      }));

      // CRITICAL: 3 stable bubbles, A2 must be its own bubble (different id),
      // A2 content must NOT appear in A1 bubble (no soft-merge / no collapse)
      expect(nextMessages).toHaveLength(3);
      const a1 = nextMessages.find((m) => m.id === 'msg-inv-A1-opus');
      const b1 = nextMessages.find((m) => m.id === 'msg-inv-B1-codex');
      const a2 = nextMessages.find((m) => m.id === 'msg-inv-A2-opus');
      expect(a1?.content).toBe('A1 first reply');
      expect(a1?.content).not.toContain('A2 second reply');
      expect(b1?.content).toBe('B1 reply');
      expect(a2).toBeDefined();
      expect(a2?.content).toBe('A2 second reply');
      // Order: A1 → B1 → A2 (insertion order)
      expect(nextMessages.map((m) => m.id)).toEqual(['msg-inv-A1-opus', 'msg-inv-B1-codex', 'msg-inv-A2-opus']);
    });

    it('A→B→A with callback_final: each invocation finalized separately, no cross-contamination', () => {
      // Mirror the production flow: stream → callback_final per invocation
      let { nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('opus', 'inv-A1', 'callback_final', 'A1 final'),
        currentMessages: [],
      });
      ({ nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('codex', 'inv-B1', 'callback_final', 'B1 final'),
        currentMessages: nextMessages,
      }));
      ({ nextMessages } = applyBubbleEvent({
        threadId: 'thread-1',
        event: eventFor('opus', 'inv-A2', 'callback_final', 'A2 final'),
        currentMessages: nextMessages,
      }));

      expect(nextMessages).toHaveLength(3);
      expect(nextMessages.find((m) => m.id === 'msg-inv-A1-opus')?.content).toBe('A1 final');
      expect(nextMessages.find((m) => m.id === 'msg-inv-A1-opus')?.content).not.toContain('A2 final');
      expect(nextMessages.find((m) => m.id === 'msg-inv-B1-codex')?.content).toBe('B1 final');
      expect(nextMessages.find((m) => m.id === 'msg-inv-A2-opus')?.content).toBe('A2 final');
    });
  });

  it('B1.6: invocationless tool_event is reducer no-op (caller still drives via legacy)', () => {
    const toolEvent = { id: 'te-3', type: 'tool_use' as const, label: 'codex → noop', timestamp: 1100 };
    const output = applyBubbleEvent({
      threadId: 'thread-1',
      event: {
        ...baseEvent(),
        type: 'tool_event',
        bubbleKind: 'tool_or_cli',
        canonicalInvocationId: undefined, // invocationless
        messageId: undefined,
        timestamp: 1100,
        payload: { toolEvent },
      },
      currentMessages: [],
    });
    expect(output.nextMessages).toHaveLength(0);
    expect(output.recoveryAction).toBe('none');
  });
});
