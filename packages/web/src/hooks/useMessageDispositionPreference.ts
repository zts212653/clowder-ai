'use client';

import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferenceSource,
  MessageWorkDisposition,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

type PreferenceWrite =
  | { scope: 'global'; disposition: MessageWorkDisposition | null }
  | { scope: 'thread'; threadId: string; disposition: MessageWorkDisposition | null }
  | { scope: 'onboarding'; seen: true };

interface ScopedSnapshot {
  threadId: string | undefined;
  value: MessageDispositionPreferenceSnapshot;
}

interface ScopedOneShot {
  threadId: string | undefined;
  value: MessageWorkDisposition | null;
}

function applyGlobalPreference(
  snapshot: MessageDispositionPreferenceSnapshot,
  next: MessageDispositionPreferenceSnapshot,
): MessageDispositionPreferenceSnapshot {
  const global = next.global;
  const effective = snapshot.thread ?? global ?? next.productDefault;
  return {
    ...snapshot,
    productDefault: next.productDefault,
    global,
    effective,
    source: snapshot.thread ? 'thread' : global ? 'global' : 'product',
    onboardingSeen: next.onboardingSeen,
  };
}

function applySavedSnapshot(
  current: ScopedSnapshot,
  threadId: string | undefined,
  body: PreferenceWrite,
  next: MessageDispositionPreferenceSnapshot,
): ScopedSnapshot {
  if (current.threadId !== threadId) return current;
  if (body.scope === 'global') return { threadId, value: applyGlobalPreference(current.value, next) };
  if (body.scope === 'onboarding') {
    return { threadId, value: { ...current.value, onboardingSeen: next.onboardingSeen } };
  }
  return { threadId, value: next };
}

async function readSnapshot(response: Response): Promise<MessageDispositionPreferenceSnapshot> {
  if (!response.ok) throw new Error(`偏好保存失败 (${response.status})`);
  return (await response.json()) as MessageDispositionPreferenceSnapshot;
}

export function useMessageDispositionPreference(
  threadId: string | undefined,
  enabled: boolean,
): MessageDispositionPreferenceController {
  const [snapshotState, setSnapshotState] = useState<ScopedSnapshot>({
    threadId: undefined,
    value: DEFAULT_SNAPSHOT,
  });
  const [oneShotState, setOneShotState] = useState<ScopedOneShot>({
    threadId: undefined,
    value: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationSequence = useRef(0);
  const snapshot = snapshotState.threadId === threadId ? snapshotState.value : DEFAULT_SNAPSHOT;
  const oneShot = oneShotState.threadId === threadId ? oneShotState.value : null;

  useLayoutEffect(() => {
    operationSequence.current += 1;
    setSnapshotState({ threadId, value: DEFAULT_SNAPSHOT });
    setOneShotState({ threadId, value: null });
    setLoading(false);
    setError(null);
  }, [threadId]);

  useEffect(() => {
    if (!enabled || !threadId) return;
    const sequence = ++operationSequence.current;
    setLoading(true);
    void apiFetch(`/api/config/message-disposition?threadId=${encodeURIComponent(threadId)}`)
      .then(readSnapshot)
      .then((next) => {
        if (operationSequence.current === sequence) setSnapshotState({ threadId, value: next });
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

  const setOneShot = useCallback(
    (disposition: MessageWorkDisposition) => {
      setOneShotState({ threadId, value: disposition });
      setError(null);
    },
    [threadId],
  );

  const clearOneShot = useCallback(() => {
    setOneShotState((current) => (current.threadId === threadId ? { ...current, value: null } : current));
  }, [threadId]);

  const save = useCallback(
    async (body: PreferenceWrite): Promise<boolean> => {
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
        if (operationSequence.current === sequence) {
          setSnapshotState((current) => applySavedSnapshot(current, threadId, body, next));
        }
        return true;
      } catch (cause) {
        if (operationSequence.current === sequence) {
          setError(cause instanceof Error ? cause.message : '偏好保存失败');
        }
        return false;
      } finally {
        if (operationSequence.current === sequence) setLoading(false);
      }
    },
    [threadId],
  );

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
