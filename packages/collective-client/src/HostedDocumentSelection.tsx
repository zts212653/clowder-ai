import type { CollectiveDocumentRequest, CollectiveDocumentView } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useSharedArtifactReading } from './SharedArtifactReading.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

type PendingSelection = {
  request: CollectiveDocumentRequest;
  value: CollectiveDocumentView;
  complete(staged: boolean): void;
};

/** Stages selections through the original reading controller and its durable composer draft. */
export function HostedDocumentSelection() {
  const reading = useSharedArtifactReading(),
    shared = useSharedArtifacts();
  const [pending, setPending] = useState<PendingSelection>();
  const latest = useRef({ reading, shared });
  latest.current = { reading, shared };
  useEffect(() => {
    const stage = (event: Event) => {
      const next = (event as CustomEvent<PendingSelection>).detail;
      const state = latest.current.shared;
      const artifact = state?.catalogue.find(
        (item) =>
          item.artifactId === next.request.ref.artifactId &&
          item.sourceEventId === next.request.ref.sourceEventId &&
          item.serviceInstanceId === next.request.ref.serviceInstanceId &&
          item.collectiveId === next.request.ref.collectiveId,
      );
      if (
        next.request.operation.kind !== 'stage-selection' ||
        !artifact ||
        state?.humanId !== next.request.ref.humanId ||
        state.status !== 'ready'
      ) {
        next.complete(false);
        return;
      }
      setPending((previous) => {
        previous?.complete(false);
        return next;
      });
      state.open(artifact, next.request.ref.ownerRevision, {
        discussionOnly: true,
        projectReturn: next.request.ref.projectReturn,
      });
    };
    window.addEventListener('collective:stage-document-selection', stage);
    return () => window.removeEventListener('collective:stage-document-selection', stage);
  }, []);
  useEffect(() => {
    if (!pending) return;
    const { request, value, complete } = pending;
    if (!shared || shared.humanId !== request.ref.humanId || shared.status !== 'ready') {
      complete(false);
      setPending(undefined);
      return;
    }
    if (!reading?.artifact || reading.artifact.artifactId !== request.ref.artifactId) return;
    if (reading.inaccessible) {
      complete(false);
      setPending(undefined);
      return;
    }
    if (!reading.view || reading.view.ownerRevision !== request.ref.ownerRevision) return;
    if (
      request.operation.kind !== 'stage-selection' ||
      reading.artifact.sourceEventId !== request.ref.sourceEventId ||
      reading.view.blobDigest !== value.blobDigest ||
      !reading.view.view.canWrite
    ) {
      complete(false);
      setPending(undefined);
      return;
    }
    reading.setQuote({
      artifactId: reading.artifact.artifactId,
      ownerRevision: value.ownerRevision,
      blobDigest: value.blobDigest,
      span: request.operation.selection,
    });
    complete(true);
    setPending(undefined);
  }, [pending, reading, shared]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      pending.complete(false);
      setPending(undefined);
    }, 9500);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return null;
}
