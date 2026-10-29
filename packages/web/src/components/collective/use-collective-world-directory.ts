'use client';

import {
  type CollectiveClientWorldDirectory,
  collectiveHostWorldDirectoryInitSchema,
  collectiveHostWorldSelectionSchema,
  collectiveWorldDirectoryReadySchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
  acceptWorldDirectory,
  type WorldDirectoryGeneration,
  worldDirectoryServiceMismatch,
} from './collective-world-directory';
import {
  beginWorldDirectoryObservation,
  endWorldDirectoryObservation,
  failWorldDirectoryObservation,
  publishWorldDirectoryObservation,
} from './collective-world-directory-store';

/** The frame generation the handshake minted, observed read-only by the other host bridges (e.g. appearance). */
export interface ObservedFrameGeneration {
  readonly bridgeId: string;
  readonly serviceOrigin: string;
  readonly serviceInstanceId?: string;
}

export function useCollectiveWorldDirectory(input: {
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly serviceUrl?: string;
  readonly expectedServiceInstanceId?: string;
}) {
  const serviceOrigin = serviceOriginOf(input.serviceUrl);
  const expectedServiceIdentity = useRef<{ readonly serviceOrigin: string; readonly serviceInstanceId?: string }>();
  rememberExpectedServiceIdentity(expectedServiceIdentity, serviceOrigin, input.expectedServiceInstanceId);
  const generation = useRef<WorldDirectoryGeneration>();
  const [directory, setDirectory] = useState<CollectiveClientWorldDirectory>();
  const [failure, setFailure] = useState<'service_mismatch'>();
  const [frameGeneration, setFrameGeneration] = useState<ObservedFrameGeneration>();

  useEffect(() => {
    generation.current = undefined;
    setDirectory(undefined);
    setFailure(undefined);
    setFrameGeneration(undefined);
    if (!serviceOrigin) return;
    const beginHandshake = () => {
      const expectedServiceInstanceId = expectedServiceIdentity.current?.serviceInstanceId;
      const next: WorldDirectoryGeneration = {
        bridgeId: crypto.randomUUID(),
        revision: 0,
        serviceOrigin,
        ...(expectedServiceInstanceId ? { expectedServiceInstanceId } : {}),
      };
      generation.current = next;
      beginWorldDirectoryObservation({
        serviceUrl: serviceOrigin,
        bridgeId: next.bridgeId,
        ...(next.expectedServiceInstanceId ? { expectedServiceInstanceId: next.expectedServiceInstanceId } : {}),
      });
      setFrameGeneration({
        bridgeId: next.bridgeId,
        serviceOrigin,
        ...(next.expectedServiceInstanceId ? { serviceInstanceId: next.expectedServiceInstanceId } : {}),
      });
      setDirectory(undefined);
      setFailure(undefined);
      input.iframeRef.current?.contentWindow?.postMessage(
        collectiveHostWorldDirectoryInitSchema.parse({
          type: 'collective:host-world-directory-init',
          bridgeId: next.bridgeId,
          ...(next.expectedServiceInstanceId ? { expectedServiceInstanceId: next.expectedServiceInstanceId } : {}),
        }),
        serviceOrigin,
      );
    };
    const failIfServiceMismatch = (active: WorldDirectoryGeneration, data: unknown) => {
      if (
        !worldDirectoryServiceMismatch({
          data,
          eventOrigin: serviceOrigin,
          sourceMatches: true,
          generation: active,
        })
      )
        return;
      failWorldDirectoryObservation({
        serviceUrl: serviceOrigin,
        bridgeId: active.bridgeId,
        failure: 'service_mismatch',
      });
      setFailure('service_mismatch');
    };
    const receiveDirectory = (data: unknown) => {
      const active = generation.current;
      if (!active) return;
      const fenced = fenceGenerationToExpectedIdentity(active, expectedServiceIdentity.current);
      generation.current = fenced;
      const accepted = acceptWorldDirectory({
        data,
        eventOrigin: serviceOrigin,
        sourceMatches: true,
        generation: fenced,
      });
      if (!accepted) {
        failIfServiceMismatch(fenced, data);
        return;
      }
      generation.current = {
        ...fenced,
        revision: accepted.revision,
        ...(accepted.serviceInstanceId ? { expectedServiceInstanceId: accepted.serviceInstanceId } : {}),
        ...(accepted.state === 'ready' ? { humanId: accepted.humanId } : {}),
      };
      rememberExpectedServiceIdentity(expectedServiceIdentity, serviceOrigin, accepted.serviceInstanceId);
      publishWorldDirectoryObservation({
        serviceUrl: serviceOrigin,
        bridgeId: fenced.bridgeId,
        directory: accepted,
      });
      setFrameGeneration((current) =>
        observeFrameServiceInstance(current, fenced.bridgeId, accepted.serviceInstanceId),
      );
      setFailure(undefined);
      setDirectory(accepted);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== input.iframeRef.current?.contentWindow || event.origin !== serviceOrigin) return;
      if (collectiveWorldDirectoryReadySchema.safeParse(event.data).success) beginHandshake();
      else receiveDirectory(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      const active = generation.current;
      if (active) {
        endWorldDirectoryObservation({ serviceUrl: serviceOrigin, bridgeId: active.bridgeId });
      }
      generation.current = undefined;
      window.removeEventListener('message', onMessage);
    };
  }, [input.iframeRef, serviceOrigin]);

  const selectWorld = useCallback(
    (collectiveId: string): boolean => {
      const active = generation.current;
      if (!active || !serviceOrigin || directory?.state !== 'ready') return false;
      const membership = directory.memberships.find((candidate) => candidate.collectiveId === collectiveId);
      if (!membership) return false;
      input.iframeRef.current?.contentWindow?.postMessage(
        collectiveHostWorldSelectionSchema.parse({
          type: 'collective:host-select-world',
          bridgeId: active.bridgeId,
          directoryRevision: directory.revision,
          serviceInstanceId: directory.serviceInstanceId,
          humanId: directory.humanId,
          collectiveId: membership.collectiveId,
        }),
        serviceOrigin,
      );
      return true;
    },
    [directory, input.iframeRef, serviceOrigin],
  );

  return { directory, failure, frameGeneration, selectWorld };
}

