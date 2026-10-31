import {
  type CollectiveHostContextInit,
  type CollectiveWorkProjection,
  collectiveHostWorkPolicyCommandSchema,
} from '@cat-cafe/shared';
import { createContext, type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { ClientRequest } from './client-request.js';
import { executeHostWorkPolicyCommand, HostWorkPolicyCommandError } from './host-work-policy-command.js';

export const HostWorkPermissionContext = createContext<{
  connectionId?: string;
  request?: (work: CollectiveWorkProjection) => void;
}>({});
export function useHostWorkPolicy(input: {
  hostOrigin: string | null;
  context: MutableRefObject<{ bridge?: CollectiveHostContextInit; contextId: string; revision: number }>;
  request?: ClientRequest;
  refresh?: () => Promise<void>;
}) {
  const pending = useRef(new Map<string, Promise<void>>());
  const live = useRef(input);
  live.current = input;
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const current = live.current;
      const active = current.context.current;
      if (event.source !== window.parent || event.origin !== current.hostOrigin || !current.request) return;
      const parsed = collectiveHostWorkPolicyCommandSchema.safeParse(event.data);
      if (!parsed.success) return;
      const command = parsed.data;
      if (!matches(command, active) || active.bridge?.authorityStatus !== 'connected') return;
      if (pending.current.has(command.commandId)) return;
      const humanRequest = current.request;
      const request: ClientRequest = async (path, init) => {
        if (
          !matches(command, live.current.context.current) ||
          live.current.context.current.bridge?.authorityStatus !== 'connected'
        )
          throw new Error('页面授权已变化。');
        return humanRequest(path, init);
      };
      const operation = executeHostWorkPolicyCommand({ command, request, storage: localStorage })
        .then(async (receipt) => {
          // Keep the command's exact generation; a delayed registration must never be adopted in a new frame.
          if (!matches(command, live.current.context.current)) return;
          window.parent.postMessage(
            {
              ...commandCoordinates(command),
              type: 'collective:client-work-policy-reply',
              result: { state: 'registered', receipt },
            },
            event.origin,
          );
          await current.refresh?.();
        })
        .catch((cause: unknown) => {
          if (!matches(command, live.current.context.current)) return;
          window.parent.postMessage(
            {
              ...commandCoordinates(command),
              type: 'collective:client-work-policy-reply',
              result: {
                state: 'failed',
                code: cause instanceof HostWorkPolicyCommandError ? 'permission_changed' : 'unconfirmed',
                message: '更改未成功，当前授权或连接可能已变化。请重新读取后重试。',
              },
            },
            event.origin,
          );
        })
        .finally(() => pending.current.delete(command.commandId));
      pending.current.set(command.commandId, operation);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  return useCallback((work: CollectiveWorkProjection) => {
    const current = live.current;
    const active = current.context.current;
    const bridge = active.bridge;
    if (
      !bridge ||
      !current.hostOrigin ||
      active.revision < 1 ||
      !current.request ||
      bridge.authorityStatus !== 'connected' ||
      work.lifecycle !== 'proposed' ||
      work.proposedBy.kind !== 'agent' ||
      work.proposedBy.connectionId !== bridge.connectionId ||
      work.proposedBy.humanId !== bridge.humanId ||
      !work.proposedRequestKind
    )
      return;
    window.parent.postMessage(
      {
        type: 'collective:client-work-permission-request',
        bridgeId: bridge.bridgeId,
        contextId: active.contextId,
        contextRevision: active.revision,
        serviceInstanceId: bridge.serviceInstanceId,
        collectiveId: bridge.collectiveId,
        connectionId: bridge.connectionId,
        humanId: bridge.humanId,
        workId: work.workId,
        workRevision: work.revision,
        sourceEventId: work.sourceEventId,
        channelId: work.sourceLocation.channelId,
        catId: work.proposedBy.catId,
        requestKind: work.proposedRequestKind,
        title: work.title,
      },
      current.hostOrigin,
    );
  }, []);
}
function matches(
  value: {
    bridgeId: string;
    contextId: string;
    contextRevision: number;
    serviceInstanceId: string;
    collectiveId: string;
    connectionId: string;
    humanId: string;
  },
  active: { bridge?: CollectiveHostContextInit; contextId: string; revision: number },
) {
  return (
    value.bridgeId === active.bridge?.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision &&
    value.serviceInstanceId === active.bridge.serviceInstanceId &&
    value.collectiveId === active.bridge.collectiveId &&
    value.connectionId === active.bridge.connectionId &&
    value.humanId === active.bridge.humanId
  );
}
function commandCoordinates(command: ReturnType<typeof collectiveHostWorkPolicyCommandSchema.parse>) {
  const { action: _action, type: _type, ...coordinates } = command;
  return coordinates;
}
