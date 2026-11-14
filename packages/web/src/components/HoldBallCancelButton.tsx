'use client';

import type { HoldCancelEntry } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { apiFetch } from '@/utils/api-client';
import { ExecutionCancelButton } from './ExecutionCancelButton';
import { managedJobCopy } from './managed-job/managed-job.shell-copy';
import { type RecoveryDetail, readRecovery, recoveryObject, recoveryPending } from './managed-job/recovery-projection';
import { useShellCopy } from './shell/shell-copy';

type HoldTerminalStatus =
  | 'retired_by_event'
  | 'retired_expired'
  | 'retired_invalid'
  | 'fired'
  | 'escalated'
  | 'ended'
  | null;

/**
 * One label per probe-reported terminal. Exhaustive by construction: a new
 * terminal status is a compile error here rather than a missing branch that
 * would quietly fall through to the cancel buttons.
 */
const HOLD_TERMINAL_LABELS: Record<Exclude<HoldTerminalStatus, null>, string> = {
  retired_by_event: '已被事件唤醒',
  retired_expired: '已超过等待截止，未唤醒。原任务未完成，请在当前对话重新安排跟进。',
  retired_invalid: '等待窗口无效，未唤醒。原任务未完成，请在当前对话重新安排跟进。',
  fired: '已完成',
  escalated: '已升级处理',
  ended: '已结束',
};

function projectHoldTerminalStatus(body: { status?: unknown; cancelable?: unknown } | null): HoldTerminalStatus {
  if (body?.cancelable !== false) return null;
  if (body.status === 'retired_by_event') return 'retired_by_event';
  if (body.status === 'retired_expired') return 'retired_expired';
  if (body.status === 'retired_invalid') return 'retired_invalid';
  if (body.status === 'fired') return 'fired';
  if (body.status === 'escalated') return 'escalated';
  return 'ended';
}

export function HoldBallCancelButton({
  taskId,
  threadId,
  catId,
  cancelEntry,
}: {
  taskId: string;
  threadId?: string;
  catId?: string;
  cancelEntry: HoldCancelEntry;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [terminalStatus, setTerminalStatus] = useState<HoldTerminalStatus>(null);
  const [recovery, setRecovery] = useState<RecoveryDetail | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState(false);
  const [serverCancelable, setServerCancelable] = useState<boolean | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNonce, setRecheckNonce] = useState(0);
  const words = useShellCopy(managedJobCopy);
  const managedExecution = useActiveExecutionStore((store) => store.executionsByKey[`managed_command:${taskId}`]);

  useEffect(() => {
    void recheckNonce;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const res = await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}/status`);
        if (cancelled) return;
        if (res.status === 404) {
          setServerCancelable(false);
          setTerminalStatus('ended');
          return;
        }
        if (!res.ok) return;
        const body = recoveryObject(await res.json().catch(() => null));
        const nextRecovery = readRecovery(body?.recovery, 'wait');
        const nextPending = recoveryPending(body?.recovery);
        setRecovery(nextRecovery);
        setPendingRecovery(nextPending);
        setServerCancelable(typeof body?.cancelable === 'boolean' ? body.cancelable : null);
        setTerminalStatus(nextRecovery || nextPending ? null : projectHoldTerminalStatus(body));
        if (nextPending) timer = setTimeout(() => void refresh(), 2000);
      } catch {
        // Status is a read-side affordance. Keep the existing cancel controls if it fails.
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [recheckNonce, taskId]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}/recheck`, { method: 'POST' });
    } finally {
      setRechecking(false);
      setRecheckNonce((value) => value + 1);
    }
  }, [taskId]);

  const handleCancel = useCallback(
    async (withFeedback = false) => {
      setState('loading');
      try {
        const feedbackQuery = withFeedback ? '?withFeedback=1' : '';
        const res = await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}${feedbackQuery}`, {
          method: 'DELETE',
        });
        if (res.ok || (res.status === 404 && !withFeedback)) {
          setState('done');
          return;
        }
        if (res.status === 404 && withFeedback && threadId) {
          const fallbackRes = await apiFetch('/api/callbacks/hold-ball/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              threadId,
              taskId,
              ...(catId ? { catId } : {}),
            }),
          });
          setState(fallbackRes.ok ? 'done' : 'idle');
          return;
        }
        setState('idle');
      } catch {
        setState('idle');
      }
    },
    [catId, taskId, threadId],
  );

  const recoveryBody = recovery ? (
    <div
      data-testid="managed-wait-recovery"
      className="rounded border border-cafe-accent/40 bg-cafe-accent/5 p-3 text-xs"
    >
      <p className="font-medium text-cafe-secondary">{words.recoveryTitle}</p>
      <p className="mt-1 text-cafe-muted">
        {words.recoveryState[recovery.disposition]} · {words.recoveryReason(recovery.reasonCode)}
      </p>
      {recovery.recheck ? (
        <button
          type="button"
          disabled={rechecking}
          onClick={() => void recheck()}
          className="shell-focusable mt-2 rounded border border-cafe-border px-2 py-1 text-cafe-secondary disabled:opacity-50"
        >
          {rechecking ? words.rechecking : words.recheck}
        </button>
      ) : null}
    </div>
  ) : pendingRecovery ? (
    <span className="text-xs text-cafe-secondary">{words.recoveryPending}</span>
  ) : null;
  const actionBody = renderHoldFooterBody();
  if (recoveryBody === null && actionBody === null) return null;
  return (
    <div className="mt-2 space-y-2 border-t border-cafe-border pt-2">
      {recoveryBody}
      {actionBody}
    </div>
  );

  function renderHoldFooterBody() {
    const terminalLabel = terminalStatus ? HOLD_TERMINAL_LABELS[terminalStatus] : null;
    if (terminalLabel) return <span className="text-xs text-cafe-muted">{terminalLabel}</span>;
    if (state === 'done') return <span className="text-xs text-cafe-muted">已取消</span>;
    if ((recovery || pendingRecovery) && serverCancelable === false) return null;
    // A card of this hold stated a terminal. That fact needs no network, so it
    // holds even when the probe above never answered.
    if (cancelEntry === 'revoked')
      return recovery || pendingRecovery ? null : <span className="text-xs text-cafe-muted">已结束</span>;
    // Another card of the same hold owns its single cancel entry. This card still
    // reports status above; only the action is withheld, so one hold never shows
    // two live cancel entries.
    if (cancelEntry !== 'owner') return null;
    if (managedExecution) {
      return (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-cafe-secondary">托管命令运行中</span>
          <ExecutionCancelButton execution={managedExecution} label="取消命令" />
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCancel(false)}
          disabled={state === 'loading'}
          className="text-xs px-2 py-0.5 rounded bg-cafe-surface hover:bg-cafe-hover border border-cafe-border disabled:opacity-50 transition-colors"
        >
          {state === 'loading' ? '取消中…' : '取消持球'}
        </button>
        <button
          type="button"
          onClick={() => void handleCancel(true)}
          disabled={state === 'loading'}
          className="text-xs px-2 py-0.5 rounded bg-cafe-surface text-cafe-accent hover:bg-cafe-accent/10 border border-cafe-accent/40 disabled:opacity-50 transition-colors"
          title="取消持球并提交问题反馈"
        >
          取消并反馈
        </button>
      </div>
    );
  }
}
