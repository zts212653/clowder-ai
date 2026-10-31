import { collectiveClientContextSchema } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollectiveConnectionProjection } from '../collective-client';
import { useCollectiveContextBridge } from '../use-collective-context-bridge';
import { useCollectiveMediaShare } from '../use-collective-media-share';

const service = 'https://collective.example';
const scope = { serviceInstanceId: 'svc_12345678', collectiveId: 'col_12345678', connectionId: 'con_12345678' };
const connection: CollectiveConnectionProjection = {
  ...scope,
  serviceUrl: service,
  authorizedHumanId: 'human_12345678',
  endpointId: 'ep_12345678',
  endpointLabel: '自己的 Café',
  authorityStatus: 'connected',
  liveStatus: 'online',
  lastAckedSequence: 1,
  canonicalClientAnchor: { kind: 'collective-client', ...scope, serviceUrl: service, clientBuildId: 'test-build' },
  outbox: { queued: 0, accepted: 0 },
  route: { configured: true },
  inbox: { persisted: 1, pending: 0, routed: 1, failed: 0 },
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
function Harness({ selected = connection }: { selected?: CollectiveConnectionProjection }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useCollectiveContextBridge(iframe, selected);
  const share = useCollectiveMediaShare(iframe, selected, bridge.context);
  const media = 'mediaRef' in bridge ? bridge.mediaRef : undefined;
  return (
    <>
      <iframe ref={iframe} title="Collective" />
      <output>{media && typeof media === 'object' && 'artifactId' in media ? String(media.artifactId) : ''}</output>
      <output data-share>{share.reference?.sourceEventId ?? ''}</output>
      <button type="button" data-close-share onClick={() => share.finish()}>
        取消分享
      </button>
      <button
        type="button"
        onClick={() => {
          if ('closeMedia' in bridge && typeof bridge.closeMedia === 'function') bridge.closeMedia();
        }}
      >
        返回原讨论
      </button>
    </>
  );
}
async function start() {
  await act(async () => root.render(<Harness />));
  const frame = container.querySelector('iframe');
  if (!frame?.contentWindow) throw new Error('Missing frame');
  const post = vi.spyOn(frame.contentWindow, 'postMessage');
  const message = async (data: unknown, origin = service, source = frame.contentWindow) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    });
  };
  await message({ type: 'collective:context-ready' });
  const init = post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0];
  if (!init) throw new Error('Missing bridge initialization');
  const context = {
    type: 'collective:client-context',
    bridgeId: init.bridgeId,
    contextId: 'context-12345678',
    revision: 1,
    serviceInstanceId: scope.serviceInstanceId,
    collectiveId: scope.collectiveId,
    humanId: connection.authorizedHumanId,
    channelId: 'general',
    channelIds: ['general'],
    openCafe: false,
  };
  await message(context);
  const ref = {
    v: 1,
    bridgeId: context.bridgeId,
    contextId: context.contextId,
    contextRevision: 1,
    ...scope,
    humanId: connection.authorizedHumanId,
    channelId: 'general',
    artifactId: 'artifact_example',
    sourceEventId: 'evt_12345678',
    ownerRevision: 1,
  };
  return { ref, context, message, post };
}

it('accepts a separate versioned media reference from the current iframe without changing strict client-context', async () => {
  const f = await start();
  await f.message({ type: 'collective:client-media-surface', ref: f.ref });
  expect(container.querySelector('output')?.textContent).toBe(f.ref.artifactId);
  expect(collectiveClientContextSchema.safeParse({ ...f.context, mediaRef: f.ref }).success).toBe(false);
});

it('opens the private Host picker only for the exact iframe/context and clears it when the context advances', async () => {
  const f = await start();
  const ref = Object.fromEntries(
    Object.entries(f.ref).filter(([key]) => !['artifactId', 'ownerRevision'].includes(key)),
  );
  const data = { type: 'collective:client-media-share', ref };
  for (const changed of [
    { connectionId: 'con_other123' },
    { humanId: 'human_other123' },
    { contextRevision: 2 },
    { contentRef: 'private' },
    { credential: 'borrowed' },
  ]) {
    await f.message({ ...data, ref: { ...ref, ...changed } });
    expect(container.querySelector('[data-share]')?.textContent).toBe('');
  }
  await f.message(data, 'https://foreign.example');
  await f.message(data, service, null);
  expect(container.querySelector('[data-share]')?.textContent).toBe('');
  await f.message(data);
  expect(container.querySelector('[data-share]')?.textContent).toBe(ref.sourceEventId);
  await f.message({ ...f.context, revision: 2 });
  expect(container.querySelector('[data-share]')?.textContent).toBe('');
  await f.message({ ...data, ref: { ...ref, contextRevision: 2 } });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-close-share]')?.click());
  expect(f.post.mock.calls.at(-1)?.[0]).toMatchObject({
    type: 'collective:host-media-shared',
    ref: { contextRevision: 2 },
  });
  expect(f.post.mock.calls.at(-1)?.[0]).not.toHaveProperty('artifact');
});

it.each([
  { v: 2 },
  { bridgeId: 'old-bridge-12345678' },
  { contextId: 'old-context-12345678' },
  { contextRevision: 2 },
  { serviceInstanceId: 'svc_foreign123' },
  { collectiveId: 'col_foreign123' },
  { humanId: 'human_foreign123' },
  { connectionId: 'con_other-cafe123' },
  { channelId: 'another-channel' },
  { ownerRevision: 0 },
  { contentRef: 'private-content-ref' },
  { path: '/private/source.png' },
  { credential: 'borrowed-secret' },
])('rejects a forged or stale media reference %j', async (changed) => {
  const f = await start();
  await f.message({ type: 'collective:client-media-surface', ref: { ...f.ref, ...changed } });
  expect(container.querySelector('output')?.textContent).toBe('');
});

it('rejects a foreign origin or another window even when every public coordinate matches', async () => {
  const f = await start();
  const data = { type: 'collective:client-media-surface', ref: f.ref };
  await f.message(data, 'https://foreign.example');
  await f.message(data, service, window);
  expect(container.querySelector('output')?.textContent).toBe('');
});

it('invalidates the media surface when its context advances or its Cafe is revoked', async () => {
  const f = await start();
  await f.message({ type: 'collective:client-media-surface', ref: f.ref });
  expect(container.querySelector('output')?.textContent).toBe(f.ref.artifactId);
  await f.message({ ...f.context, revision: 2 });
  expect(container.querySelector('output')?.textContent).toBe('');
  await f.message({ type: 'collective:client-media-surface', ref: f.ref });
  expect(container.querySelector('output')?.textContent).toBe('');
  await f.message({ type: 'collective:client-media-surface', ref: { ...f.ref, contextRevision: 2 } });
  expect(container.querySelector('output')?.textContent).toBe(f.ref.artifactId);
  await act(async () => root.render(<Harness selected={{ ...connection, authorityStatus: 'revoked' }} />));
  expect(container.querySelector('output')?.textContent).toBe('');
});

it('returns the same public source ref and keeps the original iframe mounted', async () => {
  const f = await start();
  const iframe = container.querySelector('iframe');
  await f.message({ type: 'collective:client-media-surface', ref: f.ref });
  await act(async () => container.querySelector<HTMLButtonElement>('button:not([data-close-share])')?.click());
  expect(container.querySelector('output')?.textContent).toBe('');
  expect(container.querySelector('iframe')).toBe(iframe);
  expect(f.post.mock.calls.find(([body]) => body.type === 'collective:host-media-return')).toEqual([
    { type: 'collective:host-media-return', ref: f.ref },
    service,
  ]);
});
