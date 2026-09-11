'use client';

import type { ActiveExecutionListResponse, FreshnessCarrierCapability } from '@cat-cafe/shared';
import { type QueueReminderAttemptState, SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { composerInsertFromRecall, requestTrueRecall, TrueRecallRequestError } from '@/utils/true-recall';
import { SortableQueueEntryRow } from './QueueEntryRow';
import { SteerQueuedEntryModal } from './SteerQueuedEntryModal';
import {
  parseSteerSourceRecordId,
  parseSteerSourceTargetStates,
  parseSteerThreadCatProjection,
  type SteerSourceTargetState,
  type SteerThreadCatProjection,
} from './steer-target-selection';
import { useQueueActionConvergence } from './useQueueActionConvergence';

const COLLAPSE_THRESHOLD = 4;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, normal: 1 };

const REMINDER_RESULT_COPY: Record<
  QueueReminderAttemptState,
  { type: 'success' | 'info'; title: string; message: string }
> = {
  requested: {
    type: 'success',
    title: '提醒已请求',
    message: '不会打断当前工作；猫会在安全断点收到提示。',
  },
  delivered: { type: 'info', title: '提醒已送达', message: '猫已收到提示，尚未读取消息正文。' },
  seen: { type: 'info', title: '提醒后已读取', message: '猫已在该轮完整读取这条消息。' },
  missed: { type: 'info', title: '提醒未赶上本轮', message: '该轮已结束；回执保留本次未送达结果。' },
};

function reminderResultCopy(state: unknown) {
  return typeof state === 'string' && state in REMINDER_RESULT_COPY
    ? REMINDER_RESULT_COPY[state as QueueReminderAttemptState]
    : REMINDER_RESULT_COPY.requested;
}

function queueClearFailureCopy(data: { code?: unknown; error?: unknown }) {
  const partial = data.code === 'QUEUE_WITHDRAWAL_PARTIAL';
  return {
    title: partial ? '已停止部分消息' : '停止失败',
    message: typeof data.error === 'string' ? `执行已停止；${data.error}` : '执行已停止，但待处理队列未能清空，请重试',
  };
}

