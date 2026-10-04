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

/** The frame generation the handshake minted, observed read-only by the other host bridges (e.g. appearance). */
export interface ObservedFrameGeneration {
  readonly bridgeId: string;
  readonly serviceOrigin: string;
}

export function useCollectiveWorldDirectory(input: {
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly serviceUrl?: string;
  readonly expectedServiceInstanceId?: string;
}) {
  const serviceOrigin = serviceOriginOf(input.serviceUrl);
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
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== input.iframeRef.current?.contentWindow || event.origin !== serviceOrigin) return;
      if (collectiveWorldDirectoryReadySchema.safeParse(event.data).success) {
        const next: WorldDirectoryGeneration = {
          bridgeId: crypto.randomUUID(),
          revision: 0,
          serviceOrigin,
          ...(input.expectedServiceInstanceId ? { expectedServiceInstanceId: input.expectedServiceInstanceId } : {}),
        };
        generation.current = next;
        setFrameGeneration({ bridgeId: next.bridgeId, serviceOrigin });
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
        return;
      }
      const active = generation.current;
      if (!active) return;
      const accepted = acceptWorldDirectory({
        data: event.data,
        eventOrigin: event.origin,
        sourceMatches: true,
        generation: active,
      });
      if (!accepted) {
        if (
          worldDirectoryServiceMismatch({
            data: event.data,
            eventOrigin: event.origin,
            sourceMatches: true,
            generation: active,
          })
        ) {
          setFailure('service_mismatch');
        }
        return;
      }
      generation.current = {
        ...active,
        revision: accepted.revision,
        ...(accepted.state === 'ready' ? { humanId: accepted.humanId } : {}),
      };
      setFailure(undefined);
      setDirectory(accepted);
    };
    window.addEventListener('message', onMessage);
    return () => {
      generation.current = undefined;
      window.removeEventListener('message', onMessage);
    };
  }, [input.expectedServiceInstanceId, input.iframeRef, serviceOrigin]);

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

function serviceOriginOf(serviceUrl?: string): string | undefined {
  if (!serviceUrl) return undefined;
  try {
    const url = new URL(serviceUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
