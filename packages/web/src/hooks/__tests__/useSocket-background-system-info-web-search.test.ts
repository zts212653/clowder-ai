import { describe, expect, it, vi } from 'vitest';
import type { HandleBackgroundMessageOptions } from '@/hooks/useSocket-background.types';
import { consumeBackgroundSystemInfo } from '@/hooks/useSocket-background-system-info';

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    addMessageToThread: vi.fn(),
    removeThreadMessage: vi.fn(),
    appendToThreadMessage: vi.fn(),
    appendToolEventToThread: vi.fn(),
    appendRichBlockToThread: vi.fn(),
    setThreadCatInvocation: vi.fn(),
    setThreadMessageMetadata: vi.fn(),
    setThreadMessageUsage: vi.fn(),
    setThreadMessageThinking: vi.fn(),
    setThreadMessageStreamInvocation: vi.fn(),
    setThreadMessageStreaming: vi.fn(),
    setThreadLoading: vi.fn(),
    setThreadHasActiveInvocation: vi.fn(),
    addThreadActiveInvocation: vi.fn(),
    removeThreadActiveInvocation: vi.fn(),
    updateThreadCatStatus: vi.fn(),
    batchStreamChunkUpdate: vi.fn(),
    clearThreadActiveInvocation: vi.fn(),
    replaceThreadMessageId: vi.fn(),
    patchThreadMessage: vi.fn(),
    getThreadState: vi.fn(() => ({ messages: [], catStatuses: {}, catInvocations: {} })),
    ...overrides,
  };
}

function createMockOptions(storeOverrides: Record<string, unknown> = {}) {
  return {
    store: createMockStore(storeOverrides),
    bgStreamRefs: new Map(),
    finalizedBgRefs: new Map(),
    replacedInvocations: new Map(),
    nextBgSeq: (() => {
      let i = 0;
      return () => ++i;
    })(),
    addToast: vi.fn(),
    clearDoneTimeout: vi.fn(),
  } as unknown as HandleBackgroundMessageOptions;
}

describe('consumeBackgroundSystemInfo web_search', () => {
  it('consumes web_search JSON (does not fall back to raw JSON system bubble)', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'codex',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'web_search', catId: 'codex', count: 1 }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
  });

  it('consumes invocation_created and resets stale taskProgress for that cat', () => {
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({
        messages: [],
        catStatuses: {},
        catInvocations: {
          codex: {
            invocationId: 'inv-old',
            taskProgress: {
              tasks: [{ id: 'task-1', subject: 'stale', status: 'in_progress' }],
              lastUpdate: Date.now() - 1_000,
            },
          },
        },
      })),
    });

    const msg = {
      type: 'system_info',
      catId: 'codex',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-new-2' }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.setThreadCatInvocation).toHaveBeenCalledWith(
      'thread-1',
      'codex',
      expect.objectContaining({
        invocationId: 'inv-new-2',
        taskProgress: expect.objectContaining({
          tasks: [],
          snapshotStatus: 'running',
          lastInvocationId: 'inv-new-2',
        }),
      }),
    );
  });

  it('binds invocation identity onto an existing background streaming bubble', () => {
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({
        messages: [
          {
            id: 'bg-msg-1',
            type: 'assistant',
            catId: 'codex',
            content: 'partial chunk',
            isStreaming: true,
            timestamp: Date.now(),
          },
        ],
        catStatuses: {},
        catInvocations: {},
      })),
    });

    const msg = {
      type: 'system_info',
      catId: 'codex',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-new-3' }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.setThreadMessageStreamInvocation).toHaveBeenCalledWith('thread-1', 'bg-msg-1', 'inv-new-3');
  });
});

