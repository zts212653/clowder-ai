import { describe, expect, it } from 'vitest';
import { messageSearchNotice } from '../message-search-notice.js';

const explain = (
  supported: number,
  rejected: number,
  indeterminate: number,
  unassessed: number,
  shown = 0,
  batches?: object,
) =>
  messageSearchNotice({
    results: Array(shown).fill({}),
    meta: {
      qualification: {
        status: unassessed || indeterminate ? 'partial' : 'complete',
        examined: supported + rejected + indeterminate + unassessed,
        supported,
        rejected,
        indeterminate,
        unassessed,
        ...(batches ? { batches } : {}),
      },
    },
  });

describe('one qualification explanation for cat and human consumers', () => {
  it('keeps the natural zero-start, cancelled and limited-assessment cases distinct without inferring a cause', () => {
    const zero = explain(0, 0, 0, 1953, 0, { started: 0, completed: 0, cancelled: 0, failed: 0 });
    expect(zero.summary).toContain('全部尚未评估');
    expect(zero.execution).toContain('没有启动评估批次');
    expect(zero.execution).not.toMatch(/并发|超时|预算/);
    const cancelled = explain(0, 0, 0, 1651, 0, { started: 2, completed: 0, cancelled: 2, failed: 0 });
    expect(cancelled.execution).toContain('取消 2');
    const limited = explain(0, 7, 2, 353, 0, { started: 2, completed: 2, cancelled: 0, failed: 0 });
    expect(limited.counts?.assessed).toBe(9);
    expect(limited.counts?.indeterminate).toBe(2);
    expect(limited.counts?.unassessed).toBe(353);
    expect(limited.summary).not.toContain('全部尚未评估');
    expect(limited.summary).toContain('不能据此判断历史没有');
    expect(explain(0, 0, 0, 1651).execution).toBeUndefined();
  });

  it('retains a visible coverage limit alongside a few readable results and suggests reading only those results', () => {
    const notice = explain(4, 0, 4, 43, 4);
    expect(notice.summary).toContain('4 处可读匹配');
    expect(notice.counts).toEqual({
      candidates: 51,
      assessed: 8,
      supported: 4,
      rejected: 0,
      indeterminate: 4,
      unassessed: 43,
    });
    expect(notice.nextStep).toContain('已显示的原文');
    expect(notice.coverage).toContain('尚未确认');
  });

  it('does not mistake literal support with no native calls, no candidates, or all rejection for unassessed work', () => {
    const literal = explain(9, 0, 0, 0, 8, { started: 0, completed: 0, cancelled: 0, failed: 0 });
    expect(literal.counts?.assessed).toBe(9);
    expect(literal.execution).toBeUndefined();
    expect(literal.summary).not.toContain('尚未评估');
    expect(explain(0, 0, 0, 0).summary).toContain('未取得可评估候选');
    expect(explain(0, 9, 0, 0).summary).toContain('9 条候选均不支持');
    expect(explain(0, 0, 2, 0).counts?.assessed).toBe(2);
    expect(explain(0, 0, 2, 0).summary).not.toContain('全部尚未评估');
  });

  it('keeps absent or contradictory legacy counts unknown and never invents an open action', () => {
    for (const meta of [
      undefined,
      {},
      { qualification: { examined: 3, supported: 0, rejected: 0, indeterminate: 0, unassessed: 2 } },
    ]) {
      const notice = messageSearchNotice({ results: [], meta });
      expect(notice.counts).toBeUndefined();
      expect(notice.summary).toContain('未知');
      expect(notice.nextStep).not.toContain('打开');
    }
  });
});
