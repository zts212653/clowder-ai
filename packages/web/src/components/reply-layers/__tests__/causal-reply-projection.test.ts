import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectCausalReplies } from '../causal-reply-projection';

const before = '原先的分析。\n\n';
const after = '收到审查，已经修正。';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const response = (content = before + after): ChatMessage => ({
  id: 'R',
  type: 'assistant',
  catId: 'codex',
  origin: 'stream',
  timestamp: 1000,
  content,
  lifecycle: {
    kind: 'response',
    orderKey: '1000:turn',
    invocationId: 'turn',
    targetId: 'codex',
    inputEntryIds: ['first', 'review'],
    inputMessageIds: ['U', 'S'],
    status: 'processing',
    startedAt: 1000,
    appendBoundaries: [{ inputMessageId: 'S', contentOffset: before.length, prefixSha256: hash(before) }],
  },
});
const input: ChatMessage = {
  id: 'S',
  type: 'assistant',
  catId: 'dsh',
  timestamp: 2000,
  content: '请修正审查意见。',
  lifecycle: {
    kind: 'input',
    orderKey: '2000:S',
    dispatchRefs: [{ targetId: 'codex', phase: 'dispatched', statusMessageId: 'R', dispatchedAt: 2000 }],
  },
};
const proof = new Map([[`R:turn:S:${before.length}:${hash(before)}`, before]]);

