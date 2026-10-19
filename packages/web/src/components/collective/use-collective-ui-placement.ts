'use client';

import {
  type CollectiveClientContext,
  type CollectiveUiPlacement,
  collectiveUiPlacementSchema,
} from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';

export function useCollectiveUiPlacement(
  iframe: RefObject<HTMLIFrameElement> | undefined,
  connection: CollectiveConnectionProjection,
  context: CollectiveClientContext,
) {
  const [value, setValue] = useState<CollectiveUiPlacement>();
  const latest = useRef({ connection, context });
  latest.current = { connection, context };
  useEffect(() => {
    if (!iframe) return;
    const receive = (event: MessageEvent<unknown>) => {
      const active = latest.current;
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(active.connection.serviceUrl).origin
      )
        return;
      const result = collectiveUiPlacementSchema.safeParse(event.data);
      if (!result.success) return;
      const next = result.data,
        current = active.context;
      if (
        next.bridgeId !== current.bridgeId ||
        next.contextId !== current.contextId ||
        next.contextRevision !== current.revision ||
        next.serviceInstanceId !== active.connection.serviceInstanceId ||
        next.collectiveId !== active.connection.collectiveId ||
        next.humanId !== active.connection.authorizedHumanId ||
        next.channelId !== current.channelId
      )
        return;
      setValue(next);
    };
    addEventListener('message', receive);
    return () => removeEventListener('message', receive);
  }, [iframe]);
  return value?.bridgeId === context.bridgeId &&
    value.contextId === context.contextId &&
    value.contextRevision === context.revision &&
    value.channelId === context.channelId &&
    value.humanId === context.humanId &&
    context.humanId === connection.authorizedHumanId &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    !context.openCafe
    ? value.slots
    : [];
}
