import { describe, expect, it } from 'vitest';
import { adaptIncomingToBubbleEvent } from '@/hooks/bubble-event-adapter';
import type { BackgroundAgentMessage } from '@/hooks/useAgentMessages';

function baseMsg(overrides: Partial<BackgroundAgentMessage> = {}): BackgroundAgentMessage {
  return {
    type: 'text',
    threadId: 'thread-1',
    catId: 'codex',
    timestamp: 1000,
    invocationId: 'inv-1',
    ...overrides,
  };
}

describe('F183 Phase B1.2 — adaptIncomingToBubbleEvent', () => {
  it('maps text stream msg to stream_chunk + assistant_text', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'text', content: 'hello', origin: 'stream' }), {
      sourcePath: 'active',
    });

    expect(event).toMatchObject({
      type: 'stream_chunk',
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: 'inv-1',
      bubbleKind: 'assistant_text',
      originPhase: 'stream',
      sourcePath: 'active',
      timestamp: 1000,
      payload: { content: 'hello' },
    });
  });

  it('maps text callback msg to callback_final + assistant_text', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'text', content: 'final answer', origin: 'callback', messageId: 'backend-id-1' }),
      { sourcePath: 'callback' },
    );

    expect(event).toMatchObject({
      type: 'callback_final',
      bubbleKind: 'assistant_text',
      originPhase: 'callback/history',
      sourcePath: 'callback',
      messageId: 'backend-id-1',
      payload: { content: 'final answer' },
    });
  });

  it('maps thinking msg to thinking_chunk + thinking kind', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'thinking', content: 'pondering...' }), {
      sourcePath: 'active',
    });

    expect(event).toMatchObject({
      type: 'thinking_chunk',
      bubbleKind: 'thinking',
      originPhase: 'stream',
      payload: { content: 'pondering...' },
    });
  });

  it('maps tool_use msg to tool_event + tool_or_cli kind', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'tool_use', toolName: 'shell', toolInput: { cmd: 'ls' } }),
      { sourcePath: 'active' },
    );

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'tool_event',
      bubbleKind: 'tool_or_cli',
      originPhase: 'stream',
    });
    expect(event?.payload).toMatchObject({ toolName: 'shell', toolInput: { cmd: 'ls' } });
  });

  it('maps rich_block msg to rich_block event + rich_block kind', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'rich_block' }), { sourcePath: 'active' });

    expect(event).toMatchObject({
      type: 'rich_block',
      bubbleKind: 'rich_block',
      originPhase: 'stream',
    });
  });

  // 砚砚 round 1 P2: timeout msg 必须归入 system_status 并 emit timeout event
  it('maps timeout msg to timeout event + system_status kind (round 1 P2)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'timeout', catId: 'system' }), {
      sourcePath: 'active',
    });

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'timeout',
      bubbleKind: 'system_status',
      actorId: 'system',
    });
  });

  // 砚砚 round 1 P1: system_info 显式 isFinal 才 emit done event
  it('maps system_info with isFinal to done event + system_status kind (round 1 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'system_info', catId: 'system', isFinal: true }), {
      sourcePath: 'active',
    });

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'done',
      bubbleKind: 'system_status',
      actorId: 'system',
    });
  });

  // 砚砚 round 1 P1: non-terminal system_info 不应误触 terminal done event
  it('returns undefined for non-terminal system_info (round 1 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'system_info', catId: 'system' }), {
      sourcePath: 'active',
    });

    expect(event).toBeUndefined();
  });

  // 砚砚 round 1 P1: a2a_handoff 不是 BubbleEvent type，adapter 不应误转 done
  it('returns undefined for a2a_handoff (round 1 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'a2a_handoff' }), {
      sourcePath: 'active',
    });

    expect(event).toBeUndefined();
  });

  // 砚砚 round 1 P1: system_info with error → error event
  it('maps system_info with error to error event + system_status kind (round 1 P1)', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'system_info', catId: 'system', error: 'something went wrong' }),
      { sourcePath: 'active' },
    );

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'error',
      bubbleKind: 'system_status',
    });
  });

  // 砚砚 round 2 P1: direct msg.type='done' 不能落 assistant_text stable key
  it('maps direct done msg to done event + system_status kind (round 2 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'done', catId: 'codex' }), {
      sourcePath: 'active',
    });

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'done',
      bubbleKind: 'system_status',
      actorId: 'codex',
    });
    // 关键：terminal control event 不能挂在 text bubble 上
    expect(event?.bubbleKind).not.toBe('assistant_text');
  });

  // 砚砚 round 2 P1: direct msg.type='error' 不能落 assistant_text stable key
  it('maps direct error msg to error event + system_status kind (round 2 P1)', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'error', catId: 'codex', error: 'boom', errorCode: 'E_PROVIDER' }),
      { sourcePath: 'active' },
    );

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'error',
      bubbleKind: 'system_status',
      actorId: 'codex',
    });
    expect(event?.payload).toMatchObject({ error: 'boom', errorCode: 'E_PROVIDER' });
    // 关键：terminal control event 不能挂在 text bubble 上
    expect(event?.bubbleKind).not.toBe('assistant_text');
  });

  // 砚砚 round 3 P1 (云端 codex): unknown control msg.type='status' 不能默认 assistant_text
  it('returns undefined for control msg.type=status (round 3 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'status', catId: 'codex' }), {
      sourcePath: 'active',
    });

    // 关键：unknown control msg 不能落 assistant_text stable key — caller 走 chatStore.addMessage
    expect(event).toBeUndefined();
  });

  // 砚砚 round 3 P1 (云端 codex): unknown control msg.type='provider_signal' 不能默认 assistant_text
  it('returns undefined for control msg.type=provider_signal (round 3 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'provider_signal', catId: 'codex' }), {
      sourcePath: 'active',
    });

    expect(event).toBeUndefined();
  });

  // 砚砚 round 3 P1: 未来新增的未知 type 也不能默认 assistant_text + stream_chunk
  it('returns undefined for unknown future msg.type (round 3 P1)', () => {
    const event = adaptIncomingToBubbleEvent(baseMsg({ type: 'unknown_future_type', catId: 'codex' }), {
      sourcePath: 'active',
    });

    expect(event).toBeUndefined();
  });

  // 云端 codex round 5 P1: textMode='replace' 必须透传到 payload
  it('preserves textMode=replace in payload (round 5 P1)', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'text', origin: 'stream', content: 'overwrite this', textMode: 'replace' }),
      { sourcePath: 'active' },
    );

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'stream_chunk',
      bubbleKind: 'assistant_text',
      payload: { content: 'overwrite this', textMode: 'replace' },
    });
  });

  // 云端 codex round 5 P1: textMode='append'（默认）也透传
  it('preserves textMode=append in payload when explicitly set (round 5 P1)', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'text', origin: 'stream', content: 'add', textMode: 'append' }),
      { sourcePath: 'active' },
    );

    expect(event?.payload).toMatchObject({ textMode: 'append' });
  });

  // 云端 codex round 4 P1: text + isFinal=true + content 必须保留为 stream_chunk
  // 否则在 reducer 里 done 不写 content，最后一段 text 会被 drop
  it('keeps final text chunks mapped as stream_chunk (round 4 P1)', () => {
    const event = adaptIncomingToBubbleEvent(
      baseMsg({ type: 'text', origin: 'stream', content: 'final words', isFinal: true }),
      { sourcePath: 'active' },
    );

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: 'stream_chunk',
      bubbleKind: 'assistant_text',
      payload: { content: 'final words' },
    });
    // 关键：final text 不能走 done，否则 reducer 不写 content → 最后一段被 drop
    expect(event?.type).not.toBe('done');
  });
});
