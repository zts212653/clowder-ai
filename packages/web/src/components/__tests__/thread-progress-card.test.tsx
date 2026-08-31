import { createCatId, type ThreadBriefV1 } from '@cat-cafe/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThreadProgressCardView } from '../ThreadProgressCard';

function brief(patch: Partial<ThreadBriefV1> = {}): ThreadBriefV1 {
  return {
    v: 1,
    thread: { id: 'thread-secret-id', title: 'Runtime harness 深入学习' },
    contextHeading: { label: '会话', text: 'Runtime harness 深入学习' },
    availability: 'ok',
    presentationState: 'running',
    currentExecutions: [
      { catId: 'cat-internal-id', startedAt: 100, confidence: 'confirmed', action: '组装会话进度视图' },
    ],
    attention: [],
    waits: [],
    recentProgress: [
      {
        id: 'receipt-secret-id',
        kind: 'milestone',
        headline: 'Receipt 基础链路已经跑通',
        nextStep: '完成单会话验收',
        actor: { kind: 'cat', catId: createCatId('cat-internal-id') },
        occurredAt: 200,
      },
    ],
    lastProgressAt: 200,
    nextStep: '完成单会话验收',
    openWorkTaskCount: 1,
    hasHistory: true,
    generatedAt: 300,
    ...patch,
  };
}

function render(value: ThreadBriefV1, collapsed: boolean): string {
  return renderToStaticMarkup(
    <ThreadProgressCardView
      brief={value}
      loading={false}
      error={false}
      collapsed={collapsed}
      resolveCatName={() => '宪宪'}
      onToggle={vi.fn()}
      onOpenProgress={vi.fn()}
    />,
  );
}

describe('ThreadProgressCard', () => {
  it('uses a 40px collapsed state and an 84px summary state', () => {
    expect(render(brief(), true)).toContain('h-10');
    const summary = render(brief(), false);
    expect(summary).toContain('min-h-[84px]');
    expect(summary).toContain('Receipt 基础链路已经跑通');
    expect(summary).toContain('完成单会话验收');
  });

  it('keeps degraded and unavailable wording distinct from running', () => {
    const degraded = render(
      brief({
        presentationState: 'unknown',
        currentExecutions: [{ catId: 'cat-internal-id', startedAt: 100, confidence: 'degraded' }],
      }),
      true,
    );
    const unavailable = render(
      brief({ presentationState: 'unknown', availability: 'unavailable', currentExecutions: [] }),
      true,
    );
    expect(degraded).toContain('状态确认中');
    expect(unavailable).toContain('暂时无法确认');
    expect(degraded).not.toContain('正在推进');
  });

  it('shows needs-user without forcing expansion and hides internal identifiers', () => {
    const html = render(
      brief({
        presentationState: 'needs_user',
        attention: [{ kind: 'approval', label: '需要你确认 Phase A 范围', createdAt: 250 }],
      }),
      true,
    );
    expect(html).toContain('需要你确认 Phase A 范围');
    expect(html).toContain('宪宪仍在推进');
    expect(html).toContain('data-density="collapsed"');
    expect(html).not.toContain('cat-internal-id');
    expect(html).not.toContain('receipt-secret-id');
    expect(html).not.toContain('thread-secret-id');
  });
});
