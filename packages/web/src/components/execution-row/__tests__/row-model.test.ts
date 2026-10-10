/**
 * F322 original-B: the one-row surface's decisions, as a truth table.
 *
 * Each `it` is one of the ten states of the design (README §1.11 item 4), plus the rules the types alone
 * cannot hold: force-reset floats for exactly three abnormal classes, a reason this code has never heard of
 * still has words, and a visible row never renders as an empty string.
 */
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import type { QueueEntry } from '@/stores/chat-types';
import {
  blockedReasonCopy,
  deriveExecutionRow,
  type ExecutionRowInput,
  FORCE_RESET_REASON_COPY,
  formatClock,
  rowStatusText,
} from '../row-model';

const NOW = 1_000_000_000;
const nameOf = (catId: string) => ({ opus: '宪宪', codex: '砚砚' })[catId as 'opus'] ?? catId;

function live(catId: string, over: Partial<ActiveExecutionProjection> = {}): ActiveExecutionProjection {
  const base: ActiveExecutionProjection = {
    executionId: `exec-${catId}`,
    threadId: 'thread-1',
    threadTitle: null,
    catId,
    kind: 'live_invocation',
    startedAt: NOW - 125_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: 'thread-1', catId, executionId: `exec-${catId}` },
    },
  };
  return { ...base, ...over };
}

function entry(id: string, status: QueueEntry['status'] = 'queued'): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'u1',
    content: `message ${id}`,
    messageId: `m-${id}`,
    mergedMessageIds: [],
    from: { kind: 'user', userId: 'u1' },
    targetCats: ['opus'],
    intent: 'execute',
    status,
    createdAt: NOW,
  };
}

function input(
  over: Omit<Partial<ExecutionRowInput>, 'queue'> & { queue?: Partial<ExecutionRowInput['queue']> } = {},
): ExecutionRowInput {
  const { queue, ...rest } = over;
  const entries = queue?.entries ?? [];
  return {
    now: NOW,
    executions: [],
    cancelPendingKeys: new Set(),
    silent: {},
    hydrationStale: false,
    hasUnverifiedLegacyExecution: false,
    queue: {
      entries,
      canRecoverOrphaned: false,
      waitInfo: null,
      ...queue,
    },
    ...rest,
  };
}

const text = (i: ExecutionRowInput) => rowStatusText(deriveExecutionRow(i), nameOf);

