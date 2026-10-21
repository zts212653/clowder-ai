'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';

interface Receipt {
  userId: string;
  version: string;
  status: 'not_started' | 'dismissed' | 'completed';
  autoEligible?: boolean;
}
/** Playback remains local; admission/completion belongs to authenticated server preferences. */
export function useDemoAdmission(enabled: boolean, onOpen: () => void, autoEligible = true) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const pending = useRef<'dismissed' | 'completed' | null>(null);
  const writing = useRef(false);
  const revision = useRef(0);
  const completed = useRef(false);
  const autoOpened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: readAttempt explicitly retries the failed read.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const requestedRevision = revision.current;
    void apiFetch('/api/config/onboarding', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('引导记录暂时无法读取，仍可主动查看演示。');
        const value = (await response.json()) as Receipt;
        if (controller.signal.aborted || requestedRevision !== revision.current) return;
        setReceipt(value);
        completed.current = value.status === 'completed';
        if (completed.current) pending.current = null;
        if (!pending.current) setError('');
        if (autoEligible && value.autoEligible === true && value.status === 'not_started' && !autoOpened.current) {
          autoOpened.current = true;
          onOpen();
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && requestedRevision === revision.current && !pending.current)
          setError(cause instanceof Error ? cause.message : '引导记录读取失败');
      });
    return () => controller.abort();
  }, [enabled, onOpen, autoEligible, readAttempt]);
  const flush = useCallback(async () => {
    if (writing.current) return;
    writing.current = true;
    try {
      while (pending.current) {
        const intent = pending.current;
        const response = await apiFetch('/api/config/onboarding', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: intent }),
        });
        if (!response.ok) throw Error('引导记录未保存，刷新后可能重新展示。');
        const value = (await response.json()) as Receipt;
        setReceipt(value);
        completed.current = value.status === 'completed';
        setError('');
        if (completed.current || pending.current === intent) pending.current = null;
      }
    } catch (cause) {
      if (!completed.current) setError(cause instanceof Error ? cause.message : '引导记录保存失败');
    } finally {
      writing.current = false;
    }
  }, []);
  const save = useCallback(
    (status: 'dismissed' | 'completed') => {
      autoOpened.current = true;
      revision.current += 1;
      if (completed.current) return;
      if (pending.current !== 'completed') pending.current = status;
      void flush();
    },
    [flush],
  );
  return {
    storageScope: `${API_URL}:${receipt?.userId ?? 'manual'}:${receipt?.version ?? 'collaboration-v1'}`,
    error,
    dismiss: () => void save('dismissed'),
    complete: () => void save('completed'),
    retry: () => (pending.current ? void save(pending.current) : setReadAttempt((attempt) => attempt + 1)),
  };
}
