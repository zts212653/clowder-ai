import {
  type CollectiveClientContext,
  type CollectiveMediaSurfaceRefV1,
  type CollectiveMediaSurfaceRequest,
  type CollectiveMediaSurfaceResult,
  collectiveMediaSurfaceRefKey,
  collectiveMediaSurfaceRequestSchema,
  collectiveMediaSurfaceResultSchema,
} from '@cat-cafe/shared';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { CollectiveConnectionProjection } from './collective-client';
import { mediaSurfaceRefMatches } from './collective-media-surface-ref';

export class CollectiveMediaRpcError extends Error {
  constructor(readonly code: 'access_denied' | 'owner_unavailable' | 'conflict' | 'unavailable') {
    super(code);
  }
}
export function collectiveMediaErrorMessage(failure: unknown) {
  if (failure instanceof CollectiveMediaRpcError)
    return {
      access_denied: '你已无法查看这件作品。',
      owner_unavailable: '内容所在的 Café 暂时不可用。',
      conflict: '讨论已变化，请重新读取后再操作。',
      unavailable: '暂时无法读取作品，请重试。',
    }[failure.code];
  return failure instanceof Error ? failure.message : '作品读取未完成。';
}
export type CollectiveMediaRpc = (
  operation: CollectiveMediaSurfaceRequest['operation'],
) => Promise<CollectiveMediaSurfaceResult['result']>;
export function useCollectiveMediaRpc(
  iframe: RefObject<HTMLIFrameElement>,
  connection: CollectiveConnectionProjection | undefined,
  context: CollectiveClientContext | undefined,
  ref: CollectiveMediaSurfaceRefV1 | undefined,
): CollectiveMediaRpc {
  const current = useRef({ connection, context, ref });
  current.current = { connection, context, ref };
  const pending = useRef(
    new Map<
      string,
      {
        ref: string;
        finish: (result: CollectiveMediaSurfaceResult['result']) => void;
      }
    >(),
  );
  const key = ref && collectiveMediaSurfaceRefKey(ref);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different exact media visit must close and reject its pending RPCs, even though the listener reads current refs.
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const active = current.current;
      if (
        !active.connection ||
        event.source !== iframe.current?.contentWindow ||
        event.origin !== new URL(active.connection.serviceUrl).origin
      )
        return;
      const parsed = collectiveMediaSurfaceResultSchema.safeParse(event.data);
      if (
        !parsed.success ||
        !mediaSurfaceRefMatches(parsed.data.ref, active.context, active.connection) ||
        !active.ref ||
        collectiveMediaSurfaceRefKey(parsed.data.ref) !== collectiveMediaSurfaceRefKey(active.ref)
      )
        return;
      const waiting = pending.current.get(parsed.data.requestId);
      if (waiting?.ref === collectiveMediaSurfaceRefKey(parsed.data.ref)) waiting.finish(parsed.data.result);
    };
    window.addEventListener('message', listener);
    const requests = pending.current;
    return () => {
      window.removeEventListener('message', listener);
      for (const request of requests.values()) request.finish({ kind: 'error', code: 'access_denied' });
      requests.clear();
    };
  }, [iframe, key]);
  return useCallback(
    async (operation) => {
      const active = current.current,
        frame = iframe.current?.contentWindow;
      if (
        !frame ||
        !active.ref ||
        !active.connection ||
        !mediaSurfaceRefMatches(active.ref, active.context, active.connection)
      )
        throw new CollectiveMediaRpcError('access_denied');
      if (pending.current.size >= 8) throw new CollectiveMediaRpcError('unavailable');
      const message = collectiveMediaSurfaceRequestSchema.parse({
        type: 'collective:host-media-request',
        ref: active.ref,
        requestId: crypto.randomUUID(),
        operation,
      });
      const origin = new URL(active.connection.serviceUrl).origin;
      const result = await new Promise<CollectiveMediaSurfaceResult['result']>((resolve) => {
        const finish = (value: CollectiveMediaSurfaceResult['result']) => {
          clearTimeout(timer);
          pending.current.delete(message.requestId);
          resolve(value);
        };
        const timer = setTimeout(() => finish({ kind: 'error', code: 'unavailable' }), 15_000);
        pending.current.set(message.requestId, { ref: collectiveMediaSurfaceRefKey(message.ref), finish });
        frame.postMessage(message, origin);
      });
      if (result.kind === 'error') throw new CollectiveMediaRpcError(result.code);
      return result;
    },
    [iframe],
  );
}
