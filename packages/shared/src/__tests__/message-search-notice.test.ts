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
  it('explains selected material without turning the cat judgment into qualification counts', () => {
    const notice = messageSearchNotice({ results: [{}], meta: { resultKind: 'selected-answer', hasMore: true } });
    expect(notice.summary).toContain('猫选出的 1 处来源');
    expect(notice.summary).toContain('选用理由由选材猫判断');
    expect(notice.coverage).toContain('没有重新搜索');
    expect(notice.coverage).toContain('未在本卡显示');
    expect(notice.counts).toBeUndefined();
    expect(notice.execution).toBeUndefined();
  });
  it('explains ordinary sources without inventing qualification or forcing a narrower second query', () => {
    const notice = messageSearchNotice({ results: [{}, {}], meta: { resultKind: 'sources', sort: 'relevance' } });
    expect(notice.summary).toContain('2 处可打开的原文');
    expect(notice.summary).not.toMatch(/资格|未评|支持|拒绝/);
    expect(notice.counts).toBeUndefined();
    expect(notice.execution).toBeUndefined();
    expect(notice.nextStep).toContain('打开原文');
    expect(notice.nextStep).not.toContain('缩小');
  });

  it('reports a completed relevance window and its honest early-stop coverage separately', () => {
    const full = messageSearchNotice({
      results: [{}],
      meta: {
        resultKind: 'sources',
        sort: 'time',
        timeWindow: { limit: 32, admitted: 32, complete: true },
      },
    });
    expect(full.coverage).toContain('前 32 条');
    expect(full.coverage).toContain('窗口外可能有更早的原文');
    const partial = messageSearchNotice({
      results: [{}],
      meta: {
        resultKind: 'sources',
        sort: 'time',
        timeWindow: { limit: 32, admitted: 12, complete: false },
      },
    });
    expect(partial.coverage).toContain('核完 12 条');
    expect(partial.coverage).toContain('未读满 32 条');
    expect(partial.coverage).not.toContain('取得前 32 条');
  });

  it('discloses omitted sources even when the relevance window itself was read completely', () => {
    const notice = messageSearchNotice({
      results: Array(8).fill({}),
      meta: {
        resultKind: 'sources',
        sort: 'time',
        hasMore: true,
        timeWindow: { limit: 32, admitted: 32, complete: true },
      },
    });
    expect(notice.coverage).toContain('前 32 条');
    expect(notice.coverage).toContain('仅列出本次可得的部分来源');
  });

  it('round-trips optional notice fields through JSON without changing own keys', () => {
    const notices = [
      messageSearchNotice({ results: [] }),
      explain(9, 0, 0, 0, 8, { started: 0, completed: 0, cancelled: 0, failed: 0 }),
      explain(0, 0, 0, 1953),
      explain(0, 0, 0, 1953, 0, { started: 1, completed: 0, cancelled: 0, failed: 0 }),
      explain(0, 0, 0, 1953, 0, { started: 0, completed: 0, cancelled: 0, failed: 0 }),
      explain(0, 0, 0, 1651, 0, { started: 2, completed: 0, cancelled: 2, failed: 0 }),
    ];
    for (const notice of notices) {
      // Saved answer snapshots must equal the in-memory response, including absent optional keys.
      expect(JSON.parse(JSON.stringify(notice))).toStrictEqual(notice);
    }
    expect(notices[4].execution).toContain('没有启动评估批次');
    expect(notices[5].execution).toContain('取消 2');
  });

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
