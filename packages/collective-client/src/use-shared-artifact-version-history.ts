import { useEffect, useRef, useState } from 'react';
import { collectiveClientErrorMessage } from './client-request.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import type { SharedArtifactHistoryPage } from './shared-artifact-history-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function useSharedArtifactVersionHistory(artifact: SharedArtifact) {
  const shared = useSharedArtifacts();
  const api = shared?.api;
  const fence = JSON.stringify([
    artifact.serviceInstanceId,
    artifact.collectiveId,
    artifact.artifactId,
    artifact.accessRevision,
    shared?.humanId,
    shared?.status,
  ]);
  const current = useRef(fence);
  current.current = fence;
  const [result, setResult] = useState<{ fence: string; page: SharedArtifactHistoryPage }>();
  const [failure, setFailure] = useState<{ fence: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const pinned = useRef({ fence, artifact });
  if (pinned.current.fence !== fence) pinned.current = { fence, artifact };
  const readTarget = pinned.current.artifact;
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setFailure(undefined);
    setBusy(true);
    if (!api) {
      setBusy(false);
      return;
    }
    void api
      .history(readTarget)
      .then(
        (page) => {
          if (active) setResult({ fence, page });
        },
        (error: unknown) => {
          if (active) setFailure({ fence, message: collectiveClientErrorMessage(error) });
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
    // New heads keep this open snapshot; authority changes start a fresh visit.
  }, [api, fence, readTarget]);
  const page = result?.fence === fence ? result.page : undefined;
  const more = async () => {
    if (!api || !page || page.nextOffset === undefined || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const next = await api.history(artifact, {
        offset: page.nextOffset,
        snapshotOwnerRevision: page.snapshotOwnerRevision,
        expectedSnapshot: page.snapshot,
      });
      if (current.current !== fence) return;
      const seen = new Set(page.versions.map((version) => version.ownerRevision));
      if (next.total !== page.total || next.versions.some((version) => seen.has(version.ownerRevision)))
        throw new Error('版本记录正在更新，请重新读取。');
      setResult({ fence, page: { ...next, versions: [...page.versions, ...next.versions] } });
    } catch (error) {
      if (current.current === fence) setFailure({ fence, message: collectiveClientErrorMessage(error) });
    } finally {
      if (current.current === fence) setBusy(false);
    }
  };
  return { page, pending: busy, more, error: failure?.fence === fence ? failure.message : undefined };
}
