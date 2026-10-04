'use client';
import {
  type CollectiveAcceptedWorkResult,
  type CollectiveClientContext,
  collectiveClientContextSchema,
  collectiveClientWorkResultAcceptedSchema,
  collectiveContextReadySchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';
import type { CollectiveWorkActionTarget } from './collective-work-action';

interface BridgeGeneration {
  bridgeId: string;
  contextId?: string;
  revision: number;
}

interface BridgeConnection {
  serviceOrigin: string;
  serviceInstanceId: string;
  collectiveId: string;
  connectionId: string;
  authorizedHumanId: string;
}

/** This bridge carries public coordinates only. Host data and authority never cross the frame. */
export function useCollectiveContextBridge(
  iframeRef: RefObject<HTMLIFrameElement>,
  connection?: CollectiveConnectionProjection,
  onWorkResultAccepted?: (input: CollectiveAcceptedWorkResult) => Promise<void>,
  focusWork?: CollectiveWorkActionTarget | null,
) {
  const serviceUrl = connection?.serviceUrl;
  const serviceOrigin = serviceUrl ? new URL(serviceUrl).origin : undefined;
  const serviceInstanceId = connection?.serviceInstanceId;
  const collectiveId = connection?.collectiveId;
  const connectionId = connection?.connectionId;
  const authorizedHumanId = connection?.authorizedHumanId;
  const [context, setContext] = useState<CollectiveClientContext>();
  const generation = useRef<BridgeGeneration>();
  const current = useRef<CollectiveClientContext>();
  const pendingWorkResults = useRef(new Map<string, Promise<void>>());
  const focusedGeneration = useRef<string>();
  const clear = useCallback(() => {
    current.current = undefined;
    setContext(undefined);
  }, []);
  const reset = useCallback(() => {
    generation.current = undefined;
    focusedGeneration.current = undefined;
    pendingWorkResults.current.clear();
    clear();
    if (!serviceOrigin || !serviceInstanceId || !collectiveId || !connectionId || !authorizedHumanId) return;
    const bridgeId = crypto.randomUUID();
    generation.current = { bridgeId, revision: 0 };
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: 'collective:host-context-init',
        bridgeId,
        serviceInstanceId,
        collectiveId,
        connectionId,
        humanId: authorizedHumanId,
        authorityStatus: connection?.authorityStatus,
      },
      serviceOrigin,
    );
  }, [
    authorizedHumanId,
    clear,
    collectiveId,
    connection?.authorityStatus,
    connectionId,
    iframeRef,
    serviceInstanceId,
    serviceOrigin,
  ]);
  useEffect(() => {
    reset();
    const bridgeConnection = bridgeConnectionFrom({
      authorizedHumanId,
      collectiveId,
      connectionId,
      serviceInstanceId,
      serviceOrigin,
    });
    const handleReady = (data: unknown) => {
      if (!collectiveContextReadySchema.safeParse(data).success) return false;
      reset();
      return true;
    };
    const handleContext = (data: unknown, active?: BridgeGeneration) => {
      const parsed = collectiveClientContextSchema.safeParse(data);
      if (!parsed.success || !active || !bridgeConnection) return;
      const value = parsed.data;
      if (!clientContextMatches(value, active, bridgeConnection)) return;
      active.contextId = value.contextId;
      active.revision = value.revision;
      current.current = value;
      setContext(value);
      const focusKey = focusWork
        ? `${value.bridgeId}:${value.contextId}:${value.revision}:${focusWork.connectionId}:${focusWork.workId}:${focusWork.workRevision}:${focusWork.resultRevision}`
        : undefined;
      if (
        focusWork &&
        focusKey &&
        focusedGeneration.current !== focusKey &&
        focusWork.connectionId === bridgeConnection.connectionId
      ) {
        focusedGeneration.current = focusKey;
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'collective:host-focus-work',
            bridgeId: value.bridgeId,
            contextId: value.contextId,
            contextRevision: value.revision,
            workId: focusWork.workId,
            workRevision: focusWork.workRevision,
            channelId: focusWork.channelId,
            resultEventId: focusWork.resultEventId,
            resultRevision: focusWork.resultRevision,
          },
          bridgeConnection.serviceOrigin,
        );
      }
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        !bridgeConnection ||
        event.source !== iframeRef.current?.contentWindow ||
        event.origin !== bridgeConnection.serviceOrigin
      )
        return;
      if (handleReady(event.data)) return;
      const active = generation.current;
      if (
        queueAcceptedWorkResult({
          data: event.data,
          active,
          connection: bridgeConnection,
          pending: pendingWorkResults.current,
          reconcile: onWorkResultAccepted,
          currentGeneration: () => generation.current,
          postToClient: (message) =>
            iframeRef.current?.contentWindow?.postMessage(message, bridgeConnection.serviceOrigin),
        })
      )
        return;
      handleContext(event.data, active);
    };
    window.addEventListener('message', onMessage);
    return () => {
      generation.current = undefined;
      window.removeEventListener('message', onMessage);
    };
  }, [
    authorizedHumanId,
    collectiveId,
    connectionId,
    focusWork,
    iframeRef,
    onWorkResultAccepted,
    reset,
    serviceInstanceId,
    serviceOrigin,
  ]);
  const close = useCallback(() => {
    const value = current.current;
    if (value && serviceOrigin)
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'collective:host-context-close',
          bridgeId: value.bridgeId,
          contextId: value.contextId,
          revision: value.revision,
        },
        serviceOrigin,
      );
    clear();
  }, [clear, iframeRef, serviceOrigin]);
  const open = useCallback(() => {
    const value = current.current;
    if (value && serviceOrigin)
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'collective:host-context-open',
          bridgeId: value.bridgeId,
          contextId: value.contextId,
          revision: value.revision,
        },
        serviceOrigin,
      );
  }, [iframeRef, serviceOrigin]);
  const valid =
    context &&
    connectionId &&
    generation.current?.bridgeId === context.bridgeId &&
    context.serviceInstanceId === serviceInstanceId &&
    context.collectiveId === collectiveId &&
    context.humanId === authorizedHumanId
      ? context
      : undefined;
  return { context: valid, reset, close, open };
}

