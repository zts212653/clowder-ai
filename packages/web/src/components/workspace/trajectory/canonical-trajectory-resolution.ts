'use client';

import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  replaceInvocationTrajectoryTarget,
  replaceInvocationTrajectoryThreadRoute,
  type TrajectoryTarget,
} from './trajectory-navigation';

export type ResolvedTrajectoryTarget = TrajectoryTarget & { threadId: string; sessionId: string };
export type TrajectoryResolutionError = { status: number; code: string };

function targetKey(target: TrajectoryTarget | undefined): string | undefined {
  return target ? `${target.invocationId}\u0000${target.threadId ?? ''}\u0000${target.sessionId ?? ''}` : undefined;
}

function trajectoryResolutionUrl(target: TrajectoryTarget): string {
  const params = new URLSearchParams();
  if (target.threadId) params.set('threadId', target.threadId);
  if (target.sessionId) params.set('sessionId', target.sessionId);
  const query = params.toString();
  return `/api/invocations/${encodeURIComponent(target.invocationId)}/trajectory${query ? `?${query}` : ''}`;
}

export function useCanonicalTrajectoryTarget(target: TrajectoryTarget | undefined, activeThreadId: string) {
  const key = targetKey(target);
  const [reload, setReload] = useState(0);
  const [resolved, setResolved] = useState<{ key: string; target: ResolvedTrajectoryTarget }>();
  const [failure, setFailure] = useState<{ key: string; error: TrajectoryResolutionError }>();
  const [loadingKey, setLoadingKey] = useState<string>();

  useEffect(() => {
    void reload;
    if (!target || !key) return;
    let cancelled = false;
    setLoadingKey(key);
    setFailure(undefined);
    void apiFetch(trajectoryResolutionUrl(target))
      .then(async (response) => {
        const body = (await response.json()) as {
          code?: string;
          invocationId?: string;
          threadId?: string;
          sessionId?: string;
        };
        if (!response.ok) {
          throw { status: response.status, code: body.code ?? 'INVOCATION_TRAJECTORY_UNAVAILABLE' };
        }
        if (
          body.invocationId !== target.invocationId ||
          !body.threadId ||
          !body.sessionId ||
          (target.threadId !== undefined && target.threadId !== body.threadId) ||
          (target.sessionId !== undefined && target.sessionId !== body.sessionId)
        ) {
          throw { status: 409, code: 'INVOCATION_RESOLUTION_RESPONSE_MISMATCH' };
        }
        return { ...target, threadId: body.threadId, sessionId: body.sessionId } satisfies ResolvedTrajectoryTarget;
      })
      .then((canonical) => {
        if (cancelled) return;
        setResolved({ key, target: canonical });
        replaceInvocationTrajectoryTarget(canonical);
        if (canonical.threadId !== activeThreadId) {
          useChatStore.getState().setCurrentThread(canonical.threadId);
          replaceInvocationTrajectoryThreadRoute(canonical.threadId);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const typed = cause as Partial<TrajectoryResolutionError>;
        setFailure({
          key,
          error: {
            status: typeof typed.status === 'number' ? typed.status : 503,
            code: typeof typed.code === 'string' ? typed.code : 'INVOCATION_TRAJECTORY_UNAVAILABLE',
          },
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingKey((current) => (current === key ? undefined : current));
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, key, reload, target]);

  return useMemo(
    () => ({
      resolvedTarget: resolved && resolved.key === key ? resolved.target : undefined,
      resolutionError: failure && failure.key === key ? failure.error : null,
      resolvingTarget: loadingKey === key,
      retryResolution: () => setReload((value) => value + 1),
    }),
    [failure, key, loadingKey, resolved],
  );
}
