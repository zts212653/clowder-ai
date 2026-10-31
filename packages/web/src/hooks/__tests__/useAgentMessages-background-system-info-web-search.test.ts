import { describe, expect, it, vi } from 'vitest';
import type { HandleBackgroundMessageOptions } from '@/hooks/useAgentMessages';
import { consumeBackgroundSystemInfo } from '@/hooks/useAgentMessages';
import { useChatStore } from '@/stores/chatStore';

function createMockStore(overrides: Record<string, unknown> = {}) {
  return {
    // Named-message writes (hooks/named-message-writer.ts) read these too.
    currentThreadId: 'thread-current',
    incrementUnread: vi.fn(),
    addMessageToThread: vi.fn(),
    removeThreadMessage: vi.fn(),
    appendToThreadMessage: vi.fn(),
    appendToolEventToThread: vi.fn(),
    appendRichBlockToThread: vi.fn(),
    setThreadCatInvocation: vi.fn(),
    setThreadMessageMetadata: vi.fn(),
    setThreadMessageUsage: vi.fn(),
    setThreadMessageThinking: vi.fn(),
    setThreadMessageStreaming: vi.fn(),
    setThreadLoading: vi.fn(),
    setThreadHasActiveInvocation: vi.fn(),
    addThreadActiveInvocation: vi.fn(),
    removeThreadActiveInvocation: vi.fn(),
    updateThreadCatStatus: vi.fn(),
    batchStreamChunkUpdate: vi.fn(),
    clearThreadActiveInvocation: vi.fn(),
    patchThreadMessage: vi.fn(),
    getThreadState: vi.fn(() => ({ messages: [], catStatuses: {}, catInvocations: {} })),
    ...overrides,
  };
}

function createMockOptions(storeOverrides: Record<string, unknown> = {}) {
  return {
    store: createMockStore(storeOverrides),
    nextBgSeq: (() => {
      let i = 0;
      return () => ++i;
    })(),
    addToast: vi.fn(),
  } as unknown as HandleBackgroundMessageOptions;
}

