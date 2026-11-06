'use client';
import type {
  WatcherCapability,
  WatcherConfig,
  WatcherThreadControl,
  WatcherThreadControlPatch,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface WatcherSnapshot {
  control: WatcherThreadControl;
  config: WatcherConfig;
  enabled: boolean;
  maySpeak: boolean;
  labelMuted: boolean;
  pausedUntil?: number;
  rolloutEnabled: boolean;
  reviewing: boolean;
  memberName: string;
  capability: WatcherCapability;
}
export function useWatcher(threadId: string) {
  const [state, setState] = useState<WatcherSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/watcher`, { signal });
        if (!response.ok) throw new Error('读取守望猫状态失败');
        const result: WatcherSnapshot = await response.json();
        if (currentThread.current === threadId && !signal?.aborted) {
          setState(result);
          setError(null);
        }
      } catch (failure) {
        if (!signal?.aborted && currentThread.current === threadId)
          setError(failure instanceof Error ? failure.message : '读取守望猫状态失败');
      }
    },
    [threadId],
  );
  useEffect(() => {
    setState(null);
    const abort = new AbortController();
    void load(abort.signal);
    const update = () => {
      if (!document.hidden) void load(abort.signal);
    };
    const timer = setInterval(update, 5000);
    window.addEventListener('watcher-settings-changed', update);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener('watcher-settings-changed', update);
    };
  }, [load]);
  const update = async (patch: WatcherThreadControlPatch) => {
    if (!state || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/watcher`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: state.control.revision, ...patch }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? '设置已改变，请刷新后重试' : '保存守望猫设置失败');
      const result: WatcherSnapshot = await response.json();
      if (currentThread.current === threadId) {
        setState(result);
        setError(null);
      }
      window.dispatchEvent(new Event('watcher-settings-changed'));
    } catch (failure) {
      if (currentThread.current === threadId) setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return { state, error, saving, update };
}
