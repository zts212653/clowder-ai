import {
  type CollectiveHostContextInit,
  type CollectiveMediaShareRef,
  collectiveMediaShareRefSchema,
  collectiveMediaShareResultSchema,
} from '@cat-cafe/shared';
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';

export function useHostMediaShare(options: {
  context: MutableRefObject<{ bridge?: CollectiveHostContextInit; contextId: string; revision: number }>;
  bridge?: CollectiveHostContextInit;
  hostOrigin: string | null;
  channelId: string;
  onShared?: (artifact: SharedArtifact) => Promise<void>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<CollectiveMediaShareRef>();
  useEffect(() => {
    const listener = async (event: MessageEvent<unknown>) => {
      const { context, hostOrigin, bridge, onShared } = latest.current;
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      const parsed = collectiveMediaShareResultSchema.safeParse(event.data);
      if (
        !parsed.success ||
        !pending.current ||
        !bridge ||
        bridge.authorityStatus === 'revoked' ||
        JSON.stringify(collectiveMediaShareRefSchema.parse(pending.current)) !== JSON.stringify(parsed.data.ref) ||
        bridge.bridgeId !== parsed.data.ref.bridgeId ||
        context.current.contextId !== parsed.data.ref.contextId ||
        context.current.bridge?.bridgeId !== parsed.data.ref.bridgeId ||
        context.current.revision !== parsed.data.ref.contextRevision
      )
        return;
      pending.current = undefined;
      const artifact = parsed.data.artifact;
      if (!artifact) return;
      if (
        artifact.serviceInstanceId !== parsed.data.ref.serviceInstanceId ||
        artifact.collectiveId !== parsed.data.ref.collectiveId ||
        artifact.sourceEventId !== parsed.data.ref.sourceEventId ||
        artifact.sourceLocation.channelId !== parsed.data.ref.channelId ||
        !['image/png', 'video/mp4'].includes(artifact.mediaType)
      )
        return;
      await onShared?.(artifact);
    };
    window.addEventListener('message', listener);
    return () => {
      pending.current = undefined;
      window.removeEventListener('message', listener);
    };
  }, []);
  return useCallback((sourceEventId: string) => {
    const { context, bridge, hostOrigin, channelId } = latest.current;
    if (
      !bridge ||
      bridge.authorityStatus === 'revoked' ||
      !hostOrigin ||
      context.current.bridge?.bridgeId !== bridge.bridgeId ||
      context.current.revision < 1
    )
      return;
    const ref = collectiveMediaShareRefSchema.parse({
      bridgeId: bridge.bridgeId,
      serviceInstanceId: bridge.serviceInstanceId,
      collectiveId: bridge.collectiveId,
      connectionId: bridge.connectionId,
      humanId: bridge.humanId,
      v: 1,
      contextId: context.current.contextId,
      contextRevision: context.current.revision,
      channelId,
      sourceEventId,
    });
    pending.current = ref;
    window.parent.postMessage({ type: 'collective:client-media-share', ref }, hostOrigin);
  }, []);
}