function bridgeConnectionFrom(input: {
  serviceOrigin?: string;
  serviceInstanceId?: string;
  collectiveId?: string;
  connectionId?: string;
  authorizedHumanId?: string;
}): BridgeConnection | undefined {
  const { serviceOrigin, serviceInstanceId, collectiveId, connectionId, authorizedHumanId } = input;
  if (!serviceOrigin || !serviceInstanceId || !collectiveId || !connectionId || !authorizedHumanId) return undefined;
  return { serviceOrigin, serviceInstanceId, collectiveId, connectionId, authorizedHumanId };
}

function clientContextMatches(value: CollectiveClientContext, active: BridgeGeneration, connection: BridgeConnection) {
  return (
    value.bridgeId === active.bridgeId &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.humanId === connection.authorizedHumanId &&
    (!active.contextId || active.contextId === value.contextId) &&
    value.revision > active.revision &&
    value.channelIds.includes(value.channelId)
  );
}

function queueAcceptedWorkResult(input: {
  data: unknown;
  active?: BridgeGeneration;
  connection: BridgeConnection;
  pending: Map<string, Promise<void>>;
  reconcile?: (evidence: CollectiveAcceptedWorkResult) => Promise<void>;
  currentGeneration: () => BridgeGeneration | undefined;
  postToClient: (message: unknown) => void;
}): boolean {
  const parsed = collectiveClientWorkResultAcceptedSchema.safeParse(input.data);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (!input.active || !input.reconcile || !acceptedWorkMatches(value, input.active, input.connection)) return true;
  const key = `${value.bridgeId}:${value.workId}:${value.workRevision}`;
  if (input.pending.has(key)) return true;
  const operation = input
    .reconcile(acceptedEvidence(value))
    .then(() => {
      const latest = input.currentGeneration();
      if (!reconciliationContextMatches(value, latest)) return;
      input.postToClient({
        type: 'collective:host-work-result-reconciled',
        bridgeId: value.bridgeId,
        contextId: value.contextId,
        contextRevision: value.contextRevision,
        workId: value.workId,
        workRevision: value.workRevision,
      });
    })
    .catch(() => undefined)
    .finally(() => {
      if (input.pending.get(key) === operation) input.pending.delete(key);
    });
  input.pending.set(key, operation);
  return true;
}

function acceptedWorkMatches(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
  active: BridgeGeneration,
  connection: BridgeConnection,
) {
  return (
    value.bridgeId === active.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.connectionId === connection.connectionId &&
    value.humanId === connection.authorizedHumanId
  );
}

function acceptedEvidence(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
): CollectiveAcceptedWorkResult {
  return {
    serviceInstanceId: value.serviceInstanceId,
    collectiveId: value.collectiveId,
    connectionId: value.connectionId,
    workId: value.workId,
    workRevision: value.workRevision,
    assignmentEventId: value.assignmentEventId,
    resultEventId: value.resultEventId,
    resultRevision: value.resultRevision,
  };
}

function reconciliationContextMatches(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
  latest?: BridgeGeneration,
) {
  return (
    latest?.bridgeId === value.bridgeId &&
    latest.contextId === value.contextId &&
    latest.revision === value.contextRevision
  );
}
