import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { GlobalControlState, RunLedgerRow, ScheduleTask } from './schedule-helpers';

const REFRESH_MS = 30_000;

export function useSchedulePanelData(threadFilter: string | null | undefined, enabled = true) {
  // undefined is All; null is an unresolved Current Thread, never All.
  const resource =
    threadFilter === null
      ? null
      : `/api/schedule/tasks${threadFilter === undefined ? '' : `?threadId=${encodeURIComponent(threadFilter)}`}`;
  const currentResource = useRef(resource);
  const enabledRef = useRef(enabled);
  const mounted = useRef(false);
  const tasksRequest = useRef(0);
  const controlRequest = useRef(0);
  const historyRequest = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    resource: string | null;
    tasks: ScheduleTask[];
    error: string | null;
  }>({ resource: null, tasks: [], error: null });
  const [globalControl, setGlobalControl] = useState<GlobalControlState | null>(null);
  const [history, setHistory] = useState<{
    resource: string;
    taskId: string;
    runs: RunLedgerRow[];
  } | null>(null);

  useLayoutEffect(() => {
    currentResource.current = resource;
    ++tasksRequest.current;
    ++historyRequest.current;
  }, [resource]);

  useLayoutEffect(() => {
    enabledRef.current = enabled;
    if (enabled) return;
    ++tasksRequest.current;
    ++controlRequest.current;
    ++historyRequest.current;
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const canRead = useCallback(() => mounted.current && enabledRef.current, []);
  const getReadableResource = useCallback(() => (canRead() ? currentResource.current : null), [canRead]);

  const fetchTasks = useCallback(
    async (afterCurrentGet = false) => {
      const path = getReadableResource();
      if (path === null) return;
      const request = ++tasksRequest.current;
      const isCurrent = () => canRead() && request === tasksRequest.current && path === currentResource.current;
      try {
        const res = await (afterCurrentGet ? apiFetch(path, undefined, { afterCurrentGet: true }) : apiFetch(path));
        if (!res.ok) throw new Error('Schedule request failed');
        const data = (await res.json()) as { tasks?: ScheduleTask[] };
        if (isCurrent()) setSnapshot({ resource: path, tasks: data.tasks ?? [], error: null });
      } catch {
        if (isCurrent())
          setSnapshot((previous) => ({
            resource: path,
            tasks: previous.resource === path ? previous.tasks : [],
            error: '同步调度任务失败，请稍后重试。',
          }));
      }
    },
    [canRead, getReadableResource],
  );

  const fetchControl = useCallback(
    async (afterCurrentGet = false) => {
      if (!canRead()) return;
      const request = ++controlRequest.current;
      try {
        const res = await (afterCurrentGet
          ? apiFetch('/api/schedule/control', undefined, { afterCurrentGet: true })
          : apiFetch('/api/schedule/control'));
        if (!res.ok) return;
        const data = (await res.json()) as { global?: GlobalControlState | null };
        if (canRead() && request === controlRequest.current) setGlobalControl(data.global ?? null);
      } catch {
        // Retain the last known control state until the next owner response.
      }
    },
    [canRead],
  );

  useEffect(() => {
    if (!enabled) return;
    if (resource === null) return;
    void fetchTasks();
    const timer = setInterval(() => void fetchTasks(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [resource, enabled, fetchTasks]);

  useEffect(() => {
    if (!enabled) return;
    void fetchControl();
    const timer = setInterval(() => void fetchControl(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, fetchControl]);

  const expandedId = history?.resource === resource ? history.taskId : null;
  const handleToggleExpand = useCallback(
    async (taskId: string) => {
      const path = getReadableResource();
      if (path === null) return;
      const request = ++historyRequest.current;
      if (expandedId === taskId) {
        setHistory(null);
        return;
      }
      setHistory({ resource: path, taskId, runs: [] });
      const query = path.includes('?') ? `&${path.split('?')[1]}` : '';
      try {
        const res = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}/runs?limit=5${query}`);
        if (!res.ok) return;
        const data = (await res.json()) as { runs?: RunLedgerRow[] };
        if (canRead() && request === historyRequest.current && path === currentResource.current) {
          setHistory({ resource: path, taskId, runs: data.runs ?? [] });
        }
      } catch {
        // The selected task stays expanded; an old task's reply cannot fill it.
      }
    },
    [canRead, expandedId, getReadableResource],
  );

  const handleGlobalToggle = useCallback(async () => {
    if (!globalControl) return;
    const enabled = !globalControl.enabled;
    const res = await apiFetch('/api/schedule/control', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, reason: enabled ? null : 'Paused from panel', updatedBy: 'user' }),
    }).catch(() => null);
    if (res) await fetchControl(true);
  }, [globalControl, fetchControl]);

  const handleToggleTask = useCallback(
    async (task: ScheduleTask) => {
      const enabled = !(task.effectiveEnabled ?? task.enabled);
      const dynamic = task.source === 'dynamic' && task.dynamicTaskId;
      const res = await apiFetch(
        dynamic
          ? `/api/schedule/tasks/${encodeURIComponent(dynamic)}`
          : `/api/schedule/control/tasks/${encodeURIComponent(task.id)}`,
        {
          method: dynamic ? 'PATCH' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dynamic ? { enabled } : { enabled, updatedBy: 'user' }),
        },
      ).catch(() => null);
      if (res) await Promise.all([fetchTasks(true), fetchControl(true)]);
    },
    [fetchTasks, fetchControl],
  );

  const handleDeleteDynamic = useCallback(
    async (taskId: string) => {
      const res = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).catch(
        () => null,
      );
      if (res?.ok) await fetchTasks(true);
    },
    [fetchTasks],
  );

  return {
    tasks: snapshot.resource === resource ? snapshot.tasks : [],
    loading: resource !== null && snapshot.resource !== resource,
    tasksError: resource === null ? '当前对话尚未确定。' : snapshot.resource === resource ? snapshot.error : null,
    globalControl,
    expandedId,
    runHistory: history?.resource === resource ? history.runs : [],
    handleGlobalToggle,
    handleToggleTask,
    handleDeleteDynamic,
    handleToggleExpand,
  };
}
