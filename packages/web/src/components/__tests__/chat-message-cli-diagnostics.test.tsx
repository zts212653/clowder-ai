import type { CliDiagnostics } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

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
      messages: [],
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
    resetCoCreatorConfigCacheForTest();
    primeCoCreatorConfigCache({
      name: '铲屎官',
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
