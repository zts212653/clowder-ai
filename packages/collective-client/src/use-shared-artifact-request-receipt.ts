import { useEffect, useState } from 'react';
import type { collectiveArtifactClient } from './collective-artifact-client.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

type Receipts = Awaited<ReturnType<ReturnType<typeof collectiveArtifactClient>['receipts']>>;
/** Exact request lookup retains old adoption feedback without polling complete version arrays. */
export function useSharedArtifactRequestReceipt(requestEventId: string, enabled = true) {
  const shared = useSharedArtifacts();
  const api = shared?.api;
  const heads = JSON.stringify(
    shared?.catalogue.map((artifact) => [
      artifact.serviceInstanceId,
      artifact.collectiveId,
      artifact.artifactId,
      artifact.accessRevision,
      artifact.versions.at(-1)?.receiptRef,
    ]),
  );
  const fence = JSON.stringify([heads, requestEventId, shared?.humanId, shared?.status, enabled]);
  const [loaded, setLoaded] = useState<{ fence: string; receipts: Receipts }>();
  useEffect(() => {
    let active = true;
    if (!api?.receipts || !enabled || shared?.status !== 'ready') return;
    void api.receipts(requestEventId).then(
      (receipts) => {
        if (active) setLoaded({ fence, receipts });
      },
      () => {
        if (active) setLoaded(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [api, requestEventId, enabled, shared?.status, fence]);
  if (!enabled || shared?.status !== 'ready') return [];
  if (loaded?.fence === fence) return loaded.receipts;
  return (
    shared?.catalogue.flatMap((artifact) =>
      artifact.versions
        .filter((version) => version.lineage?.requestEventId === requestEventId)
        .map((version) => ({ artifact, version })),
    ) ?? []
  );
}