describe('the ten states of the one row', () => {
  it('1  one running: who, "正在工作", the clock, a ■', () => {
    const e = live('opus');
    const model = deriveExecutionRow(input({ executions: [e] }));
    expect(model.status).toBe('working');
    expect(rowStatusText(model, nameOf)).toBe('宪宪 正在工作 2:05');
    expect(model.stop).toEqual({ kind: 'button', execution: e });
    expect(model.panelToggle).toBe(false);
    expect(model.forceReset).toEqual([]);
  });

  it('2  one running with a queue: "· 排队 N", a chevron, a ■', () => {
    const e = live('opus');
    const i = input({ executions: [e], queue: { entries: [entry('q1'), entry('q2')] } });
    const model = deriveExecutionRow(i);
    expect(text(i)).toBe('宪宪 正在工作 2:05 · 排队 2');
    expect(model.panelToggle).toBe(true);
    expect(model.stop.kind).toBe('button');
  });

  it('3  several running: a count, no single ■ (each run has its own in the panel)', () => {
    const i = input({
      executions: [live('opus'), live('codex', { startedAt: NOW - 5_000 }), live('x', { executionId: 'e3' })],
      queue: { entries: [entry('q1')] },
    });
    const model = deriveExecutionRow(i);
    expect(text(i)).toBe('3 件在跑 · 排队 1');
    expect(model.stop).toEqual({ kind: 'none' });
    expect(model.panelToggle).toBe(true);
  });

  it('4  one quiet among several: an amber count and a floating 强制重置', () => {
    const quiet = live('opus');
    const i = input({
      executions: [quiet, live('codex')],
      silent: { [activeExecutionKey(quiet)]: { since: NOW - 60_000 } },
    });
    const model = deriveExecutionRow(i);
    expect(model.status).toBe('silent');
    expect(text(i)).toBe('1 件没动静');
    expect(model.forceReset).toEqual(['silent_turn']);
  });

  it('5  a single quiet turn: minutes of silence, the clock, 强制重置 AND the ■', () => {
    const e = live('opus');
    const i = input({ executions: [e], silent: { [activeExecutionKey(e)]: { since: NOW - 3 * 60_000 } } });
    const model = deriveExecutionRow(i);
    expect(text(i)).toBe('3 分钟没有动静 2:05');
    expect(model.forceReset).toEqual(['silent_turn']);
    expect(model.stop).toEqual({ kind: 'button', execution: e });
  });

  it('5b a quiet turn whose silence start is unknown says so instead of inventing minutes', () => {
    const e = live('opus');
    const i = input({ executions: [e], silent: { [activeExecutionKey(e)]: { since: null } } });
    expect(text(i)).toBe('没有动静 2:05');
  });

  it('6  stopping: "正在停止", the clock, no ■', () => {
    const e = live('opus');
    const i = input({ executions: [e], cancelPendingKeys: new Set([activeExecutionKey(e)]) });
    const model = deriveExecutionRow(i);
    expect(model.status).toBe('stopping');
    expect(text(i)).toBe('正在停止 2:05');
    expect(model.stop).toEqual({ kind: 'pending' });
  });

  it('7  cannot stop: the managed work and the reason, no ■', () => {
    const e = live('opus', {
      kind: 'managed_command',
      activity: 'full_gate',
      cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
    });
    const model = deriveExecutionRow(input({ executions: [e] }));
    expect(model.status).toBe('blocked');
    expect(model.stop).toEqual({ kind: 'blocked', reason: 'foreign_principal' });
    expect(rowStatusText(model, nameOf)).toMatch(/你不能停 2:05$/);
    expect(rowStatusText(model, nameOf)).toContain('门禁');
  });

  it('8  the legacy socket says running but nothing can be verified: "运行状态待确认" + 强制重置', () => {
    const i = input({ hasUnverifiedLegacyExecution: true });
    const model = deriveExecutionRow(i);
    expect(model.status).toBe('unverified');
    expect(text(i)).toBe('运行状态待确认');
    expect(model.forceReset).toEqual(['unverified_legacy']);
    expect(model.visible).toBe(true);
  });

  it('9 delivered work stays out of Queue; waiting inputs offer no execution reset', () => {
    const i = input({ queue: { entries: [entry('a'), entry('b')] } });
    const model = deriveExecutionRow(i);
    expect(model.status).toBe('waiting');
    expect(text(i)).toBe('排队 2');
    expect(model.forceReset).toEqual([]);
  });

  it('pending work has one waiting state with no parallel pause result', () => {
    const i = input({
      queue: { entries: [entry('a'), entry('b'), entry('c')] },
    });
    const model = deriveExecutionRow(i);
    expect(model.status).toBe('waiting');
    expect(text(i)).toBe('排队 3');
    expect(model.resume).toBe(null);
    expect(model.forceReset).toEqual([]);
  });
});

