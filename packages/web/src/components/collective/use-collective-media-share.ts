'use client';
import {
  type CollectiveArtifactProjection,
  type CollectiveClientContext,
  type CollectiveMediaShareRef,
  collectiveMediaShareOpenSchema,
  collectiveMediaShareResultSchema,
} from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';
import { mediaSurfaceRefMatches } from './collective-media-surface-ref';

/** The private picker lives in this Host. The iframe supplies only an authenticated public return coordinate. */
export function useCollectiveMediaShare(
  frame: RefObject<HTMLIFrameElement>,
  connection?: CollectiveConnectionProjection,
  context?: CollectiveClientContext,
) {
  const [reference, setReference] = useState<CollectiveMediaShareRef>();
  const live = useRef({ connection, context });
  live.current = { connection, context };
  const active = reference && mediaSurfaceRefMatches(reference, context, connection) ? reference : undefined;
  useEffect(() => {
    if (!active) setReference(undefined);
  }, [active]);
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const current = live.current;
      if (
        !current.connection ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(current.connection.serviceUrl).origin
      )
        return;
      const parsed = collectiveMediaShareOpenSchema.safeParse(event.data);
      if (parsed.success && mediaSurfaceRefMatches(parsed.data.ref, current.context, current.connection))
        setReference(parsed.data.ref);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [frame]);
  const finish = (artifact?: CollectiveArtifactProjection) => {
    const current = live.current;
    if (active && current.connection && mediaSurfaceRefMatches(active, current.context, current.connection)) {
      const result = collectiveMediaShareResultSchema.parse({
        type: 'collective:host-media-shared',
        ref: active,
        ...(artifact ? { artifact } : {}),
      });
      frame.current?.contentWindow?.postMessage(result, new URL(current.connection.serviceUrl).origin);
    }
    setReference(undefined);
  };
  return { reference: active, finish };
}
