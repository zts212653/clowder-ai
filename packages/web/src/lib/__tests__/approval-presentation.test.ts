import type { ApprovalLifecycleProjection } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { approvalLifecyclePresentation } from '../approval-presentation';

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
