import { createHash } from 'node:crypto';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

function reply(): ChatMessage {
  const parts = ['查看前文。', '查看后文。', '**真正回答。**', '[Sol/gpt-6.1-sol🐾]'];
  const content = parts.join('\n\n');
  const runs = parts.slice(0, 3).map((text, index) => {
    const start = index === 0 ? 0 : parts.slice(0, index).join('\n\n').length;
    return {
      id: `r${index}`,
      identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: `n${index}` },
      channel: index === 2 ? ('final' as const) : ('commentary' as const),
      complete: true as const,
      start,
      end: start + text.length + (index === 0 ? 0 : 2),
      gluePrefixLength: index === 0 ? (0 as const) : (2 as const),
    };
  });
  const finalRun = runs.at(-1);
  if (!finalRun) throw new Error('fixture final');
  return streamReply({
    catId: 'codex-astra',
    content,
    toolEvents: [
      { id: 'use', toolUseId: 'pair', executionRef: 'turn-1', type: 'tool_use', label: 'Read file', timestamp: 1 },
      {
        id: 'result',
        executionRef: 'turn-1',
        type: 'tool_result',
        label: 'Read file result',
        detail: 'ok',
        toolUseId: 'pair',
        timestamp: 2,
      },
    ],
    extra: {
      stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' },
      outputLayout: {
        v: 1,
        owner: { threadId: 'thread-1', catId: 'codex-astra', turnInvocationId: 'turn-1' },
        status: 'available',
        contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
        runs,
        order: [
          { kind: 'run', runId: 'r0' },
          { kind: 'tool', toolEventId: 'use', executionRef: 'turn-1' },
          { kind: 'run', runId: 'r1' },
          { kind: 'tool', toolEventId: 'result', executionRef: 'turn-1' },
          { kind: 'run', runId: 'r2' },
        ],
        hostTail: {
          kind: 'cat_signature',
          producer: 'codex_stream_finalizer',
          basis: 'runtime_canonical',
          start: finalRun.end,
          end: content.length,
          gluePrefixLength: 2,
        },
      },
    },
  });
}

describe('production ChatMessage consumes proven ordinary-native output', () => {
  let harness: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    harness = new ReplyLayersHarness();
    vi.stubGlobal('crypto', {
      subtle: {
        digest: async (_algorithm: string, bytes: Uint8Array) =>
          Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
      },
    });
  });
  afterEach(() => {
    harness.dispose();
    vi.unstubAllGlobals();
  });
  async function render(message: ChatMessage) {
    await act(async () => harness.render(message));
  }

  it('moves only proven process text, keeps Markdown and the typed signature in the visible answer', async () => {
    harness.enableV2();
    const message = reply();
    await render(message);
    const body = harness.q('message-bubble');
    expect(body?.textContent).toContain('真正回答。');
    expect(body?.querySelector('strong')?.textContent).toBe('真正回答。');
    expect(body?.textContent).toContain('[Sol/gpt-6.1-sol🐾]');
    expect(body?.textContent).not.toContain('查看前文');
    expect(body?.textContent).not.toContain('查看后文');
    expect(harness.q('reply-last-line')?.textContent).toContain('过程 2 段');
    expect(message.content).toContain('查看前文。\n\n查看后文。');
  });
  it('interleaves the moved text with the original tool call and counts no host tail as process', async () => {
    harness.enableV2();
    await render(reply());
    harness.click('reply-record-toggle');
    const record = harness.q('reply-record');
    const text = record?.textContent ?? '';
    expect(text).toContain('查看前文。');
    expect(text).toContain('查看后文。');
    expect(text.indexOf('查看前文')).toBeLessThan(text.indexOf('Read file'));
    expect(text.indexOf('Read file')).toBeLessThan(text.indexOf('查看后文'));
    expect(text).not.toContain('真正回答');
    expect(text).not.toContain('[Sol/');
  });
  it('preserves the original classic body and unknown/changed v2 body without classifying them', async () => {
    const message = reply();
    await render(message);
    expect(harness.q('reply-layers')).toBeNull();
    harness.enableV2();
    const changed = { ...message, content: message.content.replace('查看', '校验') };
    await render(changed);
    expect(harness.q('message-bubble')?.textContent).toContain('校验前文');
    expect(harness.q('message-bubble')?.textContent).toContain('查看后文');
    expect(harness.q('reply-last-line')?.textContent).not.toContain('过程 2 段');
  });
});