describe('causal reply presentation without moving History', () => {
  it('splits a single growing native run at the admitted input, during streaming and after reload', () => {
    for (const message of [response(), { ...response(), isStreaming: true }, response(`${before}${after} 尾部签名`)]) {
      const projected = projectCausalReplies([message, input], proof);
      expect(projected.originals.get('R')).toEqual({ start: 0, end: before.length, inputMessageId: 'S' });
      const continuation = projected.continuations.get('S')?.[0];
      expect(continuation?.response).toBe(message);
      expect(message.content.slice(continuation?.start, continuation?.end)).toBe(message.content.slice(before.length));
      expect(message.id).toBe('R');
    }
  });

  it('keeps full canonical text when the source is not readable or the prefix was replaced', () => {
    expect(projectCausalReplies([response()], proof).originals.size).toBe(0);
    expect(projectCausalReplies([response('已替换的完整答案'), input], proof).originals.size).toBe(0);
    expect(projectCausalReplies([response(), input], new Map()).originals.size).toBe(0);
    expect(projectCausalReplies([response(`不同的前缀。\n\n${after}`), input], proof).originals.size).toBe(0);
  });

  it('supports several adoptions and equal offsets without duplicating text', () => {
    const message = response();
    const second = { ...input, id: 'S2', timestamp: 3000 };
    if (message.lifecycle?.kind !== 'response') throw new Error('fixture');
    message.lifecycle = {
      ...message.lifecycle,
      inputMessageIds: ['U', 'S', 'S2'],
      appendBoundaries: [
        ...(message.lifecycle.appendBoundaries ?? []),
        { inputMessageId: 'S2', contentOffset: before.length, prefixSha256: hash(before) },
      ],
    };
    const verified = new Map([...proof, [`R:turn:S2:${before.length}:${hash(before)}`, before]]);
    const projected = projectCausalReplies([message, input, second], verified);
    expect(projected.continuations.get('S')?.[0].end).toBe(before.length);
    expect(projected.continuations.get('S')?.[0].nextInputMessageId).toBe('S2');
    expect(projected.continuations.get('S2')?.[0].start).toBe(before.length);
    expect(projected.continuations.get('S2')?.[0].end).toBe(message.content.length);
  });

  it('keeps UTF16 coordinates across leading trim and terminal failure', () => {
    const prefix = '😀 已核对\n\n';
    const message = response(`  ${prefix}后续答案`);
    if (message.lifecycle?.kind !== 'response') throw new Error('fixture');
    const boundary = { inputMessageId: 'S', contentOffset: prefix.length, prefixSha256: hash(prefix) };
    message.lifecycle = { ...message.lifecycle, status: 'canceled', completedAt: 3000, appendBoundaries: [boundary] };
    const verified = new Map([[`R:turn:S:${prefix.length}:${hash(prefix)}`, prefix]]);
    const live = projectCausalReplies([message, input], verified).continuations.get('S')?.[0];
    expect(live?.start).toBe(prefix.length + 2);
    expect(message.content.slice(live?.start, live?.end)).toBe('后续答案');
    const trimmed = { ...message, content: message.content.trimStart() };
    const restored = projectCausalReplies([trimmed, input], verified).continuations.get('S')?.[0];
    expect(restored?.start).toBe(prefix.length);
    expect(trimmed.content.slice(restored?.start, restored?.end)).toBe('后续答案');
  });

  it('does not export private responses or cut a client snapshot that is behind the boundary', () => {
    expect(projectCausalReplies([{ ...response(), visibility: 'whisper' }, input], proof).originals.size).toBe(0);
    expect(projectCausalReplies([response('原先'), input], proof).originals.size).toBe(0);
  });

  it('does not resurrect a recalled response through a continuation while its old body is still cached', () => {
    const recalled = response();
    recalled.extra = { recall: { version: 1, exposure: 'seen', recalledAt: 3000, exposures: [] } };
    const projection = projectCausalReplies([recalled, input], proof);
    expect(projection.originals.size).toBe(0);
    expect(projection.continuations.size).toBe(0);
  });
  it('invalidates precise ranges when their input is recalled', () => {
    const recalled: ChatMessage = { ...input, extra: { recall: { version: 1, exposure: 'seen', recalledAt: 3000 } } };
    const projected = projectCausalReplies([response(), recalled], proof);
    expect(projected.originals.size).toBe(0);
    expect(projected.continuations.size).toBe(0);
  });

  it('keeps the whole reply when the exact queued native turn did not complete', () => {
    const source: ChatMessage = {
      ...input,
      lifecycle: {
        kind: 'input',
        orderKey: '2000:S',
        dispatchRefs: [
          {
            targetId: 'codex',
            phase: 'settled',
            statusMessageId: 'R',
            dispatchedAt: 2000,
            appendAcceptance: 'written',
            inputRead: { status: 'read', at: 2100 },
          },
        ],
        appendFailures: [
          {
            targetId: 'codex',
            invocationId: 'turn',
            responseMessageId: 'R',
            at: 2200,
            acceptance: 'incomplete',
            reason: 'provider_rejected',
          },
        ],
      },
    };
    expect(projectCausalReplies([response(), source], proof).originals.size).toBe(0);
  });

  it('uses an exact read receipt over pending acceptance or a late refusal', () => {
    [false, true].forEach((lateRefusal) => {
      const source: ChatMessage = {
        ...input,
        lifecycle: {
          kind: 'input',
          orderKey: '2000:S',
          dispatchRefs: [
            {
              targetId: 'codex',
              phase: 'dispatched',
              statusMessageId: 'R',
              dispatchedAt: 2000,
              appendAcceptance: 'pending',
              inputRead: { status: 'read', at: 2100 },
            },
          ],
          ...(lateRefusal
            ? {
                appendFailures: [
                  {
                    targetId: 'codex',
                    invocationId: 'turn',
                    responseMessageId: 'R',
                    at: 2200,
                    acceptance: 'not_accepted' as const,
                    reason: 'provider_rejected' as const,
                  },
                ],
              }
            : {}),
        },
      };
      expect(projectCausalReplies([response(), source], proof).originals.size).toBe(1);
    });
  });

  it('keeps the whole reply while append acceptance is unknown, refused, or rebound to another response', () => {
    const source: ChatMessage = {
      ...input,
      lifecycle: {
        kind: 'input',
        orderKey: '2000:S',
        dispatchRefs: [
          {
            targetId: 'codex',
            phase: 'dispatched',
            statusMessageId: 'R',
            dispatchedAt: 2000,
            appendAcceptance: 'pending',
          },
        ],
      },
    };
    if (source.lifecycle?.kind !== 'input') throw new Error('fixture');
    expect(projectCausalReplies([response(), source], proof).originals.size).toBe(0);
    source.lifecycle = {
      ...source.lifecycle,
      appendFailures: [
        {
          targetId: 'codex',
          invocationId: 'turn',
          responseMessageId: 'R',
          at: 2100,
          acceptance: 'not_accepted',
          reason: 'provider_rejected',
        },
      ],
    };
    expect(projectCausalReplies([response(), source], proof).originals.size).toBe(0);
    source.lifecycle = {
      ...source.lifecycle,
      dispatchRefs: [
        {
          targetId: 'codex',
          phase: 'dispatched',
          statusMessageId: 'R',
          dispatchedAt: 2000,
          appendAcceptance: 'written',
        },
      ],
    };
    expect(projectCausalReplies([response(), source], proof).originals.size).toBe(1);
    source.lifecycle = {
      kind: 'input',
      orderKey: '2000:S',
      dispatchRefs: [{ targetId: 'codex', phase: 'dispatched', statusMessageId: 'R2', dispatchedAt: 2000 }],
    };
    expect(projectCausalReplies([response(), source], proof).originals.size).toBe(0);
  });
});