export function compareQueueEntries(
  a: { position?: number; priority?: string; createdAt: number },
  b: { position?: number; priority?: string; createdAt: number },
): number {
  const aHasPos = a.position !== undefined;
  const bHasPos = b.position !== undefined;
  if (aHasPos && !bHasPos) return -1;
  if (!aHasPos && bHasPos) return 1;
  if (aHasPos && bHasPos) return a.position! - b.position!;
  const pDiff = (PRIORITY_RANK[a.priority ?? 'normal'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 1);
  if (pDiff !== 0) return pDiff;
  return a.createdAt - b.createdAt;
}

/** Format an elapsed duration (ms) as a compact label: `45s` / `12m` / `1h03m`. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  return `${h}h${String(totalMin % 60).padStart(2, '0')}m`;
}

export type QueueWaitInfo =
  | { kind: 'active_turn'; catId: string; elapsedLabel: string | null }
  | { kind: 'target_dispatch'; catIds: string[] };

/**
 * Derive queue wait truth from both the queued work's explicit targets and live invocation slots.
 *
 * Explicit targets are authoritative: if none of those cats is active, the work is waiting for
 * target dispatch. An unrelated active cat must never be borrowed as the queue's blocker. Only
 * broadcast work (no explicit targets) may describe the oldest thread-level active turn.
 *
 * Pure: `now` injected for testing.
 */
export function computeQueueWaitInfo(
  activeInvocations: Record<string, { catId: string; mode?: string; startedAt?: number }> | undefined,
  queuedTargetCatIds: Iterable<string> = [],
  now: number = Date.now(),
): QueueWaitInfo | null {
  const slots = Object.values(activeInvocations ?? {});
  const targetCatIds = [...new Set(queuedTargetCatIds)];
  const targets = new Set(targetCatIds);
  const targeted = targetCatIds.length > 0 ? slots.filter((slot) => targets.has(slot.catId)) : [];

  if (targetCatIds.length > 0 && targeted.length === 0) {
    return { kind: 'target_dispatch', catIds: targetCatIds };
  }

  const candidates = targeted.length > 0 ? targeted : slots;
  if (candidates.length === 0) return null;
  let oldest = candidates[0];
  for (const s of candidates) {
    if ((s.startedAt ?? Number.POSITIVE_INFINITY) < (oldest.startedAt ?? Number.POSITIVE_INFINITY)) oldest = s;
  }
  return {
    kind: 'active_turn',
    catId: oldest.catId,
    elapsedLabel: oldest.startedAt ? formatElapsed(Math.max(0, now - oldest.startedAt)) : null,
  };
}

interface QueuePanelProps {
  threadId: string;
}

export function QueuePanel({ threadId }: QueuePanelProps) {
  const coCreator = useCoCreatorConfig();
  const { cats } = useCatData();
  const resolveCatName = useCatNameResolver();
  const rawQueue = useChatStore((s) => s.queue);
  const queue = useMemo(() => rawQueue ?? [], [rawQueue]);
  const setQueue = useChatStore((s) => s.setQueue);
  const { activeInvocations, catInvocations } = useThreadLiveness(threadId);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const addToast = useToastStore((s) => s.addToast);

  const { steerEntryId, handleSteerConfirm, handleSteerOpen, handleSteerCancel } = useQueueActionConvergence(threadId);
  const [remindingTargetKeys, setRemindingTargetKeys] = useState<Set<string>>(() => new Set());
  const [appendingEntryIds, setAppendingEntryIds] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [steerContext, setSteerContext] = useState<
    SteerThreadCatProjection & {
      threadId: string | null;
      entryId: string | null;
      sourceTargets: SteerSourceTargetState[];
      sourceRecordId: string | null;
      state: 'loading' | 'ready' | 'unavailable';
    }
  >({
    threadId: null,
    entryId: null,
    participantActivity: [],
    fallbackTargetCatId: null,
    sourceTargets: [],
    sourceRecordId: null,
    state: 'loading',
  });

  useEffect(() => {
    if (!steerEntryId) {
      setSteerContext({
        threadId: null,
        entryId: null,
        participantActivity: [],
        fallbackTargetCatId: null,
        sourceTargets: [],
        sourceRecordId: null,
        state: 'loading',
      });
      return;
    }
    let current = true;
    setSteerContext({
      threadId,
      entryId: steerEntryId,
      participantActivity: [],
      fallbackTargetCatId: null,
      sourceTargets: [],
      sourceRecordId: null,
      state: 'loading',
    });
    void Promise.all([
      apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cats`),
      apiFetch(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(steerEntryId)}/targets`),
    ])
      .then(async ([catsResponse, targetsResponse]) => {
        if (!catsResponse.ok || !targetsResponse.ok) throw new Error('Steer context unavailable');
        return Promise.all([catsResponse.json(), targetsResponse.json()]);
      })
      .then(([catsBody, targetsBody]) => {
        if (!current) return;
        setSteerContext({
          threadId,
          entryId: steerEntryId,
          ...parseSteerThreadCatProjection(catsBody),
          sourceTargets: parseSteerSourceTargetStates(targetsBody),
          sourceRecordId: parseSteerSourceRecordId(targetsBody),
          state: 'ready',
        });
      })
      .catch(() => {
        if (current) {
          setSteerContext({
            threadId,
            entryId: steerEntryId,
            participantActivity: [],
            fallbackTargetCatId: null,
            sourceTargets: [],
            sourceRecordId: null,
            state: 'unavailable',
          });
        }
      });
    return () => {
      current = false;
    };
  }, [steerEntryId, threadId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const visibleEntries = useMemo(
    () =>
      queue
        .filter(
          (e) =>
            e.status === 'queued' &&
            !(e.sourceCategory === 'scheduled' && e.content.startsWith(SCHEDULER_TRIGGER_PREFIX)),
        )
        .sort(compareQueueEntries),
    [queue],
  );

  // A2A queue visibility: explain WHY entries are queued (waiting behind the active turn) so the
  // user can tell "waiting for the current turn" apart from "stuck". Passes the visible queued
  // entries' target cats so the wait reason attributes the RIGHT cat (per-cat slot), not just the
  // oldest active turn. Recomputed when activeInvocations/visibleEntries change; elapsed reflects
  // the last store update (acceptable for v1 — no per-second tick).
  const waitInfo = useMemo(() => {
    const dispatchTargetCatIds = visibleEntries.flatMap((entry) => entry.targetCats);
    const hasBroadcastEntry = visibleEntries.some((entry) => entry.targetCats.length === 0);
    if (dispatchTargetCatIds.length === 0 && !hasBroadcastEntry) return null;
    return computeQueueWaitInfo(activeInvocations, dispatchTargetCatIds);
  }, [activeInvocations, visibleEntries]);
  const activeInvocationIdByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(activeInvocations ?? {}).map(([invocationId, invocation]) => [invocation.catId, invocationId]),
      ),
    [activeInvocations],
  );
  const activeCarrierCapabilityByCatId = useMemo(
    () =>
      Object.fromEntries(
        Object.values(activeInvocations).map((invocation) => [
          invocation.catId,
          catInvocations[invocation.catId]?.freshnessCarrierCapability,
        ]),
      ) as Readonly<Record<string, FreshnessCarrierCapability | undefined>>,
    [activeInvocations, catInvocations],
  );

  const handleRemove = useCallback(
    async (entryId: string) => {
      const prevQueue = queue;
      setQueue(
        threadId,
        prevQueue.filter((e) => e.id !== entryId),
      );
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entryId}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setQueue(threadId, prevQueue);
          addToast({
            type: 'error',
            title: '停止失败',
            message: data?.error ?? '停止后续处理失败，请重试',
            threadId,
            duration: 5000,
          });
          return;
        }
        addToast({
          type: 'success',
          title: '已停止后续处理',
          message: '原消息与已经发生的读取事实仍保留在历史中',
          threadId,
          duration: 3000,
        });
      } catch {
        setQueue(threadId, prevQueue);
        addToast({
          type: 'error',
          title: '停止失败',
          message: '停止后续处理失败，请重试',
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, setQueue, threadId],
  );

  const handleRecallEdit = useCallback(
    async (entryId: string) => {
      const entry = queue.find((e) => e.id === entryId);
      if (!entry) return;
      if (!entry.messageId) {
        addToast({
          type: 'error',
          title: '无法撤回这条消息',
          message: '缺少原消息身份；可以改用“停止后续处理”。',
          threadId,
          duration: 5000,
        });
        return;
      }

      try {
        const result = await requestTrueRecall({
          threadId,
          messageId: entry.messageId,
          confirmAppend: () => window.confirm('输入框已有草稿。撤回正文会空一行追加到当前草稿末尾，是否继续？'),
        });
        if (!result) return;
        setQueue(threadId, result.queue);
        const insert = composerInsertFromRecall(result);
        if (insert) setPendingChatInsert(insert);
        addToast({
          type: result.verdict === 'exposed' ? 'info' : 'success',
          title: result.verdict === 'exposed' ? '正文已撤回 · 猫曾读取' : '已撤回并回填输入框',
          message:
            result.verdict === 'exposed'
              ? '未读猫已停止后续处理；已读回合不会被普通撤回中断。'
              : '正文已从消息历史转移到持久草稿，可修改后重新发送。',
          threadId,
          duration: 4000,
        });
      } catch (error) {
        const conflict = error instanceof TrueRecallRequestError && error.code === 'DRAFT_REVISION_MISMATCH';
        addToast({
          type: 'error',
          title: conflict ? '草稿已在别处更新' : '撤回并重新编辑失败',
          message: conflict ? '原消息和两份草稿都没有改变；刷新输入框后再试。' : (error as Error).message,
          threadId,
          duration: 5000,
        });
      }
    },
    [addToast, queue, setPendingChatInsert, setQueue, threadId],
  );

  const handleClear = useCallback(async () => {
    try {
      const activeResponse = await apiFetch(`/api/threads/${threadId}/executions/active`);
      if (!activeResponse.ok) throw new Error('active execution projection unavailable');
      const active = (await activeResponse.json()) as ActiveExecutionListResponse;
      const stopTargets = active.executions.filter(
        (execution) =>
          execution.threadId === threadId &&
          execution.kind === 'live_invocation' &&
          execution.cancelability.state === 'cancelable',
      );
      for (const execution of stopTargets) {
        const target = execution.cancelability.state === 'cancelable' ? execution.cancelability.target : undefined;
        if (!target || target.kind !== 'live_invocation') continue;
        const stopped = await apiFetch(
          `/api/threads/${threadId}/executions/live/${encodeURIComponent(target.executionId)}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ catId: target.catId }),
          },
        );
        if (!stopped.ok) throw new Error('active execution stop failed');
      }
      const res = await apiFetch(`/api/threads/${threadId}/queue`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data?.queue)) setQueue(threadId, data.queue);
        const failure = queueClearFailureCopy(data);
        addToast({
          type: 'error',
          title: failure.title,
          message: failure.message,
          threadId,
          duration: 5000,
        });
        return;
      }
      setQueue(threadId, []);
      addToast({
        type: 'success',
        title: '已全部停止',
        message: '运行中的执行已停止，待处理队列已清空；原消息与读取事实仍保留',
        threadId,
        duration: 3000,
      });
    } catch {
      addToast({
        type: 'error',
        title: '停止失败',
        message: '停止后续处理失败，请重试',
        threadId,
        duration: 5000,
      });
    }
  }, [addToast, setQueue, threadId]);

  const handleAppend = useCallback(
    async (entry: (typeof queue)[number]) => {
      const action = entry.lifecycleActions?.append;
      if (!action) return;
      setAppendingEntryIds((current) => new Set(current).add(entry.id));
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entry.id}/append`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedQueueRevision: action.expectedQueueRevision,
            expectedRuns: action.expectedRuns,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          addToast({
            type: 'error',
            title:
              data?.code === 'STATE_CHANGED' || data?.code === 'APPEND_UNAVAILABLE'
                ? 'Append 状态已变化'
                : 'Append 失败',
            message: data?.error ?? '消息没有追加到当前回合，请刷新后重试。',
            threadId,
            duration: 5000,
          });
          return;
        }
        const current = useChatStore.getState();
        const currentQueue =
          current.currentThreadId === threadId ? current.queue : current.threadStates[threadId]?.queue;
        setQueue(
          threadId,
          (currentQueue ?? []).filter((candidate) => candidate.id !== entry.id),
        );
        addToast({
          type: 'success',
          title: '已追加到当前回合',
          message: '没有启动新回合；消息已关联到现有回复。',
          threadId,
          duration: 3000,
        });
      } catch {
        addToast({
          type: 'error',
          title: 'Append 失败',
          message: '消息没有追加到当前回合，请刷新后重试。',
          threadId,
          duration: 5000,
        });
      } finally {
        setAppendingEntryIds((current) => {
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [addToast, setQueue, threadId],
  );
  const handleRemind = useCallback(
    async (entryId: string, targetCatId: string) => {
      const key = `${entryId}:${targetCatId}`;
      setRemindingTargetKeys((current) => new Set(current).add(key));
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/remind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetCatId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message =
            data?.code === 'NO_ACTIVE_INVOCATION'
              ? '这只猫当前没有可接收提醒的工作轮次。'
              : (data?.error ?? '提醒请求没有完成，请重试。');
          addToast({ type: 'error', title: '提醒未送达', message, threadId, duration: 5000 });
          return;
        }
        addToast({ ...reminderResultCopy(data?.state), threadId, duration: 3000 });
      } catch {
        addToast({
          type: 'error',
          title: '提醒未送达',
          message: '提醒请求没有完成，请重试。',
          threadId,
          duration: 5000,
        });
      } finally {
        setRemindingTargetKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [addToast, threadId],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = visibleEntries.findIndex((e) => e.id === active.id);
      const newIndex = visibleEntries.findIndex((e) => e.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(visibleEntries, oldIndex, newIndex);
      const positions = reordered.map((e, i) => ({ entryId: e.id, position: i }));

      const prevQueue = queue;
      setQueue(
        threadId,
        queue.map((e) => {
          const pos = positions.find((p) => p.entryId === e.id);
          return pos ? { ...e, position: pos.position } : e;
        }),
      );

      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue/reorder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions }),
        });
        if (!res.ok) {
          setQueue(threadId, prevQueue);
          addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
        }
      } catch {
        setQueue(threadId, prevQueue);
        addToast({ type: 'error', title: '排序失败', message: '排序失败，请重试', threadId, duration: 5000 });
      }
    },
    [addToast, queue, setQueue, threadId, visibleEntries],
  );

  if (queue.length === 0) return null;
  if (visibleEntries.length === 0) return null;

  const isCollapsed = collapsed ?? visibleEntries.length >= COLLAPSE_THRESHOLD;
  const entryIds = visibleEntries.map((e) => e.id);

  const selectedSteerEntry = steerEntryId ? (queue.find((e) => e.id === steerEntryId) ?? null) : null;
  const selectedSteerTargets = (() => {
    if (!selectedSteerEntry) return [];
    const currentContext =
      steerContext.threadId === threadId &&
      steerContext.entryId === selectedSteerEntry.id &&
      steerContext.state === 'ready'
        ? steerContext
        : null;
    if (!currentContext) return [];
    const catById = new Map(cats.map((cat) => [cat.id, cat]));
    const siblingEntries = queue.filter(
      (candidate) =>
        candidate.status === 'queued' &&
        selectedSteerEntry.messageId &&
        candidate.messageId === selectedSteerEntry.messageId,
    );
    const rowByTarget = new Map(
      siblingEntries.flatMap((entry) => entry.targetCats.map((targetCatId) => [targetCatId, entry] as const)),
    );
    const participantActivity = currentContext.participantActivity;
    const participantIds = new Set(participantActivity.map((participant) => participant.catId));
    const candidateIds = new Set<string>();
    for (const participant of participantActivity) candidateIds.add(participant.catId);
    for (const target of currentContext.sourceTargets) candidateIds.add(target.targetCatId);
    for (const targetId of Object.keys(selectedSteerEntry.authorIntentByTarget ?? {})) candidateIds.add(targetId);
    for (const targetCatId of selectedSteerEntry.targetCats) candidateIds.add(targetCatId);
    const fallbackId = currentContext.fallbackTargetCatId ?? undefined;
    if (fallbackId) candidateIds.add(fallbackId);
    const pendingTargetIds = new Set(siblingEntries.flatMap((entry) => entry.targetCats));
    if (selectedSteerEntry.targetCats.length === 0 && fallbackId) pendingTargetIds.add(fallbackId);
    return [...candidateIds].flatMap((targetId) => {
      const cat = catById.get(targetId);
      if (!cat) return [];
      const sourceTarget = currentContext.sourceTargets.find((target) => target.targetCatId === targetId);
      const delivered = sourceTarget ? sourceTarget.state !== 'pending' : false;
      const row = rowByTarget.get(targetId);
      const hasCurrentReply = Boolean(
        activeInvocationIdByCatId[targetId] &&
          (!row || row.lifecycleActions?.append?.expectedRuns.some((run) => run.targetId === targetId)),
      );
      return [
        {
          id: targetId,
          label: resolveCatName(targetId),
          ...(cat.avatar ? { avatar: cat.avatar } : {}),
          canGuideReply: cat.messageDeliveryCapabilities?.guideReply === true,
          hasCurrentReply,
          defaultSelected: pendingTargetIds.has(targetId) && !delivered,
          pending: sourceTarget?.state === 'pending' && sourceTarget.actionable,
          delivered,
          unavailable: cat.roster?.available === false,
          disposition: row?.authorIntentByTarget?.[targetId]?.requested ?? 'next_work',
          membershipAtOpen: participantIds.has(targetId) ? ('member' as const) : ('admit' as const),
        },
      ];
    });
  })();

  return (
    <div
      className="border-t mx-4 mb-1 rounded-xl overflow-hidden"
      style={{
        borderColor: 'color-mix(in oklch, var(--color-cocreator-primary) 20%, transparent)',
        backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 5%, transparent)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 10%, transparent)' }}
      >
        <div className="flex items-center gap-2">
          <svg aria-hidden="true" className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
          </svg>
          <span className="text-xs font-medium text-cafe-secondary">待处理</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded-full font-medium text-[var(--color-cocreator-primary)]"
            style={{ backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 20%, transparent)' }}
          >
            {visibleEntries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(!isCollapsed)}
            className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors"
          >
            {isCollapsed ? '展开' : '收起'}
          </button>
          <button
            type="button"
            onClick={handleClear}
            title="全部停止后续处理（保留原消息）"
            className="text-xs text-cafe-muted hover:text-conn-red-text transition-colors"
          >
            全部停止
          </button>
        </div>
      </div>

      {waitInfo?.kind === 'target_dispatch' && visibleEntries.length > 0 && (
        <div
          className="px-3 py-1.5 text-xs text-cafe-muted border-b"
          style={{ borderColor: 'color-mix(in oklch, var(--color-cocreator-primary) 10%, transparent)' }}
        >
          等待{' '}
          <span className="font-medium text-cafe-secondary">
            {waitInfo.catIds.map((catId) => resolveCatName(catId)).join('、')}
          </span>{' '}
          调度
        </div>
      )}

      {!isCollapsed && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
            <div className="max-h-40 overflow-y-auto flex flex-col gap-0.5 p-1">
              {visibleEntries.map((entry, idx) => {
                // #706: Compute image count from server-enriched messagePreview
                const imageCount = entry.messagePreview?.contentBlocks?.filter((b) => b.type === 'image').length ?? 0;
                return (
                  <SortableQueueEntryRow
                    key={entry.id}
                    entry={entry}
                    index={idx}
                    imageCount={imageCount}
                    ownerName={coCreator.name}
                    resolveCatName={resolveCatName}
                    onRemove={handleRemove}
                    onRecallEdit={handleRecallEdit}
                    onSteer={handleSteerOpen}
                    onAppend={handleAppend}
                    onRemind={handleRemind}
                    activeInvocationIdByCatId={activeInvocationIdByCatId}
                    activeCarrierCapabilityByCatId={activeCarrierCapabilityByCatId}
                    remindingTargetKeys={remindingTargetKeys}
                    appendingEntryIds={appendingEntryIds}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {selectedSteerEntry && selectedSteerEntry.status === 'queued' && (
        <SteerQueuedEntryModal
          sourceRecordId={steerContext.sourceRecordId ?? selectedSteerEntry.messageId ?? ''}
          targets={selectedSteerTargets}
          contextState={
            steerContext.threadId === threadId && steerContext.entryId === selectedSteerEntry.id
              ? steerContext.state
              : 'loading'
          }
          onCancel={handleSteerCancel}
          onConfirm={handleSteerConfirm}
        />
      )}
    </div>
  );
}