describe('consumeBackgroundSystemInfo web_search', () => {
  it('consumes web_search JSON (does not fall back to raw JSON system bubble)', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'codex',
      threadId: 'thread-1',
      messageId: 'resp-1',
      content: JSON.stringify({ type: 'web_search', catId: 'codex', count: 1 }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
  });

  // F210 H3: background path agy_trajectory_progress → 累积到 thread 级 catStatusDetails（折叠单行），
  // 不渲染 raw JSON system bubble（承接 H1-hotfix）。砚砚 scope：active+background 都覆盖。
  it('consumes agy_trajectory_progress → updateThreadCatStatus detail, no raw bubble (H3 background)', () => {
    const options = createMockOptions();
    const msg = {
      type: 'system_info',
      catId: 'gemini',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'agy_trajectory_progress',
        idx: 4,
        stepType: 15,
        status: 1,
        label: 'AGY trajectory step #4 (assistant activity) running',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    expect(options.store.updateThreadCatStatus).toHaveBeenCalledWith(
      'thread-1',
      'gemini',
      'streaming',
      expect.stringContaining('AGY working · 5 steps · assistant activity'),
    );
    // 不刷 system bubble（per-step）
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
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

    const result = consumeBackgroundSystemInfo(msg, options);

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

  it('formats a2a_pingpong_terminated as readable system notice text', () => {
    const options = createMockOptions();
    options.resolveCatName = (catId) => ({ sonnet: '布偶猫（sonnet）', gpt52: '缅因猫（gpt52）' })[catId] ?? catId;

    const msg = {
      type: 'system_info',
      catId: 'sonnet',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'a2a_pingpong_terminated',
        fromCatId: 'sonnet',
        targetCatId: 'gpt52',
        pairCount: 4,
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(false);
    expect(result.variant).toBe('info');
    expect(result.content).toBe('🏓 布偶猫（sonnet） ↔ 缅因猫（gpt52） 已连续互相 @ 4 轮，链路已熔断。');
  });
});

describe('consumeBackgroundSystemInfo rich_block', () => {
  it("a rich_block names its message: payload messageId (a post's own block) ?? envelope messageId (R)", () => {
    // Real store, so the assertions hold whichever store the hook writes named messages through.
    useChatStore.setState({ messages: [], threadStates: {}, currentThreadId: 'thread-current' });
    useChatStore.getState().addMessageToThread('thread-1', {
      id: 'post-1',
      type: 'assistant',
      catId: 'opus',
      origin: 'callback',
      content: 'posted',
      isStreaming: false,
      timestamp: 1000,
      extra: { isExplicitPost: true },
    });
    const options: HandleBackgroundMessageOptions = { ...createMockOptions(), store: useChatStore.getState() };
    const threadMessages = () => useChatStore.getState().getThreadState('thread-1').messages;
    const postBlock = { id: 'rb-post', kind: 'audio', v: 1, url: '/api/tts/audio/post.wav', mimeType: 'audio/wav' };
    const streamBlock = { id: 'rb-stream', kind: 'card', v: 1, title: 'stream card' };
    const envelope = { type: 'system_info', catId: 'opus', threadId: 'thread-1', messageId: 'resp-1', timestamp: 2000 };

    // A post's own block names the post in its payload; the turn's R on the envelope does not redirect it,
    // and the block neither creates R nor reopens the post.
    const postResult = consumeBackgroundSystemInfo(
      { ...envelope, content: JSON.stringify({ type: 'rich_block', block: postBlock, messageId: 'post-1' }) },
      options,
    );
    expect(postResult.consumed).toBe(true);
    expect(threadMessages().map((m) => m.id)).toEqual(['post-1']);

    // Without a payload messageId the block is R's stream output: R is created under its server id.
    const streamResult = consumeBackgroundSystemInfo(
      { ...envelope, content: JSON.stringify({ type: 'rich_block', block: streamBlock }) },
      options,
    );
    expect(streamResult.consumed).toBe(true);

    const messages = threadMessages();
    expect(messages.map((m) => m.id)).toEqual(['post-1', 'resp-1']);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        isStreaming: false,
        extra: expect.objectContaining({ rich: { v: 1, blocks: [postBlock] } }),
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        type: 'assistant',
        catId: 'opus',
        origin: 'stream',
        extra: expect.objectContaining({ rich: { v: 1, blocks: [streamBlock] } }),
      }),
    );
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
        firstEventAt: 1000,
        lastEventAt: 2000,
        lastEventType: 'turn.started',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    // Must update catStatus for structured liveness surfaces (not raw JSON).
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
          firstEventAt: 1000,
          lastEventAt: 2000,
          lastEventType: 'turn.started',
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

    const result = consumeBackgroundSystemInfo(msg, options);

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

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    // Should NOT create any message bubble
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });
});

// #966: provider_capability background handler — mirror of foreground handler.
// Without this handler, kimi invocations in background threads surface raw-JSON bubbles.
describe('consumeBackgroundSystemInfo provider_capability (#966)', () => {
  it('consumes provider_capability silently (no raw JSON bubble)', () => {
    const options = createMockOptions();
    const msg = {
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'thinking',
        status: 'unavailable',
        provider: 'kimi',
        reason: 'kimi-cli 本次流式输出未提供可解析的 think/reasoning 内容',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
    expect(options.store.setThreadCatInvocation).toHaveBeenCalledWith('thread-bg', 'kimi', {
      providerCapabilities: {
        thinking: expect.objectContaining({
          status: 'unavailable',
          provider: 'kimi',
          reason: expect.any(String),
        }),
      },
    });
  });

  it('merges multiple capabilities without clobbering (read-merge-write)', () => {
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({
        messages: [],
        catStatuses: {},
        catInvocations: {
          kimi: {
            providerCapabilities: {
              thinking: { status: 'unavailable', provider: 'kimi', reason: 'n/a', receivedAt: 1000 },
            },
          },
        },
      })),
    });
    const msg = {
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'image_input',
        status: 'limited',
        provider: 'kimi',
        reason: 'max 4 images',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    const call = vi.mocked(options.store.setThreadCatInvocation).mock.calls[0];
    expect(call?.[2]?.providerCapabilities).toMatchObject({
      thinking: { status: 'unavailable' },
      image_input: { status: 'limited', provider: 'kimi' },
    });
  });

  it('coerces unknown status to unavailable', () => {
    const options = createMockOptions();
    const msg = {
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'thinking',
        status: 'bogus',
        provider: 'kimi',
        reason: '',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    const call = vi.mocked(options.store.setThreadCatInvocation).mock.calls[0];
    expect(call?.[2]?.providerCapabilities?.thinking?.status).toBe('unavailable');
  });

  it('uses msg.catId fallback when parsed.catId is empty string', () => {
    const options = createMockOptions();
    const msg = {
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        catId: '',
        capability: 'thinking',
        status: 'unavailable',
        provider: 'kimi',
        reason: '',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    // Should use msg.catId='kimi' because parsed.catId='' is falsy with ||
    expect(options.store.setThreadCatInvocation).toHaveBeenCalledWith('thread-bg', 'kimi', expect.any(Object));
  });
});

describe('consumeBackgroundSystemInfo warning + telemetry suppression', () => {
  it('keeps background reconnect evidence on the existing response', () => {
    const initial = {
      id: 'response-bg',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'working',
      timestamp: 100,
    };
    const options = createMockOptions({
      getThreadState: vi.fn(() => ({ messages: [initial], catStatuses: {}, catInvocations: {} })),
    });

    const result = consumeBackgroundSystemInfo(
      {
        type: 'system_info',
        catId: 'codex-sol',
        threadId: 'thread-bg',
        invocationId: 'parent-bg',
        turnInvocationId: 'turn-bg',
        messageId: 'response-bg',
        content: JSON.stringify({
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'recovered',
          invocationId: 'turn-bg',
          attempts: ['Reconnecting... 1/5'],
          evidence: 'turn.completed',
        }),
        timestamp: 200,
      },
      options,
    );

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
    expect(options.store.patchThreadMessage).toHaveBeenCalledWith(
      'thread-bg',
      'response-bg',
      expect.objectContaining({
        extra: expect.objectContaining({
          providerRecovery: expect.objectContaining({
            phase: 'recovered',
            invocationId: 'turn-bg',
            parentInvocationId: 'parent-bg',
          }),
        }),
      }),
    );
  });

  it('converts warning JSON to readable text (not raw JSON bubble)', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'warning',
        presentation: 'user_action_required',
        message: 'API rate limit approaching',
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

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

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });

  it('suppresses tool_activity telemetry after tool_use carries the visible tool event', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'antig-opus',
      threadId: 'thread-1',
      content: JSON.stringify({ type: 'tool_activity', toolName: 'view_file' }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });

  it('suppresses mcp_server_status telemetry', () => {
    const options = createMockOptions();

    const msg = {
      type: 'system_info',
      catId: 'opus',
      threadId: 'thread-1',
      content: JSON.stringify({
        type: 'mcp_server_status',
        provider: 'claude',
        pendingMeaning: 'deferred_tool_loading',
        counts: { connected: 1, pending: 1, failed: 0, disabled: 0, 'needs-auth': 0 },
        servers: [{ name: 'MCP_DOCKER', status: 'pending' }],
      }),
      timestamp: Date.now(),
    };

    const result = consumeBackgroundSystemInfo(msg, options);

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

    const result = consumeBackgroundSystemInfo(msg, options);

    expect(result.consumed).toBe(true);
    expect(options.store.addMessageToThread).not.toHaveBeenCalled();
  });
});