describe('rules the states do not state', () => {
  it('nothing to say ⇒ the row takes no space', () => {
    expect(deriveExecutionRow(input()).visible).toBe(false);
  });

  it('an empty queue has no continuation or pause control', () => {
    const model = deriveExecutionRow(input({ queue: { entries: [] } }));
    expect(model.visible).toBe(false);
    expect(model.resume).toBe(null);
  });

  it('waiting only: "排队 N" with a chevron', () => {
    const i = input({ queue: { entries: [entry('a'), entry('b')] } });
    expect(text(i)).toBe('排队 2');
    expect(deriveExecutionRow(i).panelToggle).toBe(true);
  });

  it('force-reset belongs to abnormal execution, never to waiting Queue entries', () => {
    const quiet = live('opus');
    const everything = deriveExecutionRow(
      input({
        executions: [quiet],
        silent: { [activeExecutionKey(quiet)]: { since: NOW - 1 } },
        queue: { entries: [entry('a')] },
      }),
    );
    expect(everything.forceReset).toEqual(['silent_turn']);
    // A healthy run, a paused queue, an orphaned queue and a stale badge never float a reset.
    const calm = deriveExecutionRow(
      input({
        executions: [live('opus')],
        hydrationStale: true,
        queue: { canRecoverOrphaned: true, entries: [entry('a')] },
      }),
    );
    expect(calm.forceReset).toEqual([]);
    expect(Object.keys(FORCE_RESET_REASON_COPY).sort()).toEqual(['silent_turn', 'unverified_legacy']);
  });

  it('an unverified legacy turn does not float a reset once the canonical projection shows runs', () => {
    const model = deriveExecutionRow(input({ executions: [live('opus')], hasUnverifiedLegacyExecution: true }));
    expect(model.forceReset).toEqual([]);
  });

  it('an orphaned queue offers one recovery action', () => {
    expect(deriveExecutionRow(input({ queue: { canRecoverOrphaned: true, entries: [entry('a')] } })).resume).toBe(
      'recover',
    );
  });

  it("a floating 强制重置 is not joined on the row by an orphaned queue's 恢复 (the panel header still offers it)", () => {
    const stuck = deriveExecutionRow(
      input({ hasUnverifiedLegacyExecution: true, queue: { canRecoverOrphaned: true, entries: [entry('a')] } }),
    );
    expect(stuck.forceReset).toEqual(['unverified_legacy']);
    expect(stuck.resume).toBe('recover');
    expect(stuck.resumeOnRow).toBe(null);
    // Without a floating reset the same orphaned queue shows 恢复 on the row.
    expect(deriveExecutionRow(input({ queue: { canRecoverOrphaned: true, entries: [entry('a')] } })).resumeOnRow).toBe(
      'recover',
    );
    // A paused queue's 继续 is its own state: it stays even next to a reset.
    const quiet = live('opus');
    const both = deriveExecutionRow(
      input({
        executions: [quiet],
        silent: { [activeExecutionKey(quiet)]: { since: null } },
        queue: { canRecoverOrphaned: true, entries: [entry('a')] },
      }),
    );
    expect(both.forceReset).toEqual(['silent_turn']);
    expect(both.resumeOnRow).toBe(null);
  });

  it('pending Queue and live execution retain their separate facts', () => {
    const i = input({ executions: [live('opus')], queue: { entries: [entry('a')] } });
    expect(text(i)).toBe('宪宪 正在工作 2:05 · 排队 1');
    expect(deriveExecutionRow(i).resume).toBe(null);
  });

  it('the stale-hydration badge needs something shown to attach to', () => {
    expect(deriveExecutionRow(input({ executions: [live('opus')], hydrationStale: true })).staleNote).toBe(true);
    expect(deriveExecutionRow(input({ hydrationStale: true })).staleNote).toBe(false);
  });

  it('every non-cancelable reason has words, including one this code has never heard of', () => {
    for (const reason of ['control_plane_unavailable', 'cancellation_pending', 'terminalizing', 'foreign_principal']) {
      expect(blockedReasonCopy(reason).length).toBeGreaterThan(0);
    }
    expect(blockedReasonCopy('some_future_reason')).toBe('暂时不能停');
  });

  it('a visible row is never an empty string, whatever the combination', () => {
    const quiet = live('opus');
    const blocked = live('codex', {
      cancelability: { state: 'not_cancelable', reason: 'some_future_reason' as never },
    });
    const cases: ExecutionRowInput[] = [
      input({ executions: [quiet] }),
      input({ executions: [blocked] }),
      input({ executions: [quiet, blocked], silent: { [activeExecutionKey(quiet)]: { since: null } } }),
      input({ hasUnverifiedLegacyExecution: true }),
      input({ queue: { entries: [entry('s')] } }),
      input({ queue: { entries: [entry('a')] } }),
    ];
    for (const c of cases) {
      const model = deriveExecutionRow(c);
      expect(model.visible).toBe(true);
      expect(rowStatusText(model, nameOf).trim().length).toBeGreaterThan(0);
    }
  });

  it('formats the clock as m:ss and never goes negative', () => {
    expect(formatClock(125_000)).toBe('2:05');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(3_600_000)).toBe('60:00');
  });
});
