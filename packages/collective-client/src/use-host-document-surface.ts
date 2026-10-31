import {
  type CollectiveDocumentRef,
  type CollectiveDocumentResult,
  type CollectiveDocumentTarget,
  type CollectiveHostContextInit,
  collectiveDocumentBridgeSchema,
  collectiveDocumentHostReadySchema,
  collectiveDocumentRefSchema,
  collectiveDocumentRequestSchema,
  collectiveDocumentResultSchema,
  collectiveDocumentReturnSchema,
} from '@cat-cafe/shared';
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { collectiveArtifactClient } from './collective-artifact-client.js';
import { serveCollectiveDocumentRequest } from './collective-document-surface-client.js';
import type { MediaSelection } from './use-host-media-surface.js';

type Context = { bridge?: CollectiveHostContextInit; contextId: string; revision: number };
export function useHostDocumentSurface(options: {
  context: MutableRefObject<Context>;
  bridge?: CollectiveHostContextInit;
  hostOrigin: string | null;
  generation: string;
  selection?: MediaSelection;
  api?: ReturnType<typeof collectiveArtifactClient>;
  onDocumentReturn?: (target: CollectiveDocumentTarget, destination: 'project' | 'source' | 'discussion') => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const sent = useRef<string>();
  const [readyKey, setReadyKey] = useState<string>();
  const ready = useRef<string>();
  ready.current = readyKey;
  const currentBridge = options.context.current;
  const bridgeKey = JSON.stringify([
    options.generation,
    options.bridge?.bridgeId,
    currentBridge.contextId,
    currentBridge.revision,
  ]);
  const available = readyKey === bridgeKey;
  useEffect(() => {
    const { bridge, context, hostOrigin } = latest.current;
    if (!bridge || !hostOrigin || context.current.revision < 1 || bridge.authorityStatus === 'revoked') return;
    let attempts = 0;
    const key = JSON.stringify([
      latest.current.generation,
      bridge.bridgeId,
      context.current.contextId,
      context.current.revision,
    ]);
    const sendReady = () => {
      if (ready.current === key || ++attempts > 10) {
        clearInterval(timer);
        return;
      }
      window.parent.postMessage(
        {
          type: 'collective:client-document-ready',
          ...collectiveDocumentBridgeSchema.parse({
            bridgeId: bridge.bridgeId,
            contextId: context.current.contextId,
            contextRevision: context.current.revision,
            serviceInstanceId: bridge.serviceInstanceId,
            collectiveId: bridge.collectiveId,
            connectionId: bridge.connectionId,
            humanId: bridge.humanId,
          }),
        },
        hostOrigin,
      );
    };
    const timer = window.setInterval(sendReady, 1000);
    sendReady();
    return () => window.clearInterval(timer);
  }, [options.generation]);
  const selection = options.selection;
  const selectionKey = JSON.stringify([selection?.artifact.artifactId, selection?.ownerRevision, selection?.options]);
  useEffect(() => {
    const { context, bridge, hostOrigin, selection } = latest.current;
    if (
      !available ||
      !bridge ||
      !hostOrigin ||
      !selection ||
      selection.options?.discussionOnly ||
      selection.artifact.mediaType !== 'text/markdown' ||
      bridge.authorityStatus === 'revoked' ||
      context.current.bridge?.bridgeId !== bridge.bridgeId ||
      context.current.revision < 1
    ) {
      if (!selection) sent.current = undefined;
      return;
    }
    const ref = collectiveDocumentRefSchema.parse({
      serviceInstanceId: bridge.serviceInstanceId,
      collectiveId: bridge.collectiveId,
      connectionId: bridge.connectionId,
      humanId: bridge.humanId,
      bridgeId: bridge.bridgeId,
      artifactId: selection.artifact.artifactId,
      sourceEventId: selection.artifact.sourceEventId,
      contextId: context.current.contextId,
      contextRevision: context.current.revision,
      channelId: selection.artifact.sourceLocation.channelId,
      ownerRevision: selection.ownerRevision ?? selection.artifact.versions.at(-1)?.ownerRevision,
      comparisonOwnerRevision: selection.options?.comparisonOwnerRevision,
      projectReturn: selection.options?.projectReturn,
    });
    const key = JSON.stringify([bridge.bridgeId, selectionKey]);
    if (key === sent.current) return;
    sent.current = key;
    window.parent.postMessage({ type: 'collective:client-document-open', ref }, hostOrigin);
  }, [options.generation, selectionKey, available]);
  useEffect(() => {
    const jobs = new Set<string>();
    const current = (ref: CollectiveDocumentRef) => {
      const { context, bridge } = latest.current,
        active = context.current;
      return (
        bridge?.authorityStatus !== 'revoked' &&
        active.bridge?.authorityStatus !== 'revoked' &&
        bridge?.bridgeId === ref.bridgeId &&
        active.bridge?.bridgeId === ref.bridgeId &&
        active.contextId === ref.contextId &&
        active.revision === ref.contextRevision &&
        bridge.serviceInstanceId === ref.serviceInstanceId &&
        bridge.collectiveId === ref.collectiveId &&
        bridge.connectionId === ref.connectionId &&
        bridge.humanId === ref.humanId
      );
    };
    const listener = async (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== latest.current.hostOrigin) return;
      const ready = collectiveDocumentHostReadySchema.safeParse(event.data);
      if (ready.success) {
        const active = latest.current.context.current,
          bridge = latest.current.bridge;
        if (
          bridge &&
          bridge.authorityStatus !== 'revoked' &&
          ready.data.bridgeId === bridge.bridgeId &&
          ready.data.contextId === active.contextId &&
          ready.data.contextRevision === active.revision &&
          ready.data.serviceInstanceId === bridge.serviceInstanceId &&
          ready.data.collectiveId === bridge.collectiveId &&
          ready.data.connectionId === bridge.connectionId &&
          ready.data.humanId === bridge.humanId
        )
          setReadyKey(JSON.stringify([latest.current.generation, bridge.bridgeId, active.contextId, active.revision]));
        return;
      }
      const returned = collectiveDocumentReturnSchema.safeParse(event.data);
      if (returned.success && current(returned.data.ref)) {
        latest.current.onDocumentReturn?.(returned.data.ref, returned.data.destination);
        return;
      }
      const parsed = collectiveDocumentRequestSchema.safeParse(event.data);
      if (!parsed.success || !current(parsed.data.ref) || jobs.has(parsed.data.requestId)) return;
      const { api, hostOrigin } = latest.current;
      if (!api || !hostOrigin || jobs.size >= 8) return;
      const request = parsed.data;
      jobs.add(request.requestId);
      try {
        let result: CollectiveDocumentResult;
        if (request.operation.kind === 'stage-selection') {
          const fresh = await serveCollectiveDocumentRequest(
            { ...request, operation: { kind: 'read', ownerRevision: request.ref.ownerRevision } },
            api,
          );
          result =
            fresh.kind !== 'read' || !fresh.value.view.canWrite
              ? { kind: 'error' as const, code: 'access_denied' as const }
              : await new Promise<import('@cat-cafe/shared').CollectiveDocumentResult>((resolve) => {
                  const timer = setTimeout(() => resolve({ kind: 'error', code: 'unavailable' }), 10_000);
                  window.dispatchEvent(
                    new CustomEvent('collective:stage-document-selection', {
                      detail: {
                        request,
                        value: fresh.value,
                        complete: (staged: boolean) => {
                          clearTimeout(timer);
                          resolve(staged ? { kind: 'selection_staged' } : { kind: 'error', code: 'conflict' });
                        },
                      },
                    }),
                  );
                });
        } else result = await serveCollectiveDocumentRequest(request, api);
        if (current(request.ref))
          window.parent.postMessage(
            collectiveDocumentResultSchema.parse({
              type: 'collective:client-document-result',
              ref: request.ref,
              requestId: request.requestId,
              result,
            }),
            hostOrigin,
          );
      } finally {
        jobs.delete(request.requestId);
      }
    };
    window.addEventListener('message', listener);
    return () => {
      sent.current = undefined;
      window.removeEventListener('message', listener);
    };
  }, []);
  return available;
}
