'use client';

import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferenceSource,
  MessageWorkDisposition,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { messageDispositionCopy } from '@/components/message-disposition.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';

const DEFAULT_SNAPSHOT: MessageDispositionPreferenceSnapshot = {
  productDefault: 'next_work',
  global: null,
  thread: null,
  effective: 'next_work',
  source: 'product',
};

export type MessageDispositionSelectionSource = MessageDispositionPreferenceSource | 'once';
export type MessageDispositionPreferenceScope = 'thread' | 'global';

export interface MessageDispositionPreferenceController {
  snapshot: MessageDispositionPreferenceSnapshot;
  effective: MessageWorkDisposition;
  source: MessageDispositionSelectionSource;
  loading: boolean;
  error: string | null;
  oneShot: MessageWorkDisposition | null;
  setOneShot(disposition: MessageWorkDisposition): void;
  clearOneShot(): void;
  setPreference(scope: 'thread' | 'global', disposition: MessageWorkDisposition | null): Promise<boolean>;
}

type PreferenceWrite =
  | { scope: 'global'; disposition: MessageWorkDisposition | null }
  | { scope: 'thread'; threadId: string; disposition: MessageWorkDisposition | null };

interface ScopedSnapshot {
  threadId: string | undefined;
  value: MessageDispositionPreferenceSnapshot;
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
  return { threadId, value: next };
}

class PreferenceHttpError extends Error {
  constructor(readonly status: number) {
    super(`Send mode preference HTTP ${status}`);
  }
}

async function readSnapshot(response: Response): Promise<MessageDispositionPreferenceSnapshot> {
  if (!response.ok) throw new PreferenceHttpError(response.status);
  return (await response.json()) as MessageDispositionPreferenceSnapshot;
}

export function useMessageDispositionPreference(
  threadId: string | undefined,
  enabled: boolean,
): MessageDispositionPreferenceController {
  const localized = useShellCopy(messageDispositionCopy);
  const t = (useShellPresentation() === 'v2' ? localized : messageDispositionCopy.zh).composer;
  const [snapshotState, setSnapshotState] = useState<ScopedSnapshot>({
    threadId: undefined,
    value: DEFAULT_SNAPSHOT,
  });
  const [loading, setLoading] = useState(false);
  const [oneShotState, setOneShotState] = useState<{
    threadId: string | undefined;
    value: MessageWorkDisposition | null;
  }>({ threadId, value: null });
  const oneShot = oneShotState.threadId === threadId ? oneShotState.value : null;
  const setOneShot = useCallback((value: MessageWorkDisposition) => setOneShotState({ threadId, value }), [threadId]);
  const clearOneShot = useCallback(
    () => setOneShotState((current) => (current === oneShotState ? { threadId, value: null } : current)),
    [threadId, oneShotState],
  );
  const [failure, setError] = useState<{ cause: unknown; fallback: 'loadFailed' | 'saveFailed' } | null>(null);
  const error = failure
    ? failure.cause instanceof PreferenceHttpError
      ? t.httpFailed(failure.cause.status)
      : failure.cause instanceof Error
        ? failure.cause.message
        : t[failure.fallback]
    : null;
  const operationSequence = useRef(0);
  const snapshot = snapshotState.threadId === threadId ? snapshotState.value : DEFAULT_SNAPSHOT;

  useLayoutEffect(() => {
    operationSequence.current += 1;
    setSnapshotState({ threadId, value: DEFAULT_SNAPSHOT });
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
          setError({ cause, fallback: 'loadFailed' });
        }
      })
      .finally(() => {
        if (operationSequence.current === sequence) setLoading(false);
      });
  }, [enabled, threadId]);

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
          setError({ cause, fallback: 'saveFailed' });
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

  return useMemo(
    () => ({
      snapshot,
      effective: oneShot ?? snapshot.effective,
      source: oneShot ? 'once' : snapshot.source,
      oneShot,
      setOneShot,
      clearOneShot,
      loading,
      error,
      setPreference,
    }),
    [snapshot, oneShot, setOneShot, clearOneShot, loading, error, setPreference],
  );
}
