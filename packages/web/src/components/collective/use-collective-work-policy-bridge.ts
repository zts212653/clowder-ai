'use client';
import {
  type CollectiveClientContext,
  type CollectiveClientWorkPermissionRequest,
  type CollectiveHostWorkPolicyAction,
  type CollectiveWorkPolicyReceipt,
  collectiveClientWorkPermissionRequestSchema,
  collectiveClientWorkPolicyReplySchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';

export class CollectiveWorkPolicyConflict extends Error {
  readonly code = 'permission_changed';
}

interface Pending {
  resolve: (receipt: CollectiveWorkPolicyReceipt) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  context: CollectiveClientContext;
}
/** Exactly the existing frame + origin + current context generation, with no Service credentials in Host. */
export function useCollectiveWorkPolicyBridge(
  iframe: RefObject<HTMLIFrameElement>,
  connection?: CollectiveConnectionProjection,
  context?: CollectiveClientContext,
) {
  const [permissionRequest, setPermissionRequest] = useState<CollectiveClientWorkPermissionRequest>();
  const live = useRef({ connection, context });
  live.current = { connection, context };
  const pending = useRef(new Map<string, Pending>());
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const current = live.current;
      if (
        !current.connection ||
        !current.context ||
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(current.connection.serviceUrl).origin
      )
        return;
      const request = collectiveClientWorkPermissionRequestSchema.safeParse(event.data);
      if (request.success) {
        if (
          matches(request.data, current.connection, current.context) &&
          current.context.channelIds.includes(request.data.channelId)
        )
          setPermissionRequest(request.data);
        return;
      }
      const reply = collectiveClientWorkPolicyReplySchema.safeParse(event.data);
      if (!reply.success || !matches(reply.data, current.connection, current.context)) return;
      const operation = pending.current.get(reply.data.commandId);
      if (
        !operation ||
        operation.context.bridgeId !== reply.data.bridgeId ||
        operation.context.revision !== reply.data.contextRevision ||
        operation.context.contextId !== reply.data.contextId
      )
        return;
      pending.current.delete(reply.data.commandId);
      clearTimeout(operation.timer);
      if (reply.data.result.state === 'registered') operation.resolve(reply.data.result.receipt);
      else
        operation.reject(
          reply.data.result.code === 'permission_changed'
            ? new CollectiveWorkPolicyConflict(reply.data.result.message)
            : new Error(reply.data.result.message),
        );
    };
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      for (const operation of pending.current.values()) {
        clearTimeout(operation.timer);
        operation.reject(new Error('页面已变化，登记结果尚未确认。请重新读取。'));
      }
      pending.current.clear();
    };
  }, [iframe]);
  useEffect(() => {
    setPermissionRequest(undefined);
  }, [context?.bridgeId, context?.contextId, context?.channelId]);
  const command = useCallback(
    (action: CollectiveHostWorkPolicyAction): Promise<CollectiveWorkPolicyReceipt> => {
      const { connection, context } = live.current;
      if (!connection || !context || connection.authorityStatus !== 'connected')
        return Promise.reject(new Error('请先连接当前 Café 并登录共同体。'));
      const key = `collective-human-change:${connection.connectionId}:${context.humanId}:${JSON.stringify(action)}`;
      const commandId = localStorage.getItem(key) ?? crypto.randomUUID();
      localStorage.setItem(key, commandId);
      const existing = pending.current.get(commandId);
      if (existing) return Promise.reject(new Error('这项更改仍在确认，请稍后。'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.current.delete(commandId);
          reject(new Error('暂未确认登记结果；重试将核对同一次更改。'));
        }, 15_000);
        pending.current.set(commandId, { context, timer, resolve, reject });
        iframe.current?.contentWindow?.postMessage(
          {
            type: 'collective:host-work-policy-command',
            commandId,
            action,
            bridgeId: context.bridgeId,
            contextId: context.contextId,
            contextRevision: context.revision,
            serviceInstanceId: connection.serviceInstanceId,
            collectiveId: connection.collectiveId,
            connectionId: connection.connectionId,
            humanId: context.humanId,
          },
          new URL(connection.serviceUrl).origin,
        );
      });
    },
    [iframe],
  );
  const acknowledge = (action: CollectiveHostWorkPolicyAction) => {
    const current = live.current;
    if (current.connection && current.context)
      localStorage.removeItem(
        `collective-human-change:${current.connection.connectionId}:${current.context.humanId}:${JSON.stringify(action)}`,
      );
  };
  return {
    command,
    acknowledge,
    newDecision: acknowledge,
    permissionRequest,
    clearPermissionRequest: () => setPermissionRequest(undefined),
  };
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
  connection: CollectiveConnectionProjection,
  context: CollectiveClientContext,
) {
  return (
    value.bridgeId === context.bridgeId &&
    value.contextId === context.contextId &&
    value.contextRevision === context.revision &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.connectionId === connection.connectionId &&
    value.humanId === connection.authorizedHumanId &&
    value.humanId === context.humanId
  );
}
export type CollectiveWorkPolicyBridge = ReturnType<typeof useCollectiveWorkPolicyBridge>;
