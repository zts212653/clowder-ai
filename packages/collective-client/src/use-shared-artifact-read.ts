import { useEffect, useRef, useState } from 'react';
import { CollectiveClientRequestError, collectiveClientErrorMessage } from './client-request.js';
import type { collectiveArtifactClient, SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import { SharedArtifactCatalogueReconciled } from './collective-artifact-client.js';
import type { CollectiveArtifactState } from './use-collective-artifacts.js';

export function useSharedArtifactRead(
  api: ReturnType<typeof collectiveArtifactClient> | undefined,
  artifact: SharedArtifact | undefined,
  selectedRevision: number | undefined,
  status: CollectiveArtifactState['status'] | undefined,
  refreshCatalogue?: () => Promise<void>,
) {
  const latestRevision = artifact?.versions.at(-1)?.ownerRevision;
  const authorityFence = JSON.stringify([
    artifact?.artifactId,
    artifact?.mediaType,
    artifact?.accessRevision,
    artifact?.availability,
    latestRevision,
    selectedRevision,
    status,
  ]);
  // Returning to the same authority after closing or a deny must still obtain a fresh owner decision.
  const visit = useRef({ authorityFence, generation: 0 });
  if (visit.current.authorityFence !== authorityFence)
    visit.current = { authorityFence, generation: visit.current.generation + 1 };
  const fence = JSON.stringify([authorityFence, visit.current.generation]);
  const [loaded, setLoaded] = useState<{ fence: string; view: SharedMarkdownView }>();
  // Catalogue polling cannot abandon and restart a still-running read of this exact version and authority.
  const pinned = useRef({ fence, artifact });
  if (pinned.current.fence !== fence) pinned.current = { fence, artifact };
  const readTarget = pinned.current.artifact;
  const [failure, setFailure] = useState<{ fence: string; message: string; denied: boolean }>();
  useEffect(() => {
    if (
      !api ||
      !readTarget ||
      readTarget.mediaType !== 'text/markdown' ||
      status !== 'ready' ||
      readTarget.availability !== 'available'
    )
      return;
    let active = true;
    let loading = false;
    const fail = async (error: unknown) => {
      if (!active) return;
      setLoaded(undefined);
      if (error instanceof SharedArtifactCatalogueReconciled) {
        setFailure(undefined);
        await refreshCatalogue?.();
        return;
      }
      setFailure({
        fence,
        message: collectiveClientErrorMessage(error),
        denied: error instanceof CollectiveClientRequestError && error.status === 403,
      });
    };
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const view = await api.read(readTarget, selectedRevision);
        if (active) {
          setLoaded({ fence, view });
          setFailure(undefined);
        }
      } catch (error) {
        await fail(error);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, readTarget, selectedRevision, status, fence, refreshCatalogue]);
  const error = failure?.fence === fence ? failure : undefined;
  const inaccessible = error?.denied || status === 'access_denied' || (status === 'ready' && !artifact);
  const unavailable = status !== 'ready' || artifact?.availability === 'owner_unavailable';
  const view = loaded?.fence === fence && !inaccessible && !unavailable && !error ? loaded.view : undefined;
  return { view, inaccessible, unavailable, error };
}
