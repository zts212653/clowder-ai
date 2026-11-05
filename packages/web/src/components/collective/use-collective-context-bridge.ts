'use client';
import {
  type CollectiveAcceptedWorkResult,
  type CollectiveClientCafeSection,
  type CollectiveClientContext,
  type CollectiveMediaSurfaceRefV1,
  collectiveClientCafeSectionSchema,
  collectiveClientContextSchema,
  collectiveContextReadySchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';
import {
  type BridgeConnection,
  type BridgeGeneration,
  collectiveFocusKey,
  collectiveFocusMessage,
  handleCollectiveAccountabilityChange,
  queueAcceptedWorkResult,
} from './collective-context-bridge-messages';
import { mediaSurfaceRefMatches, readMediaSurfaceRef } from './collective-media-surface-ref';
import type { CollectiveWorkActionTarget } from './collective-work-action';

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
  const authorityStatus = connection?.authorityStatus;
  const [context, setContext] = useState<CollectiveClientContext>();
  const [mediaRef, setMediaRef] = useState<CollectiveMediaSurfaceRefV1>();
  const generation = useRef<BridgeGeneration>();
  const current = useRef<CollectiveClientContext>();
  const pendingWorkResults = useRef(new Map<string, Promise<void>>());
  const focusedGeneration = useRef<string>();
  const clear = useCallback(() => {
    current.current = undefined;
    setContext(undefined);
    setMediaRef(undefined);
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
    const mediaConnection = bridgeConnection && authorityStatus ? { ...bridgeConnection, authorityStatus } : undefined;
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
      const focusKey = focusWork ? collectiveFocusKey(value, focusWork) : undefined;
      if (
        focusWork &&
        focusKey &&
        focusedGeneration.current !== focusKey &&
        focusWork.connectionId === bridgeConnection.connectionId
      ) {
        focusedGeneration.current = focusKey;
        iframeRef.current?.contentWindow?.postMessage(
          collectiveFocusMessage(value, focusWork),
          bridgeConnection.serviceOrigin,
        );
      }
    };
    const handleCafeSection = (data: unknown, active?: BridgeGeneration) => {
      const parsed = collectiveClientCafeSectionSchema.safeParse(data);
      if (!parsed.success) return false;
      const value = parsed.data;
      const context = current.current;
      if (
        !active ||
        !context ||
        !bridgeConnection ||
        !clientCafeSectionMatches(value, context, active, bridgeConnection)
      )
        return true;
      const next = { ...context, cafeSection: value.section };
      current.current = next;
      setContext(next);
      return true;
    };
    const handleMedia = (data: unknown) => {
      const media = readMediaSurfaceRef(data, current.current, mediaConnection);
      if (!media) return false;
      setMediaRef(media);
      return true;
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isCurrentCollectiveFrame(event, iframeRef.current, bridgeConnection)) return;
      const active = generation.current;
      if (
        handleReady(event.data) ||
        handleMedia(event.data) ||
        handleCollectiveAccountabilityChange(event.data, active, bridgeConnection) ||
        queueAcceptedWorkResult({
          data: event.data,
          active,
          connection: bridgeConnection,
          pending: pendingWorkResults.current,
          reconcile: onWorkResultAccepted,
          currentGeneration: () => generation.current,
          postToClient: (message) =>
            iframeRef.current?.contentWindow?.postMessage(message, bridgeConnection.serviceOrigin),
        }) ||
        handleCafeSection(event.data, active)
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
    authorityStatus,
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
  const openMembers = useCallback(() => {
    const value = current.current;
    if (value && serviceOrigin)
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'collective:host-member-list-open',
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
  const closeMedia = useCallback(() => {
    if (mediaRef && serviceOrigin && mediaSurfaceRefMatches(mediaRef, current.current, connection))
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'collective:host-media-return', ref: mediaRef },
        serviceOrigin,
      );
    setMediaRef(undefined);
  }, [connection, iframeRef, mediaRef, serviceOrigin]);
  return {
    context: valid,
    reset,
    close,
    open,
    openMembers,
    mediaRef: mediaRef && mediaSurfaceRefMatches(mediaRef, valid, connection) ? mediaRef : undefined,
    closeMedia,
  };
}

function isCurrentCollectiveFrame(
  event: MessageEvent<unknown>,
  frame: HTMLIFrameElement | null,
  connection: BridgeConnection | undefined,
): connection is BridgeConnection {
  return Boolean(connection && event.source === frame?.contentWindow && event.origin === connection.serviceOrigin);
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

function clientCafeSectionMatches(
  value: CollectiveClientCafeSection,
  context: CollectiveClientContext,
  active: BridgeGeneration,
  connection: BridgeConnection,
) {
  return (
    value.bridgeId === active.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision &&
    value.bridgeId === context.bridgeId &&
    value.contextId === context.contextId &&
    value.contextRevision === context.revision &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.humanId === connection.authorizedHumanId &&
    value.channelId === context.channelId
  );
}