describe('consumeBackgroundSystemInfo rich_block placeholder', () => {
  it('creates placeholder with origin:"stream" when no existing bubble (Bug B regression)', () => {
    const options = createMockOptions();
    const block = { id: 'rb-1', kind: 'audio', v: 1, url: '/api/tts/audio/test.wav', mimeType: 'audio/wav' };
    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'rich_block', block }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    // Placeholder must be created with origin: 'stream' (not 'callback')
    expect(options.store.addMessageToThread).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        type: 'assistant',
        catId: 'opus',
        content: '',
        isStreaming: true,
        origin: 'stream',
      }),
    );
    // Rich block must be appended to the placeholder
    expect(options.store.appendRichBlockToThread).toHaveBeenCalledWith(
      'thread-1',
      expect.stringContaining('bg-rich-'),
      block,
    );
  });

  it('appends rich block to existing callback bubble without creating placeholder', () => {
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({
        messages: [{ id: 'cb-msg-1', type: 'assistant', catId: 'opus', origin: 'callback', content: 'done' }],
        catStatuses: {},
        catInvocations: {},
      })),
    });
    const block = { id: 'rb-2', kind: 'audio', v: 1, url: '/api/tts/audio/test2.wav', mimeType: 'audio/wav' };
    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'rich_block', block }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    // Should NOT create a new placeholder
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
    // Should append to existing callback bubble
    expect(options.store.appendRichBlockToThread).toHaveBeenCalledWith('thread-1', 'cb-msg-1', block);
  });

  it('uses messageId correlation when provided', () => {
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({
        messages: [
          { id: 'target-msg', type: 'assistant', catId: 'opus', origin: 'callback', content: 'response' },
          { id: 'other-msg', type: 'assistant', catId: 'opus', origin: 'callback', content: 'later' },
        ],
        catStatuses: {},
        catInvocations: {},
      })),
    });
    const block = { id: 'rb-3', kind: 'audio', v: 1, url: '/api/tts/audio/test3.wav', mimeType: 'audio/wav' };
    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'rich_block', block, messageId: 'target-msg' }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.appendRichBlockToThread).toHaveBeenCalledWith('thread-1', 'target-msg', block);
  });
});

describe('consumeBackgroundSystemInfo liveness_warning', () => {
  it('consumes liveness_warning and updates catStatus + invocation snapshot (F118 parity)', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'liveness_warning',
        __livenessWarning: true,
        state: 'busy-silent',
        silenceDurationMs: 160094,
        level: 'alive_but_silent',
        cpuTimeMs: 12700,
        processAlive: true,
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    // Must update catStatus so ThinkingIndicator renders amber warning (not raw JSON)
    expect(options.store.updateThreadCatStatus).toHaveBeenCalledWith('thread-1', 'opus', 'alive_but_silent');
    // Must set invocation snapshot for the warning UI to display details
    expect(options.store.setThreadCatInvocation).toHaveBeenCalledWith(
      'thread-1',
      'opus',
      expect.objectContaining({
        livenessWarning: expect.objectContaining({
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 160094,
          cpuTimeMs: 12700,
          processAlive: true,
        }),
      }),
    );
  });

  it('consumes suspected_stall level', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'codex',
      threadId: 'thread-2',
      content: JSON.stringify({
        type: 'liveness_warning',
        __livenessWarning: true,
        state: 'idle-silent',
        silenceDurationMs: 300000,
        level: 'suspected_stall',
        cpuTimeMs: 0,
        processAlive: true,
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.updateThreadCatStatus).toHaveBeenCalledWith('thread-2', 'codex', 'suspected_stall');
  });

  it('consumes timeout_diagnostics without rendering raw JSON', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'timeout_diagnostics',
        catId: 'opus',
        firstEvent: 'item.streaming',
        lastEvent: 'item.completed',
        durationMs: 45000,
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    // Should NOT create any message bubble
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });
});

describe('consumeBackgroundSystemInfo warning + telemetry suppression', () => {
  it('converts warning JSON to readable text (not raw JSON bubble)', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'warning', message: 'API rate limit approaching' }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    // warning is NOT consumed (it renders as a readable system message, not suppressed)
    expect(result.consumed).toBe(false);
    expect(result.content).toBe('⚠️ API rate limit approaching');
  });

  it('suppresses strategy_allow_compress telemetry', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'strategy_allow_compress', allowCompress: true }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });

  it('suppresses resume_failure_stats telemetry', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'resume_failure_stats', failures: 2, recovered: 1 }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, undefined, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });
});
