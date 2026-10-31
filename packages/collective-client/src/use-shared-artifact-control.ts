import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function useSharedArtifactControl(
  artifact: SharedArtifact | undefined,
  request: CollectiveModificationProjection,
) {
  const shared = useSharedArtifacts();
  const [attempt, setAttempt] = useState<{ fence: string; pending: boolean; error?: string }>();
  const [result, setResult] = useState<{ fence: string; request: CollectiveModificationProjection }>();
  const fence = `${artifact?.serviceInstanceId}:${artifact?.collectiveId}:${artifact?.artifactId}:${artifact?.accessRevision}:${request.requestId}`;
  const current = useRef(fence);
  current.current = fence;
  const pending = attempt?.fence === fence && attempt.pending;
  const resolve = async (action: 'cancel' | 'reject') => {
    if (!shared?.api || !artifact || pending) return;
    setAttempt({ fence, pending: true });
    try {
      const resolved = await shared.api.resolveModification(artifact, request, action);
      if (current.current !== fence) return;
      setResult({ fence, request: resolved });
      await shared.refresh();
      await shared.refreshDiscussion?.();
    } catch {
      if (current.current === fence) setAttempt({ fence, pending: false, error: '决定尚未确认，请核对后重试原操作。' });
      await shared?.refresh();
    } finally {
      if (current.current === fence)
        setAttempt((value) => (value?.fence === fence ? { ...value, pending: false } : value));
    }
  };
  const value = result?.fence === fence ? result.request : request;
  const closed = ['cancelled', 'accepted', 'unavailable'].includes(value.state);
  return {
    resolve,
    pending,
    error: !closed && attempt?.fence === fence ? attempt.error : undefined,
    request: value,
    canCancel: Boolean(shared?.humanId && [request.requestingHumanId, request.target.humanId].includes(shared.humanId)),
    closed,
  };
}
