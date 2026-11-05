import type { CollectiveClientContext, CollectiveMediaSurfaceRequest } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mediaProjection,
  mediaRef,
} from '../../../../../collective-client/src/__tests__/collective-media-surface.fixture';
import type { CollectiveConnectionProjection } from '../collective-client';
import { type CollectiveMediaRpc, useCollectiveMediaRpc } from '../use-collective-media-rpc';

const connection = {
  serviceInstanceId: mediaRef.serviceInstanceId,
  collectiveId: mediaRef.collectiveId,
  connectionId: mediaRef.connectionId,
  authorizedHumanId: mediaRef.humanId,
  authorityStatus: 'connected',
  serviceUrl: 'https://service.example',
} as CollectiveConnectionProjection;
const context: CollectiveClientContext = {
  type: 'collective:client-context',
  bridgeId: mediaRef.bridgeId,
  contextId: mediaRef.contextId,
  revision: 1,
  serviceInstanceId: mediaRef.serviceInstanceId,
  collectiveId: mediaRef.collectiveId,
  humanId: mediaRef.humanId,
  channelId: mediaRef.channelId,
  channelIds: [mediaRef.channelId],
  openCafe: false,
};
let root: Root, container: HTMLDivElement, rpc: CollectiveMediaRpc;
function Harness({ revision = 1 }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  rpc = useCollectiveMediaRpc(iframe, connection, { ...context, revision }, { ...mediaRef, contextRevision: revision });
  return <iframe ref={iframe} title="Collective" />;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const page = { annotationOffset: 0, annotationLimit: 2, replyOffset: 0, requestOffset: 0, requestLimit: 30, cursor: 0 };

it('discloses only the matched current iframe response, including refs with reordered object keys', async () => {
  const frame = container.querySelector('iframe')?.contentWindow;
  if (!frame) throw new Error('missing frame');
  const post = vi.spyOn(frame, 'postMessage');
  const result = rpc({ kind: 'read', page });
  const request = post.mock.calls[0]?.[0] as CollectiveMediaSurfaceRequest;
  const response = {
    type: 'collective:client-media-result',
    requestId: request.requestId,
    ref: Object.fromEntries(Object.entries(mediaRef).reverse()),
    result: { kind: 'read', value: mediaProjection() },
  };
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const message = (data: unknown, source: MessageEventSource | null = frame, origin = connection.serviceUrl) =>
    act(async () => window.dispatchEvent(new MessageEvent('message', { data, source, origin })));
  await message(response, null);
  await message(response, frame, 'https://foreign.example');
  await message({ ...response, requestId: crypto.randomUUID() });
  await message({ ...response, ref: { ...mediaRef, collectiveId: 'col_87654321' } });
  await message({
    ...response,
    result: { kind: 'read', value: { ...mediaProjection(), ownerUserId: 'private-owner' } },
  });
  expect(settled).toBe(false);
  await message(response);
  expect(await result).toMatchObject({ kind: 'read' });
});

it('rejects a pending read when its exact context is replaced and refuses extra private fields', async () => {
  const frame = container.querySelector('iframe')?.contentWindow;
  if (!frame) throw new Error('missing frame');
  const post = vi.spyOn(frame, 'postMessage');
  const pending = rpc({ kind: 'read', page });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'access_denied' });
  const request = post.mock.calls[0]?.[0] as CollectiveMediaSurfaceRequest;
  await act(async () => root.render(<Harness revision={2} />));
  await rejected;
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame,
        origin: connection.serviceUrl,
        data: {
          type: 'collective:client-media-result',
          requestId: request.requestId,
          ref: mediaRef,
          result: { kind: 'read', value: { ...mediaProjection(), ownerUserId: 'private-owner' } },
        },
      }),
    ),
  );
});
