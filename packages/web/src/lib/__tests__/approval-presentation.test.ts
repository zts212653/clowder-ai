import type { ApprovalLifecycleProjection } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { approvalDisplayTitle, approvalLifecyclePresentation } from '../approval-presentation';

const projection = (
  resolution: ApprovalLifecycleProjection['resolution'],
  materialization: ApprovalLifecycleProjection['materialization'],
): ApprovalLifecycleProjection => ({ resolution, materialization });

describe('F313 canonical Approval lifecycle presentation', () => {
  it.each([
    [projection('open', { state: 'not_started' }), '待决定', 'muted'],
    [projection('rejected', { state: 'not_started' }), '已拒绝', 'critical'],
    [projection('closed_without_decision', { state: 'not_started' }), '未决定已关闭', 'muted'],
    [projection('accepted', { state: 'not_started' }), '已批准', 'success'],
    [projection('accepted', { state: 'outcome_unknown' }), '已批准 · 结果待确认', 'muted'],
    [projection('accepted', { state: 'in_progress', attemptRef: 'attempt:1' }), '已批准 · 执行中', 'muted'],
    [projection('accepted', { state: 'succeeded', effectProofRef: 'receipt:1' }), '已批准 · 已执行', 'success'],
    [
      projection('accepted', { state: 'failed', failureRef: 'failure:1', retryable: true }),
      '已批准 · 执行失败',
      'critical',
    ],
  ] as const)('maps %j to the one Hub vocabulary', (item, label, tone) => {
    expect(approvalLifecyclePresentation(item)).toEqual({ label, tone });
  });
});

describe('approvalDisplayTitle first-screen projection', () => {
  const names: Record<string, string> = { 'codex-sol': '小太阳·砚砚', opus55: '布偶猫 Opus 5.5' };
  const resolveCatName = (catId: string) => names[catId] ?? catId;

  it('titles F193 dispatch proposals with resolved target cat names instead of raw content', () => {
    const title = approvalDisplayTitle(
      {
        sourceFeatureId: 'F193',
        summary: 'Work assignment: @codex-sol\n请 review 这个很技术的内容 abc123def',
        detail: { targetCats: ['codex-sol', 'opus55'] },
      },
      { resolveCatName },
    );
    expect(title).toBe('派给 小太阳·砚砚、布偶猫 Opus 5.5 的工作');
    expect(title).not.toContain('abc123def');
  });

  it('falls back to the stripped summary when F193 has no target cats', () => {
    const title = approvalDisplayTitle(
      { sourceFeatureId: 'F193', summary: 'Work assignment: 整理 backlog', detail: {} },
      { resolveCatName },
    );
    expect(title).toBe('整理 backlog');
  });

  it('rewrites the F225 leading cat id to a display name and keeps unknown ids as stored', () => {
    expect(
      approvalDisplayTitle(
        { sourceFeatureId: 'F225', summary: 'Session handoff: codex-sol → 修完了三页' },
        { resolveCatName },
      ),
    ).toBe('小太阳·砚砚 → 修完了三页');
    expect(
      approvalDisplayTitle(
        { sourceFeatureId: 'F225', summary: 'Session handoff: ghost-cat → 修完了三页' },
        { resolveCatName },
      ),
    ).toBe('ghost-cat → 修完了三页');
  });

  it('strips the F266 type prefix so only the finding key remains', () => {
    expect(
      approvalDisplayTitle({ sourceFeatureId: 'F266', summary: 'Eval repair · paw-feel-coverage' }, { resolveCatName }),
    ).toBe('paw-feel-coverage');
  });
});

describe('approvalDisplayTitle F193 task line', () => {
  const names: Record<string, string> = { 'codex-sol': '小太阳·砚砚', opus55: '布偶猫 Opus 5.5' };
  const resolveCatName = (catId: string) => names[catId] ?? catId;

  it('keeps the readable task line in the default title alongside resolved names', () => {
    const title = approvalDisplayTitle(
      {
        sourceFeatureId: 'F193',
        summary: 'Work assignment: @codex-sol\n请 review F322 三页改动',
        detail: { targetCats: ['codex-sol', 'opus55'], content: '@codex-sol\n请 review F322 三页改动' },
      },
      { resolveCatName },
    );
    expect(title).toBe('派给 小太阳·砚砚、布偶猫 Opus 5.5：请 review F322 三页改动');
  });

  it('keeps the task line even when no target cats resolve', () => {
    expect(
      approvalDisplayTitle(
        { sourceFeatureId: 'F193', summary: 'Work assignment: 整理 backlog', detail: { content: '整理 backlog' } },
        { resolveCatName },
      ),
    ).toBe('整理 backlog');
  });

  it('skips routing-only lines when picking the task line', () => {
    const title = approvalDisplayTitle(
      {
        sourceFeatureId: 'F193',
        summary: 'Work assignment: x',
        detail: { content: '@codex-sol\n## 主 Thread\n请处理 census 缺口' },
      },
      { resolveCatName },
    );
    expect(title).toBe('请处理 census 缺口');
  });
});
