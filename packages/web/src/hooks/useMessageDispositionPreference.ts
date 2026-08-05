'use client';

import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferenceSource,
  MessageWorkDisposition,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const DEFAULT_SNAPSHOT: MessageDispositionPreferenceSnapshot = {
  productDefault: 'next_work',
  global: null,
  thread: null,
  effective: 'next_work',
  source: 'product',
  onboardingSeen: false,
};

export type MessageDispositionSelectionSource = MessageDispositionPreferenceSource | 'once';
export type MessageDispositionPreferenceScope = 'once' | 'thread' | 'global';

export interface MessageDispositionPreferenceController {
  snapshot: MessageDispositionPreferenceSnapshot;
  oneShot: MessageWorkDisposition | null;
  effective: MessageWorkDisposition;
  source: MessageDispositionSelectionSource;
  loading: boolean;
  error: string | null;
  setOneShot(disposition: MessageWorkDisposition): void;
  clearOneShot(): void;
  setPreference(scope: 'thread' | 'global', disposition: MessageWorkDisposition | null): Promise<boolean>;
  markOnboardingSeen(): Promise<boolean>;
}

async function readSnapshot(response: Response): Promise<MessageDispositionPreferenceSnapshot> {
  if (!response.ok) throw new Error(`偏好保存失败 (${response.status})`);
  return (await response.json()) as MessageDispositionPreferenceSnapshot;
}

export function useMessageDispositionPreference(
  threadId: string | undefined,
  enabled: boolean,
): MessageDispositionPreferenceController {
  const [snapshot, setSnapshot] = useState<MessageDispositionPreferenceSnapshot>(DEFAULT_SNAPSHOT);
  const [oneShot, setOneShotState] = useState<MessageWorkDisposition | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationSequence = useRef(0);

  useEffect(() => {
    operationSequence.current += 1;
    setOneShotState(null);
    setError(null);
  }, [threadId]);

  useEffect(() => {
    if (!enabled || !threadId) return;
    const sequence = ++operationSequence.current;
    setLoading(true);
    void apiFetch(`/api/config/message-disposition?threadId=${encodeURIComponent(threadId)}`)
      .then(readSnapshot)
      .then((next) => {
        if (operationSequence.current === sequence) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (operationSequence.current === sequence) {
          setError(cause instanceof Error ? cause.message : '偏好读取失败');
        }
      })
      .finally(() => {
        if (operationSequence.current === sequence) setLoading(false);
      });
  }, [enabled, threadId]);

  const setOneShot = useCallback((disposition: MessageWorkDisposition) => {
    setOneShotState(disposition);
    setError(null);
  }, []);

  const clearOneShot = useCallback(() => setOneShotState(null), []);

  const save = useCallback(async (body: object): Promise<boolean> => {
    const sequence = ++operationSequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/config/message-disposition', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const next = await readSnapshot(response);
      if (operationSequence.current === sequence) setSnapshot(next);
      return true;
    } catch (cause) {
      if (operationSequence.current === sequence) {
        setError(cause instanceof Error ? cause.message : '偏好保存失败');
      }
      return false;
    } finally {
      if (operationSequence.current === sequence) setLoading(false);
    }
  }, []);

  const setPreference = useCallback(
    (scope: 'thread' | 'global', disposition: MessageWorkDisposition | null) => {
      if (scope === 'thread') {
        if (!threadId) return Promise.resolve(false);
        return save({ scope, threadId, disposition });
      }
      return save({ scope, disposition });
    },
    [save, threadId],
  );

  const markOnboardingSeen = useCallback(() => {
    if (snapshot.onboardingSeen) return Promise.resolve(true);
    return save({ scope: 'onboarding', seen: true });
  }, [save, snapshot.onboardingSeen]);

  return useMemo(
    () => ({
      snapshot,
      oneShot,
      effective: oneShot ?? snapshot.effective,
      source: oneShot ? ('once' as const) : snapshot.source,
      loading,
      error,
      setOneShot,
      clearOneShot,
      setPreference,
      markOnboardingSeen,
    }),
    [snapshot, oneShot, loading, error, setOneShot, clearOneShot, setPreference, markOnboardingSeen],
  );
}
