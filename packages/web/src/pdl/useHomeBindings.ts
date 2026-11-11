'use client';
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  cancelHoldWait,
  cancelProjectedExecution,
  refreshActiveExecutionProjection,
} from '@/hooks/useActiveExecutionProjection';
import { useDeploymentWaitProjection } from '@/hooks/useDeploymentWaitProjection';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

interface JobRead {
  taskId: string;
  catId: string;
  access: { lifecycleVisibility: string };
  cancelable: boolean;
  job?: {
    originTaskId: string;
    createdAt: number;
    state: string;
    command?: string;
    tail?: string;
    result?: { exitCode: number | null; durationMs: number };
    transitions: { revision: number; state: string; at: number }[];
  };
}
export function useHomeBindings(data: ChatData, ui: { execDetail: string | null }, needed: boolean | number = false) {
  const waits = useDeploymentWaitProjection(null, 'all', needed);
  const hydration = useActiveExecutionStore((s) => s.hydration);
  const unavailable = useActiveExecutionStore((s) => s.unavailableProjectPaths);
  const heldWaits = useActiveExecutionStore((s) => s.waits);
  const [selected, setSelected] = useState<ActiveExecutionProjection | null>(null);
  const [attempt, retry] = useState(0);
  const [detail, setDetail] = useState<{ id: string; load: string; read?: JobRead }>({ id: '', load: 'loading' });
  useEffect(() => {
    if (!needed || !selected) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const result = await request<JobRead>(
          `/api/callbacks/hold-ball/${encodeURIComponent(selected.executionId)}/status?tailBytes=16384`,
          { signal: abort.signal },
        );
        if (
          result.taskId !== selected.executionId ||
          result.catId !== selected.catId ||
          result.access.lifecycleVisibility !== 'full' ||
          result.job?.originTaskId !== selected.executionId ||
          result.job.createdAt !== selected.startedAt
        )
          throw new Error('执行详情身份已变化');
        if (!abort.signal.aborted) setDetail({ id: selected.executionId, load: '', read: result });
        return result.job?.state;
      } catch {
        if (!abort.signal.aborted) setDetail({ id: selected.executionId, load: 'error' });
      }
    };
    setDetail((current) =>
      current.id === selected.executionId ? current : { id: selected.executionId, load: 'loading' },
    );
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const state = await read();
      if (!abort.signal.aborted && state && state !== 'terminal') timer = setTimeout(poll, 2000);
    };
    void poll();
    document.addEventListener('visibilitychange', poll);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [needed, selected, attempt]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'cancelHoldWait') {
      return cancelHoldWait(heldWaits.find((wait) => wait.waitId === args.waitId)!);
    }
    if (name === 'opForceReset') {
      await write(`/api/threads/${encodeURIComponent(args.threadId)}/force-reset`, {});
      ui.execDetail = null;
      setSelected(null);
      await refreshActiveExecutionProjection(data.threadId, useActiveExecutionStore.getState().projectPath);
      return true;
    }
    if (name === 'refresh' && ['home', 'live'].includes(args.k)) {
      await Promise.all([
        refreshActiveExecutionProjection(data.threadId, useActiveExecutionStore.getState().projectPath),
        waits.retry(),
      ]);
      if (selected) retry((n) => n + 1);
      return true;
    }
    if (name === 'homeExecOpen') {
      const execution = data.executions.find((e) => e.executionId === args.k && e.kind === 'managed_command');
      if (!execution) throw new Error('执行已变化，请重新读取');
      ui.execDetail = execution.executionId;
      setSelected(execution);
      return true;
    }
    if (name === 'homeExecClose') {
      setSelected(null);
      return true;
    }
    if (name === 'opLiveStop') {
      const execution = data.executions.find((e) => e.executionId === args.k);
      if (!execution) throw new Error('执行已变化，请重新读取');
      await cancelProjectedExecution(execution);
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({
      waits: {
        projection: waits.projection,
        error: waits.error,
        hydration: waits.projection ? 'ready' : waits.hydration,
      },
      hydration,
      heldWaits,
      unavailable,
      selected,
      detail,
    }),
    [waits.projection, waits.error, waits.hydration, hydration, heldWaits, unavailable, selected, detail],
  );
  return {
    action,
    data: rawData,
  };
}
