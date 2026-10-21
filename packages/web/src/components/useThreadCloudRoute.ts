'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { RouteAction, RouteOperation } from './CloudConversationRouteNotice';
import { useCloudBindingChanges } from './cloud-binding-events';
import type { BoundConversation, ThreadCloudRouteRead } from './thread-cloud-route';
import { ThreadRouteController } from './thread-route-controller';

export interface ThreadCloudRoute {
  read: ThreadCloudRouteRead;
  busy: 'connect' | 'disconnect' | null;
  operation: RouteOperation;
  write: (action: RouteAction, target: BoundConversation | null) => void;
  /** Reads the route again; a write whose outcome is unknown is settled by this read. */
  reread: () => void;
  /** Drops the notice of a write that has settled; an unsettled write keeps its notice. */
  dismissOutcome: () => void;
}

/**
 * The thread's route and the writes to it (see `ThreadRouteController`). The component that owns this is
 * keyed by thread, so `threadId` never changes under it. `onLanded` hears of every write that took effect.
 */
export function useThreadCloudRoute(threadId: string, onLanded: (action: RouteAction) => void): ThreadCloudRoute {
  const source = useId();
  const [read, setRead] = useState<ThreadCloudRouteRead>({ kind: 'loading' });
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [operation, setOperation] = useState<RouteOperation>({ kind: 'idle' });
  const onLandedRef = useRef(onLanded);
  onLandedRef.current = onLanded;
  const [controller] = useState(
    () =>
      new ThreadRouteController({
        threadId,
        source,
        setRead,
        setBusy,
        setOperation,
        onLanded: (action) => onLandedRef.current(action),
      }),
  );

  useCloudBindingChanges(threadId, source, controller.heardChange);
  useEffect(() => {
    controller.open();
    return controller.close;
  }, [controller]);

  return {
    read,
    busy,
    operation,
    write: controller.write,
    reread: controller.reread,
    dismissOutcome: controller.dismissOutcome,
  };
}