function observeFrameServiceInstance(
  current: ObservedFrameGeneration | undefined,
  bridgeId: string,
  serviceInstanceId?: string,
) {
  if (!serviceInstanceId || current?.bridgeId !== bridgeId) return current;
  return { ...current, serviceInstanceId };
}

/** Missing metadata is not an identity change; an accepted frame may strengthen the same-origin fence. */
function rememberExpectedServiceIdentity(
  identity: { current: { readonly serviceOrigin: string; readonly serviceInstanceId?: string } | undefined },
  serviceOrigin?: string,
  observedServiceInstanceId?: string,
) {
  if (!serviceOrigin) identity.current = undefined;
  else if (identity.current?.serviceOrigin !== serviceOrigin)
    identity.current = {
      serviceOrigin,
      ...(observedServiceInstanceId ? { serviceInstanceId: observedServiceInstanceId } : {}),
    };
  else if (observedServiceInstanceId)
    identity.current = { serviceOrigin, serviceInstanceId: observedServiceInstanceId };
}

function fenceGenerationToExpectedIdentity(
  generation: WorldDirectoryGeneration,
  identity: { readonly serviceOrigin: string; readonly serviceInstanceId?: string } | undefined,
): WorldDirectoryGeneration {
  if (
    generation.expectedServiceInstanceId ||
    identity?.serviceOrigin !== generation.serviceOrigin ||
    !identity.serviceInstanceId
  )
    return generation;
  return { ...generation, expectedServiceInstanceId: identity.serviceInstanceId };
}

function serviceOriginOf(serviceUrl?: string): string | undefined {
  if (!serviceUrl) return undefined;
  try {
    const url = new URL(serviceUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
