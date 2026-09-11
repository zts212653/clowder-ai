import type { CliDiagnostics } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

const chatStoreState = vi.hoisted(() => ({ messages: [] as unknown[] }));

/**
 * F212 Phase B (AC-B1 + AC-B2 wire-through): ChatMessage routes `extra.cliDiagnostics`
 * to CliDiagnosticsPanel instead of the legacy red-pill error bubble.
 *
 * This is the *router* integration test — CliDiagnosticsPanel's own rendering contract
 * is covered separately in CliDiagnosticsPanel.test.ts.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [],
      currentThreadId: null,
      isLoadingThreads: false,
      messages: chatStoreState.messages,
      catInvocations: {},
      threadStates: {},
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    }),
  resolveBubbleExpanded: (
    override: 'global' | 'expanded' | 'collapsed' | undefined,
    globalDefault: 'expanded' | 'collapsed',
  ) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/components/TtsPlayButton', () => ({ TtsPlayButton: () => null }));
// Important: real CliDiagnosticsPanel so the data-testid attaches.

const opusCat = (): CatData =>
  ({
    id: 'opus',
    displayName: '布偶猫',
    breedId: 'ragdoll',
    color: { primary: '#FFD700', secondary: '#FFF8DC' },
  }) as unknown as CatData;

function makeErrorMessage(extra: ChatMessageType['extra'] = {}): ChatMessageType {
  return {
    id: 'msg-err',
    type: 'system',
    variant: 'error',
    catId: 'opus',
    content: 'Error: CLI 异常退出 (code: 1)',
    timestamp: Date.now(),
    extra,
  } as ChatMessageType;
}

function makeSystemInfoMessage(extra: ChatMessageType['extra'] = {}): ChatMessageType {
  return {
    id: 'msg-sys',
    type: 'system',
    variant: 'info',
    catId: 'opus',
    content: 'OpenCode CLI 完成但无文字输出（见 cliDiagnostics 详情）',
    timestamp: Date.now(),
    extra,
  } as ChatMessageType;
}

describe('F212 Phase B — ChatMessage routes cliDiagnostics to folded panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{
    message: ChatMessageType;
    getCatById: (id: string) => CatData | undefined;
    hideDiagnosticsPanel?: boolean;
    dedupCount?: number;
  }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    chatStoreState.messages = [];
    resetCoCreatorConfigCacheForTest();
    primeCoCreatorConfigCache({
      name: 'co-creator',
      aliases: [],
      mentionPatterns: ['@owner'],
      avatar: '/uploads/owner.png',
      color: { primary: '#000', secondary: '#FFF' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  function render(message: ChatMessageType): void {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message,
          getCatById: (id: string) => (id === 'opus' ? opusCat() : undefined),
        }),
      );
    });
  }

  it('cliDiagnostics on extra → CliDiagnosticsPanel mounts (not legacy red-pill text)', () => {
    const diag: CliDiagnostics = {
      reasonCode: 'auth_failed',
      publicSummary: 'API 认证失败',
      publicHint: '检查 .env API key',
      debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-1' },
    };
    render(makeErrorMessage({ cliDiagnostics: diag }));

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeTruthy();
    // Banner shows humanized summary, not the raw bubble content
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain('API 认证失败');
  });

  it('keeps terminal status out of the response body because the source receipt owns it', () => {
    render({
      id: 'response-owned-failure',
      from: { kind: 'agent', catId: 'opus' },
      type: 'assistant',
      catId: 'opus',
      content: 'Error: init_failure: CLI crashed',
      origin: 'stream',
      timestamp: 120,
      lifecycle: {
        kind: 'response',
        orderKey: '100:child-owned-failure',
        invocationId: 'child-owned-failure',
        targetId: 'opus',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['source-1'],
        status: 'failed',
        startedAt: 100,
        completedAt: 120,
        reason: 'provider_error',
      },
    });

    expect(container.querySelector('[data-lifecycle-terminal-status]')).toBeNull();
    expect(container.textContent).toContain('init_failure: CLI crashed');
    expect(container.textContent).toContain('布偶猫');
    expect(container.textContent).not.toContain('CLI Output');
  });

  it('does not render a lifecycle delivery-failure carrier as a standalone system warning', () => {
    const failure: ChatMessageType = {
      id: 'delivery-failure-carrier',
      from: { kind: 'system', service: 'message-delivery' },
      type: 'system',
      variant: 'error',
      content: 'opus 的当前 Agent Client 已关闭，消息未追加到该回合。',
      timestamp: 120,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '120:delivery-failure-carrier',
        status: 'failed',
        sourceEntryId: 'entry-1',
        inputMessageId: 'source-1',
        requestedTargets: ['opus'],
        reason: 'control_carrier_replaced',
        createdAt: 120,
      },
    };
    chatStoreState.messages = [
      {
        id: 'source-1',
        from: { kind: 'agent', catId: 'codex' },
        type: 'assistant',
        catId: 'codex',
        content: '@opus 处理',
        timestamp: 100,
        lifecycle: {
          kind: 'response',
          orderKey: '100:source-turn',
          invocationId: 'source-turn',
          targetId: 'codex',
          inputEntryIds: ['source-entry'],
          inputMessageIds: ['root-1'],
          status: 'completed',
          startedAt: 90,
          completedAt: 100,
          dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: 'delivery-failure-carrier' }],
        },
      },
      failure,
    ];
    render(failure);

    expect(container.textContent).not.toContain('Agent Client 已关闭');
    expect(container.querySelector('[data-message-id="delivery-failure-carrier"]')).toBeNull();
  });

  it('keeps an origin delivery failure visible when no source member can absorb it', () => {
    const failure: ChatMessageType = {
      id: 'origin-delivery-failure',
      from: { kind: 'system', service: 'message-delivery' },
      type: 'system',
      variant: 'error',
      content: '唤起 opus 失败：目标当前不可用',
      timestamp: 120,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '120:origin-delivery-failure',
        status: 'failed',
        sourceEntryId: 'entry-origin',
        inputMessageId: 'origin-source',
        requestedTargets: ['opus'],
        reason: 'invalid_explicit_target',
        createdAt: 120,
      },
    };
    chatStoreState.messages = [
      {
        id: 'origin-source',
        type: 'user',
        content: '@opus 请处理',
        timestamp: 100,
        lifecycle: {
          kind: 'input',
          orderKey: '100:origin-source',
          dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: 'origin-delivery-failure' }],
        },
      },
      failure,
    ];
    render(failure);

    expect(container.textContent).toContain('唤起 opus 失败');
    expect(container.querySelector('[data-message-id="origin-delivery-failure"]')).toBeTruthy();
  });

  it('keeps a targetless origin delivery failure visible instead of vacuously absorbing it', () => {
    const failure: ChatMessageType = {
      id: 'targetless-origin-failure',
      from: { kind: 'system', service: 'message-delivery' },
      type: 'system',
      variant: 'error',
      content: '唤起处理成员失败：没有可用目标',
      timestamp: 120,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '120:targetless-origin-failure',
        status: 'failed',
        sourceEntryId: 'entry-origin',
        inputMessageId: 'origin-source',
        requestedTargets: [],
        reason: 'no_available_target',
        createdAt: 120,
      },
    };
    chatStoreState.messages = [
      {
        id: 'origin-source',
        type: 'user',
        content: '请处理',
        timestamp: 100,
        lifecycle: { kind: 'input', orderKey: '100:origin-source', dispatchRefs: [] },
      },
      failure,
    ];
    render(failure);

    expect(container.textContent).toContain('唤起处理成员失败');
    expect(container.querySelector('[data-message-id="targetless-origin-failure"]')).toBeTruthy();
  });

  it('does not append a second absorption surface below classified terminal diagnostics', () => {
    const invocationId = 'child-gap-f-error';
    const sourceMessage = {
      id: 'source-gap-f-error',
      type: 'user',
      content: '失败前已经读取的补充',
      timestamp: 100,
      lifecycle: {
        kind: 'input',
        orderKey: '100:source-gap-f-error',
        dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: 'msg-err', dispatchedAt: 115 }],
      },
    } as ChatMessageType;
    const terminalMessage: ChatMessageType = {
      ...makeErrorMessage({
        cliDiagnostics: {
          reasonCode: 'auth_failed',
          publicSummary: 'API 认证失败',
          publicHint: '检查 API key',
          debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId },
        },
        turnExecution: {
          invocationId,
          parentInvocationId: 'parent-gap-f-error',
          executionKind: 'ordinary',
        },
      }),
      lifecycle: {
        kind: 'response',
        orderKey: `120:${invocationId}`,
        invocationId,
        targetId: 'opus',
        inputEntryIds: ['entry-gap-f-error'],
        inputMessageIds: [sourceMessage.id],
        status: 'failed',
        startedAt: 115,
        completedAt: 120,
      },
    };
    chatStoreState.messages = [sourceMessage, terminalMessage];

    render(terminalMessage);

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeTruthy();
    expect(container.querySelector(`[data-turn-absorption-invocation="${invocationId}"]`)).toBeNull();
  });

  it('system_info silent_completion + cliDiagnostics → CliDiagnosticsPanel mounts without error variant', () => {
    const diag: CliDiagnostics = {
      reasonCode: 'silent_completion',
      publicSummary: 'CLI 完成但无文字输出',
      publicHint: '展开详细诊断',
      debugRef: { command: 'opencode', exitCode: 0, signal: null, invocationId: 'inv-silent' },
      safeExcerpt: JSON.stringify({ eventCount: 1, eventTypes: ['step_start'], stderrPresent: false }),
      excerptSource: 'cc_structured',
    };
    render(makeSystemInfoMessage({ cliDiagnostics: diag }));

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      'CLI 完成但无文字输出',
    );
    expect(container.textContent).not.toContain('Error: CLI 异常退出');
  });

  it('classified cliDiagnostics (reasonCode present) takes precedence over timeoutDiagnostics', () => {
    const cliDiag: CliDiagnostics = {
      reasonCode: 'auth_failed',
      publicSummary: 'API 认证失败',
      publicHint: '检查 API key',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    };
    const timeoutDiag = { silenceDurationMs: 30000, processAlive: false };
    render(makeErrorMessage({ cliDiagnostics: cliDiag, timeoutDiagnostics: timeoutDiag }));

    // cliDiagnostics branch wins because reasonCode classifies the error
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeNull();
  });

  // 云端 codex P2-3 (2026-05-27): unknown-string reasonCode (persisted/newer payload)
  // + timeoutDiagnostics MUST yield to timeout — membership check at routing level,
  // not just truthy. Extends 砚砚 P1-1 by closing the version-skew loophole.
  it('unknown-string cliDiagnostics.reasonCode + timeoutDiagnostics → timeout wins (P2-3 guard)', () => {
    // Cast bypass: simulate newer api → older web (reasonCode not in palette).
    const cliDiag = {
      reasonCode: 'rate_limited_concurrent_future_code',
      publicSummary: 'Rate-limited (newer api)',
      publicHint: 'wait and retry',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    } as unknown as CliDiagnostics;
    const timeoutDiag = {
      silenceDurationMs: 1800000,
      processAlive: true,
      lastEventType: 'thread.started',
    };
    render(makeErrorMessage({ cliDiagnostics: cliDiag, timeoutDiagnostics: timeoutDiag }));

    // Timeout panel wins — F118 silence/processAlive survives version skew
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
  });

  // 砚砚 review P1-1 (2026-05-27): unclassified __cliTimeout.cliDiagnostics MUST yield
  // to timeoutDiagnostics so F118 silence/processAlive data survives.
  it('unclassified cliDiagnostics (no reasonCode) + timeoutDiagnostics → timeout panel wins (P1-1 guard)', () => {
    const cliDiag: CliDiagnostics = {
      // no reasonCode — Phase A emits this when classifier finds no match on __cliTimeout
      publicSummary: '未识别的 CLI 错误',
      publicHint: '详细诊断信息见后端日志',
      debugRef: { command: 'codex', exitCode: null, signal: 'SIGTERM' },
    };
    const timeoutDiag = {
      silenceDurationMs: 1800000,
      processAlive: true,
      lastEventType: 'thread.started',
      cliSessionId: 'cli-1',
      invocationId: 'inv-1',
    };
    render(makeErrorMessage({ cliDiagnostics: cliDiag, timeoutDiagnostics: timeoutDiag }));

    // Timeout panel wins so silenceDurationMs / processAlive / lastEventType stay visible
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
  });

  // F212 Phase B step 3 fallback: cliDiagnostics without reasonCode AND no timeoutDiagnostics
  // → CLI panel still wins (unknown-icon variant), better than legacy red-pill because
  // publicSummary / publicHint / debugRef are humanized.
  it('unclassified cliDiagnostics with no timeoutDiagnostics → CLI panel (unknown variant)', () => {
    const cliDiag: CliDiagnostics = {
      publicSummary: '未识别的 CLI 错误',
      publicHint: '详细诊断信息见后端日志',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    };
    render(makeErrorMessage({ cliDiagnostics: cliDiag }));

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeNull();
    // unknown-icon fallback variant present
    expect(container.querySelector('svg[aria-label="cli-error-unknown"]')).toBeTruthy();
  });

  it('error without cliDiagnostics + timeoutDiagnostics → timeout panel still used (regression guard)', () => {
    const timeoutDiag = { silenceDurationMs: 30000, processAlive: false };
    render(makeErrorMessage({ timeoutDiagnostics: timeoutDiag }));

    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
  });

  it('plain error without any diagnostics still renders legacy red-pill text', () => {
    render(makeErrorMessage({}));

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeout-diagnostics"]')).toBeNull();
    expect(container.textContent).toContain('Error: CLI 异常退出 (code: 1)');
  });

  // F212 follow-up — codex review P2 (PR #1967): hideDiagnosticsPanel=true must NOT drop
  // the entire ChatMessage. data-message-id anchor MUST stay in DOM so MessageNavigator
  // dots + ReplyPill jumps + scrollToMessage continue to resolve. Both classified and
  // unclassified routing paths in ChatMessage.tsx need the same anchor preservation.
  function renderWithDedup(message: ChatMessageType, hide: boolean): void {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message,
          getCatById: (id: string) => (id === 'opus' ? opusCat() : undefined),
          hideDiagnosticsPanel: hide,
        }),
      );
    });
  }

  it('classified cliDiagnostics + hideDiagnosticsPanel=true → panel hidden BUT data-message-id anchor preserved', () => {
    const diag: CliDiagnostics = {
      reasonCode: 'quota_exceeded',
      publicSummary: 'API 配额超限',
      publicHint: '请检查 quota',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    };
    const msg = { ...makeErrorMessage({ cliDiagnostics: diag }), id: 'dup-msg-classified' };
    renderWithDedup(msg, true);

    // Panel collapsed — group head already rendered it with ×N badge
    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
    // Anchor preserved — MessageNavigator/ReplyPill scrollToMessage still resolves
    expect(container.querySelector('[data-message-id="dup-msg-classified"]')).toBeTruthy();
  });

  it('unclassified cliDiagnostics + hideDiagnosticsPanel=true → panel hidden BUT data-message-id anchor preserved', () => {
    const diag: CliDiagnostics = {
      publicSummary: 'Claude Code 报告：xxx',
      publicHint: '看日志',
      debugRef: { command: 'codex', exitCode: 1, signal: null },
    };
    const msg = { ...makeErrorMessage({ cliDiagnostics: diag }), id: 'dup-msg-unclassified' };
    renderWithDedup(msg, true);

    expect(container.querySelector('[data-testid="cli-diagnostics"]')).toBeNull();
    expect(container.querySelector('[data-message-id="dup-msg-unclassified"]')).toBeTruthy();
  });
});
