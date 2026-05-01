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
  it('upgrades local-only placeholder when canonical callback_final arrives (round 3 P1)', () => {
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

    // No orphan: exactly 1 message (placeholder upgraded, not duplicated)
    expect(output.nextMessages).toHaveLength(1);
    expect(output.nextMessages[0]).toMatchObject({
      catId: 'codex',
      content: 'final answer',
      isStreaming: false,
      origin: 'callback',
      extra: { stream: { invocationId: 'inv-1' } },
    });
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
    // Event quarantined: no new canonical bubble created from the ambiguous upgrade
    expect(output.nextMessages.find((m) => m.id === 'msg-inv-1-codex')).toBeUndefined();
    expect(output.recoveryAction).toBe('quarantine');
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
});
