import {
  type CollectiveClientContext,
  type CollectiveDocumentRef,
  type CollectiveDocumentRequest,
  type CollectiveDocumentResult,
  type CollectiveDocumentTarget,
  collectiveDocumentBridgeSchema,
  collectiveDocumentClientReadySchema,
  collectiveDocumentOpenSchema,
  collectiveDocumentRequestSchema,
  collectiveDocumentResultSchema,
  collectiveDocumentTargetSchema,
} from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';
import { registerCollectiveDocumentPort } from './collective-document-port';

export function documentBridgeMatches(
  ref: CollectiveDocumentRef,
  context: CollectiveClientContext | undefined,
  connection: CollectiveConnectionProjection | undefined,
) {
  return Boolean(
    context &&
      connection &&
      connection.authorityStatus === 'connected' &&
      ref.bridgeId === context.bridgeId &&
      ref.contextId === context.contextId &&
      ref.contextRevision === context.revision &&
      ref.serviceInstanceId === connection.serviceInstanceId &&
      ref.collectiveId === connection.collectiveId &&
      ref.connectionId === connection.connectionId &&
      ref.humanId === connection.authorizedHumanId &&
      ref.serviceInstanceId === context.serviceInstanceId &&
      ref.collectiveId === context.collectiveId &&
      ref.humanId === context.humanId &&
      context.channelIds.includes(ref.channelId),
  );
}

export function useCollectiveDocumentBridge(options: {
  iframe: RefObject<HTMLIFrameElement>;
  connection?: CollectiveConnectionProjection;
  context?: CollectiveClientContext;
  onOpen(target: CollectiveDocumentTarget, hostKey: string): void;
  onReturn(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(new Map<string, { ref: string; finish(result: CollectiveDocumentResult): void }>());
  const connection = options.connection,
    context = options.context;
  const hostKey =
    connection &&
    JSON.stringify([
      'collective',
      connection.serviceInstanceId,
      connection.collectiveId,
      connection.connectionId,
      connection.authorizedHumanId,
    ]);
  const epoch = JSON.stringify([context, connection?.authorityStatus, hostKey]);
  useEffect(() => {
    if (!hostKey || !connection || !context) return;
    let unregister: (() => void) | undefined;
    const reference = (target: CollectiveDocumentTarget): CollectiveDocumentRef | undefined => {
      const active = latest.current;
      if (!active.context) return;
      const ref = {
        ...target,
        bridgeId: active.context.bridgeId,
        contextId: active.context.contextId,
        contextRevision: active.context.revision,
      };
      return documentBridgeMatches(ref, active.context, active.connection) ? ref : undefined;
    };
    const post = (message: unknown) => {
      const active = latest.current;
      if (active.connection)
        active.iframe.current?.contentWindow?.postMessage(message, new URL(active.connection.serviceUrl).origin);
    };
    const request = async (
      target: CollectiveDocumentTarget,
      operation: CollectiveDocumentRequest['operation'],
    ): Promise<CollectiveDocumentResult> => {
      const ref = reference(target);
      if (!ref || pending.current.size >= 8) return { kind: 'error', code: 'access_denied' };
      const message = collectiveDocumentRequestSchema.parse({
        type: 'collective:host-document-request',
        ref,
        requestId: crypto.randomUUID(),
        operation,
      });
      return new Promise((resolve) => {
        const finish = (result: CollectiveDocumentResult) => {
          clearTimeout(timer);
          pending.current.delete(message.requestId);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ kind: 'error', code: 'unavailable' }), 15_000);
        pending.current.set(message.requestId, { ref: JSON.stringify(ref), finish });
        post(message);
      });
    };
    const listener = (event: MessageEvent<unknown>) => {
      const active = latest.current;
      if (
        !active.connection ||
        event.source !== active.iframe.current?.contentWindow ||
        event.origin !== new URL(active.connection.serviceUrl).origin
      )
        return;
      const ready = collectiveDocumentClientReadySchema.safeParse(event.data);
      if (
        ready.success &&
        active.context &&
        ready.data.bridgeId === active.context.bridgeId &&
        ready.data.contextId === active.context.contextId &&
        ready.data.contextRevision === active.context.revision &&
        ready.data.serviceInstanceId === active.connection.serviceInstanceId &&
        ready.data.collectiveId === active.connection.collectiveId &&
        ready.data.connectionId === active.connection.connectionId &&
        ready.data.humanId === active.connection.authorizedHumanId &&
        active.connection.authorityStatus === 'connected'
      ) {
        unregister ??= registerCollectiveDocumentPort({
          hostKey,
          matches: (target) => Boolean(reference(target)),
          request,
          returnTo: (target, destination) => {
            const ref = reference(target);
            if (!ref) return false;
            post({ type: 'collective:host-document-return', ref, destination });
            latest.current.onReturn();
            return true;
          },
        });
        // Project an already strict-validated envelope onto its public bridge coordinates.
        post({ type: 'collective:host-document-ready', ...collectiveDocumentBridgeSchema.strip().parse(ready.data) });
        return;
      }
      const opened = collectiveDocumentOpenSchema.safeParse(event.data);
      if (opened.success && documentBridgeMatches(opened.data.ref, active.context, active.connection)) {
        active.onOpen(collectiveDocumentTargetSchema.strip().parse(opened.data.ref), hostKey);
        return;
      }
      const result = collectiveDocumentResultSchema.safeParse(event.data);
      if (!result.success || !documentBridgeMatches(result.data.ref, active.context, active.connection)) return;
      const waiting = pending.current.get(result.data.requestId);
      if (waiting?.ref === JSON.stringify(result.data.ref)) waiting.finish(result.data.result);
    };
    window.addEventListener('message', listener);
    return () => {
      unregister?.();
      window.removeEventListener('message', listener);
      for (const job of pending.current.values()) job.finish({ kind: 'error', code: 'access_denied' });
      pending.current.clear();
    };
  }, [epoch, hostKey]);
}
