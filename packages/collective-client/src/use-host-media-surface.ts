import {
  type CollectiveHostContextInit,
  type CollectiveMediaSurfaceRefV1,
  collectiveMediaSurfaceRefKey,
  collectiveMediaSurfaceRequestSchema,
  collectiveMediaSurfaceReturnSchema,
} from '@cat-cafe/shared';
import { type MutableRefObject, useEffect, useRef } from 'react';
import type {
  collectiveArtifactClient,
  SharedArtifact,
  SharedArtifactOpenOptions,
} from './collective-artifact-client.js';
import { serveCollectiveMediaRequest } from './collective-media-surface-client.js';

export type MediaSelection = {
  artifact: SharedArtifact;
  ownerRevision?: number;
  options?: SharedArtifactOpenOptions;
  onReturn: () => void;
};
type Context = { bridge?: CollectiveHostContextInit; contextId: string; revision: number };
export function useHostMediaSurface(options: {
  context: MutableRefObject<Context>;
  bridge?: CollectiveHostContextInit;
  hostOrigin: string | null;
  channelId: string;
  generation: string;
  projectReturnSupported?: boolean;
  selection?: MediaSelection;
  api?: ReturnType<typeof collectiveArtifactClient>;
  humanName?: (humanId: string) => string;
}) {
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<CollectiveMediaSurfaceRefV1>();
  const { artifact, ownerRevision } = options.selection ?? {};
  const selectedRevision = ownerRevision ?? artifact?.versions.at(-1)?.ownerRevision;
  const selectionKey = JSON.stringify([
    artifact?.artifactId,
    selectedRevision,
    artifact?.sourceEventId,
    options.selection?.options?.projectReturn,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Parent context publication runs first; these primitive signals issue a new ref only after its channel/context generation advances.
  useEffect(() => {
    const { context, bridge, hostOrigin, channelId, selection, projectReturnSupported } = latest.current;
    active.current = undefined;
    const { contextId, revision } = context.current;
    if (
      !selection ||
      !bridge ||
      context.current.bridge?.bridgeId !== bridge.bridgeId ||
      bridge.authorityStatus === 'revoked' ||
      !hostOrigin ||
      revision < 1 ||
      selection.artifact.sourceLocation.channelId !== channelId ||
      !selectedRevision ||
      (selection.artifact.mediaType !== 'image/png' && selection.artifact.mediaType !== 'video/mp4')
    )
      return;
    const ref: CollectiveMediaSurfaceRefV1 = {
      v: 1,
      bridgeId: bridge.bridgeId,
      contextId,
      contextRevision: revision,
      serviceInstanceId: bridge.serviceInstanceId,
      collectiveId: bridge.collectiveId,
      humanId: bridge.humanId,
      connectionId: bridge.connectionId,
      channelId,
      artifactId: selection.artifact.artifactId,
      sourceEventId: selection.artifact.sourceEventId,
      ownerRevision: selectedRevision,
      ...(projectReturnSupported && selection.options?.projectReturn
        ? { projectReturn: selection.options.projectReturn }
        : {}),
    };
    active.current = ref;
    window.parent.postMessage({ type: 'collective:client-media-surface', ref }, hostOrigin);
  }, [options.generation, options.channelId, options.projectReturnSupported, selectionKey, selectedRevision]);
  useEffect(() => {
    const jobs = new Set<string>();
    const current = (ref: CollectiveMediaSurfaceRefV1) => {
      const value = latest.current,
        context = value.context.current;
      return (
        Boolean(active.current && collectiveMediaSurfaceRefKey(active.current) === collectiveMediaSurfaceRefKey(ref)) &&
        value.bridge?.bridgeId === ref.bridgeId &&
        context.bridge?.authorityStatus !== 'revoked' &&
        context.bridge?.bridgeId === ref.bridgeId &&
        context.contextId === ref.contextId &&
        context.revision === ref.contextRevision
      );
    };
    const listener = async (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== latest.current.hostOrigin) return;
      const returned = collectiveMediaSurfaceReturnSchema.safeParse(event.data);
      if (returned.success && current(returned.data.ref)) {
        active.current = undefined;
        latest.current.selection?.onReturn();
        return;
      }
      const parsed = collectiveMediaSurfaceRequestSchema.safeParse(event.data);
      if (!parsed.success || !current(parsed.data.ref)) return;
      if (jobs.has(parsed.data.requestId)) return;
      if (jobs.size >= 8) {
        window.parent.postMessage(
          {
            type: 'collective:client-media-result',
            ref: parsed.data.ref,
            requestId: parsed.data.requestId,
            result: { kind: 'error', code: 'unavailable' },
          },
          event.origin,
        );
        return;
      }
      jobs.add(parsed.data.requestId);
      const { api, selection } = latest.current;
      const result =
        api && selection
          ? await serveCollectiveMediaRequest(parsed.data, api, selection.artifact, latest.current.humanName)
          : { kind: 'error' as const, code: 'access_denied' as const };
      jobs.delete(parsed.data.requestId);
      if (!current(parsed.data.ref)) return;
      window.parent.postMessage(
        { type: 'collective:client-media-result', ref: parsed.data.ref, requestId: parsed.data.requestId, result },
        event.origin,
      );
    };
    window.addEventListener('message', listener);
    return () => {
      active.current = undefined;
      window.removeEventListener('message', listener);
    };
  }, []);
}
