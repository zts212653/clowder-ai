/**
 * F194 Phase Z9 AC-Z27 — replay fixture full coverage.
 *
 * Three fixtures validate end-to-end behavior of canonical bubble identity
 * contract after Z9 backend stamp (AC-Z25):
 *
 *  F1 (multi-turn same parent): A2A chain `codex → sonnet → codex` sharing
 *      parent invocation, each cat-turn stamped with own turnInvocationId.
 *      Expected: 3 distinct bubbles (Z8 would have merged codex turn1+turn3).
 *  F2 (single turn multi-record): stream + tool + rich + callback all share
 *      same turnInvocationId. Expected: 1 bubble (Z8 alpha fixture upgrade —
 *      now turn id is explicit, not implicit).
 *  F3 (legacy no turn): old persisted record with only parent invocationId,
 *      no turnInvocationId stamped. Expected: fallback to parent (Z8 behavior),
 *      backward compatible.
 */
import { describe, expect, it } from 'vitest';
import { projectCanonicalBubbles } from '../bubble-projection';
import type { ChatMessage } from '../chat-types';

describe('F194 Phase Z9 AC-Z27 — replay fixtures', () => {
  it('F1 multi-turn same parent: codex t1 → sonnet t2 → codex t3 → 3 distinct bubbles', () => {
    // R13 reproduction with Z9 backend stamping in place: each cat-turn has
    // its own turnInvocationId. codex t1 and t3 must NOT merge despite sharing
    // parent + cat.
    const parent = 'parent-chain-z9-F1';
    const records: ChatMessage[] = [
      {
        id: 'rec-codex-t1',
        type: 'assistant',
        catId: 'codex',
        content: '我先按开源 issue intake 路线查...',
        timestamp: 1000,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: 'turn-codex-1' } },
      },
      {
        id: 'rec-sonnet-t2',
        type: 'assistant',
        catId: 'sonnet',
        content: '先搜 evidence 确认 Windows 打包...',
        timestamp: 2000,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: 'turn-sonnet-2' } },
      },
      {
        id: 'rec-codex-t3',
        type: 'assistant',
        catId: 'codex',
        content: '接。review 已放行，我按开源 hotfix lane 推进...',
        timestamp: 3000,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: 'turn-codex-3' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(3);
    // codex t1 content NOT merged into codex t3
    const codexBubbles = messages.filter((m) => m.catId === 'codex');
    expect(codexBubbles).toHaveLength(2);
    const t1Bubble = codexBubbles.find((m) => m.content.includes('issue intake'));
    const t3Bubble = codexBubbles.find((m) => m.content.includes('hotfix lane'));
    expect(t1Bubble).toBeTruthy();
    expect(t3Bubble).toBeTruthy();
    expect(t1Bubble!.id).not.toBe(t3Bubble!.id);
    expect(t1Bubble!.content).not.toContain('hotfix lane');
    expect(t3Bubble!.content).not.toContain('issue intake');
    // sonnet between codex turns
    const sonnetBubble = messages.find((m) => m.catId === 'sonnet');
    expect(sonnetBubble?.content).toContain('Windows 打包');
  });

  it('F2 single turn multi-record: stream/tool share one bubble, callback post_message is separate', () => {
    // After Z9 backend stamp, all raw records of one visible cat-turn carry the
    // SAME turnInvocationId. Whether stream / tool execution / callback / rich
    // blocks — they all collapse to one bubble correctly.
    const parent = 'parent-chain-z9-F2';
    const turn = 'turn-codex-only';
    const records: ChatMessage[] = [
      {
        id: 'rec-stream',
        type: 'assistant',
        catId: 'codex',
        content: 'streaming output...',
        timestamp: 1000,
        origin: 'stream',
        isStreaming: true,
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
      {
        id: 'rec-tool',
        type: 'assistant',
        catId: 'codex',
        content: '',
        timestamp: 1100,
        origin: 'stream',
        toolEvents: [
          {
            id: 'tool-1',
            type: 'tool_use',
            label: 'bash',
            timestamp: 1100,
          },
        ],
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
      {
        id: 'rec-callback',
        type: 'assistant',
        catId: 'codex',
        content: 'final callback output with conclusion',
        timestamp: 2000,
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    const streamBubble = messages.find((m) => m.origin === 'stream')!;
    const callbackBubble = messages.find((m) => m.origin === 'callback')!;
    expect(streamBubble.catId).toBe('codex');
    expect(streamBubble.content).toContain('streaming output');
    expect(streamBubble.toolEvents?.length).toBe(1);
    expect(streamBubble.toolEvents?.[0]?.id).toBe('tool-1');
    expect(callbackBubble.catId).toBe('codex');
    expect(callbackBubble.content).toContain('final callback output with conclusion');
    expect(callbackBubble.isStreaming).toBe(false);
  });

  it('F3 legacy no turn: pre-Z9 records with parent-only → fallback to parent group key', () => {
    // Backward compatibility: records persisted BEFORE Z9 deploy have only
    // invocationId (no turnInvocationId). Projection must still group them
    // using parent fallback — same Z8 behavior, no breakage.
    const records: ChatMessage[] = [
      {
        id: 'legacy-1',
        type: 'assistant',
        catId: 'opus',
        content: 'legacy stream content',
        timestamp: 1000,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-legacy-1' } },
      },
      {
        id: 'legacy-2',
        type: 'assistant',
        catId: 'opus',
        content: 'second part same legacy invocation',
        timestamp: 2000,
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-legacy-1' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('legacy stream content');
    expect(messages[0]!.content).toContain('second part same legacy invocation');
  });

  it('F1+F3 mixed: legacy record alongside Z9 stamped records → projection still distinguishes correctly', () => {
    // Real-world transition: existing thread has some pre-Z9 records (parent only)
    // and new post-Z9 records (with turn stamp). Mixed projection must work.
    const parent = 'parent-mixed';
    const records: ChatMessage[] = [
      {
        id: 'legacy-codex',
        type: 'assistant',
        catId: 'codex',
        content: 'old codex turn',
        timestamp: 1000,
        origin: 'stream',
        extra: { stream: { invocationId: parent } }, // no turn (legacy)
      },
      {
        id: 'z9-codex',
        type: 'assistant',
        catId: 'codex',
        content: 'new codex turn',
        timestamp: 2000,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: 'turn-z9-codex' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    // Legacy uses parent group key; Z9 record uses turn group key — different keys → 2 bubbles
    expect(messages).toHaveLength(2);
  });
});
