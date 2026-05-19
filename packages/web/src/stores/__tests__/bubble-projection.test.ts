import { describe, expect, it } from 'vitest';
import alphaThreeRecords from '../__fixtures__/z8-alpha-3-records.json';
import { projectCanonicalBubbles } from '../bubble-projection';
import type { ChatMessage } from '../chat-types';

describe('F194 Phase Z8 — projectCanonicalBubbles (AC-Z20)', () => {
  it('AC-Z20/Z11 alpha replay: stream records merge, callback post_message remains its own bubble', () => {
    // Source: thread_moyfjyjc0662weit opus invocation 2fe279aa
    // 2 stream + 1 callback, 3 distinct content segments, all sharing invocationId.
    // Phase Z1-Z7 reducer/hydrate paths produced 2-3 separate bubbles depending on path.
    // Z11 correction: stream-origin work logs share one CLI bubble; callback-origin
    // post_message speech is a separate bubble even when it shares the same invocation.
    const records = alphaThreeRecords as unknown as ChatMessage[];
    expect(records).toHaveLength(3);

    const { messages } = projectCanonicalBubbles({ records });

    expect(messages).toHaveLength(2);
    const streamBubble = messages.find((m) => m.origin === 'stream')!;
    const callbackBubble = messages.find((m) => m.origin === 'callback')!;
    expect(streamBubble.type).toBe('assistant');
    expect(streamBubble.catId).toBe('opus');
    expect(streamBubble.content).toContain('好，铲屎官同意了'); // first stream
    expect(streamBubble.content).toContain('砚砚三个 findings 全对'); // second stream
    expect(callbackBubble.id).toBe('0001778468150545-000021-b0d93885');
    expect(callbackBubble.content).toContain('@codex 砚砚');
    // toolEvents deduped — first record has 5 tools, second has 16 tools (different ids)
    expect(streamBubble.toolEvents?.length).toBeGreaterThan(0);
    // stream identity preserved for downstream dedupe
    expect(streamBubble.extra?.stream?.invocationId).toBe('2fe279aa-255c-4d22-b3e7-a3e718c3b52e');
  });

  it('passes through user/system messages unchanged', () => {
    const records: ChatMessage[] = [
      { id: 'u1', type: 'user', content: 'hi', timestamp: 100 },
      { id: 's1', type: 'system', content: '[SYS]', timestamp: 200 },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe('u1');
    expect(messages[1]!.id).toBe('s1');
  });

  it('assistant records without invocation key pass through unchanged', () => {
    const records: ChatMessage[] = [
      { id: 'a1', type: 'assistant', catId: 'opus', content: 'standalone', timestamp: 100 },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('a1');
  });

  it('two separate invocations produce two bubbles (no cross-invocation merge)', () => {
    const records: ChatMessage[] = [
      {
        id: 'a1',
        type: 'assistant',
        catId: 'opus',
        content: 'turn 1',
        timestamp: 100,
        extra: { stream: { invocationId: 'inv-1' } },
      },
      {
        id: 'a2',
        type: 'assistant',
        catId: 'opus',
        content: 'turn 2',
        timestamp: 200,
        extra: { stream: { invocationId: 'inv-2' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.content).sort()).toEqual(['turn 1', 'turn 2']);
  });

  it('R1 P1#1 (砚砚): isStreaming = LAST record explicit value when no callback (not ANY)', () => {
    // Per R1 P1: rule is callback/terminal-aware, fallback to last record's explicit value.
    // Old earlier record streaming, later record finalized → bubble = false (not ANY=true).
    const records: ChatMessage[] = [
      {
        id: 'a1',
        type: 'assistant',
        catId: 'opus',
        content: 'first',
        timestamp: 100,
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-x' } },
      },
      {
        id: 'a2',
        type: 'assistant',
        catId: 'opus',
        content: 'final',
        timestamp: 200,
        isStreaming: false, // explicitly finalized
        extra: { stream: { invocationId: 'inv-x' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.isStreaming).toBe(false);
  });

  it('R1 P1#1/Z11: callback speech is terminal without finalizing the separate stream bubble', () => {
    const records: ChatMessage[] = [
      {
        id: 'a1',
        type: 'assistant',
        catId: 'opus',
        content: 'streaming',
        timestamp: 100,
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-cb' } },
      },
      {
        id: 'a2',
        type: 'assistant',
        catId: 'opus',
        content: 'callback final',
        timestamp: 200,
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-cb' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    const callbackBubble = messages.find((m) => m.origin === 'callback')!;
    const streamBubble = messages.find((m) => m.origin === 'stream')!;
    expect(callbackBubble.isStreaming).toBe(false);
    expect(streamBubble.isStreaming).toBe(true);
  });

  it('cloud R2 P2 (codex): projection merges contentBlocks across records (image/structured preserved)', () => {
    // Cloud Codex P2 on PR #1632 67279e11f: previously only `content`/`thinking`/`toolEvents`/`rich`
    // merged; if stream had `contentBlocks` (e.g. image) and callback didn't, collapsing dropped them.
    // Fix: merge contentBlocks across all records.
    const records: ChatMessage[] = [
      {
        id: 'stream-img',
        type: 'assistant',
        catId: 'opus',
        content: 'here is an image',
        timestamp: 100,
        isStreaming: true,
        origin: 'stream',
        contentBlocks: [{ type: 'image' as const, url: 'https://x/y.png' }] as ChatMessage['contentBlocks'],
        extra: { stream: { invocationId: 'inv-cb-cb' } },
      },
      {
        id: 'callback-text',
        type: 'assistant',
        catId: 'opus',
        content: 'final commentary',
        timestamp: 200,
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-cb-cb' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    const streamBubble = messages.find((m) => m.origin === 'stream')!;
    const callbackBubble = messages.find((m) => m.origin === 'callback')!;
    expect(streamBubble.contentBlocks).toHaveLength(1);
    expect(streamBubble.contentBlocks?.[0]).toMatchObject({ type: 'image', url: 'https://x/y.png' });
    expect(streamBubble.content).toContain('here is an image');
    expect(callbackBubble.content).toContain('final commentary');
  });

  it('cloud R1 P1 (codex): projection preserves metadata/replyTo/replyPreview/visibility/etc from canonical record', () => {
    // Cloud Codex P1 on PR #1632: projectGroup was rebuilding from scratch with only id/type/catId/
    // content/timestamp/isStreaming/origin, dropping metadata, replyTo, replyPreview, visibility, etc.
    // Fix: use callback record (or first) as base spread, then override projection-specific fields.
    const records: ChatMessage[] = [
      {
        id: 'stream-a',
        type: 'assistant',
        catId: 'opus',
        content: 'streaming',
        timestamp: 100,
        isStreaming: true,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-preserve' } },
      },
      {
        id: 'callback-b',
        type: 'assistant',
        catId: 'opus',
        content: 'final',
        timestamp: 200,
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-preserve' } },
        // Fields that previously got dropped:
        metadata: { provider: 'anthropic', model: 'opus-4' } as ChatMessage['metadata'],
        replyTo: 'msg-replied-to',
        replyPreview: { senderCatId: '铲屎官', content: '原始消息' } as ChatMessage['replyPreview'],
        visibility: 'whisper',
        whisperTo: ['codex'],
        revealedAt: 999,
        deliveredAt: 250,
        mentionsUser: true,
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    const m = messages.find((msg) => msg.origin === 'callback')!;
    expect(m.id).toBe('callback-b');
    expect(m.metadata).toEqual({ provider: 'anthropic', model: 'opus-4' });
    expect(m.replyTo).toBe('msg-replied-to');
    expect(m.replyPreview).toEqual({ senderCatId: '铲屎官', content: '原始消息' });
    expect(m.visibility).toBe('whisper');
    expect(m.whisperTo).toEqual(['codex']);
    expect(m.revealedAt).toBe(999);
    expect(m.deliveredAt).toBe(250);
    expect(m.mentionsUser).toBe(true);
    // Callback fields are preserved without swallowing the stream work-log bubble.
    expect(m.content).toContain('final');
    expect(m.origin).toBe('callback');
    expect(messages.find((msg) => msg.origin === 'stream')?.content).toContain('streaming');
  });

  it('isStreaming = true when only streaming records exist (single-record streaming case)', () => {
    const records: ChatMessage[] = [
      {
        id: 'a1',
        type: 'assistant',
        catId: 'opus',
        content: 'streaming',
        timestamp: 100,
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-only-stream' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages[0]!.isStreaming).toBe(true);
  });
});
