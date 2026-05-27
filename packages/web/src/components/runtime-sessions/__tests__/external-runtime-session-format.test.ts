import { describe, expect, it } from 'vitest';
import {
  formatBindingLabel,
  formatLifecycleBadge,
  formatRuntimeLabel,
  formatRuntimeSessionTitle,
  formatSealReason,
  shortRuntimeId,
} from '../external-runtime-session-format';
import type { ExternalRuntimeSessionListItem } from '../external-runtime-session-types';

function session(overrides: Partial<ExternalRuntimeSessionListItem> = {}): ExternalRuntimeSessionListItem {
  return {
    sessionId: 'session-1',
    threadId: 'external-runtime:antigravity-desktop:user-1',
    runtime: 'antigravity-desktop',
    runtimeSessionId: 'cascade-0123456789abcdef0123456789abcdef',
    runtimeConversationId: 'conversation-1',
    catId: 'antigravity',
    model: 'gemini-3.1-pro',
    title: 'IDE direct investigation',
    lastObservedAt: 1000,
    lifecycle: { state: 'active', startedAt: 500, lastObservedAt: 1000 },
    binding: { mode: 'orphan_anchor', anchorThreadId: 'external-runtime:antigravity-desktop:user-1' },
    drilldown: {
      sessionRecord: '/api/sessions/session-1',
      events: '/api/sessions/session-1/events',
      digest: '/api/sessions/session-1/digest',
    },
    ...overrides,
  };
}

describe('external runtime session formatting', () => {
  it('formats known runtime names and falls back to raw runtime ids', () => {
    expect(formatRuntimeLabel('antigravity-desktop')).toBe('Antigravity Desktop');
    expect(formatRuntimeLabel('custom-runtime')).toBe('custom-runtime');
  });

  it('formats lifecycle badges for active, sealed, pending seal, and conflict states', () => {
    expect(formatLifecycleBadge({ state: 'active', startedAt: 0, lastObservedAt: 1 })).toMatchObject({
      label: '进行中',
      tone: 'active',
    });
    expect(formatLifecycleBadge({ state: 'sealed', startedAt: 0, lastObservedAt: 1 })).toMatchObject({
      label: '已封存',
      tone: 'sealed',
    });
    expect(formatLifecycleBadge({ state: 'runtime_seal_pending', startedAt: 0, lastObservedAt: 1 })).toMatchObject({
      label: '封存中',
      tone: 'pending',
    });
    expect(formatLifecycleBadge({ state: 'runtime_conflict_pending', startedAt: 0, lastObservedAt: 1 })).toMatchObject({
      label: '冲突待处理',
      tone: 'attention',
    });
  });

  it('formats canonical seal reasons with a raw fallback', () => {
    expect(formatSealReason('oversized_retire')).toBe('上下文过大');
    expect(formatSealReason('user_initiated')).toBe('用户重置');
    expect(formatSealReason('empty_response')).toBe('空响应');
    expect(formatSealReason('tool_conflict')).toBe('工具冲突');
    expect(formatSealReason('runtime_disconnected')).toBe('Runtime 断开');
    expect(formatSealReason('future_reason')).toBe('future_reason');
    expect(formatSealReason(undefined)).toBe('—');
  });

  it('formats binding labels without exposing anchor threads as normal threads', () => {
    expect(formatBindingLabel({ mode: 'orphan_anchor', anchorThreadId: 'external-runtime:antigravity:user-1' })).toBe(
      'IDE 直连',
    );
    expect(formatBindingLabel({ mode: 'thread', threadId: 'thread-1' })).toBe('Thread 绑定');
  });

  it('uses title, model fallback, and short runtime id fallback for session titles', () => {
    expect(formatRuntimeSessionTitle(session())).toBe('IDE direct investigation');
    expect(formatRuntimeSessionTitle(session({ title: undefined }))).toBe('antigravity · gemini-3.1-pro');
    expect(formatRuntimeSessionTitle(session({ title: undefined, model: undefined }))).toBe(
      'antigravity · cascade-012…89abcdef',
    );
  });

  it('shortens long runtime ids and keeps short ids unchanged', () => {
    expect(shortRuntimeId('short-id')).toBe('short-id');
    expect(shortRuntimeId('cascade-0123456789abcdef0123456789abcdef')).toBe('cascade-012…89abcdef');
  });
});
