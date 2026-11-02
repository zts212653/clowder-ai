// @vitest-environment jsdom

import { collectiveDocumentBridgeSchema, collectiveMediaSurfaceRefV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { collectiveArtifactClient, SharedArtifactOpenOptions } from '../collective-artifact-client.js';
import { useHostContext } from '../use-host-context.js';
import { mediaArtifact, mediaProjection } from './collective-media-surface.fixture.js';
import { snapshot } from './first-entry-fixture.js';

const origin = 'https://host.example';
const container = document.createElement('div'),
  root = createRoot(container);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
});
const value = {
  ...snapshot,
  collaboration: {
    serviceInstanceId: mediaArtifact.serviceInstanceId,
    collectiveId: mediaArtifact.collectiveId,
    works: [],
    roadmaps: [],
    votes: [],
    bindingVotes: [],
    decisions: [],
  },
};
const returned = vi.fn();
const shared = vi.fn(async () => {});
const operation = vi.fn(async () => mediaProjection());
function Harness({
  channel = 'general',
  projectReturn,
}: {
  channel?: string;
  projectReturn?: SharedArtifactOpenOptions['projectReturn'];
}) {
  const host = useHostContext(true, value, channel, ['general', 'other'], undefined, {
    api: { operation } as unknown as ReturnType<typeof collectiveArtifactClient>,
    selection: { artifact: mediaArtifact, ownerRevision: 1, options: { projectReturn }, onReturn: returned },
    onShared: shared,
  });
  return (
    <button type="button" onClick={() => host.shareMedia?.(mediaArtifact.sourceEventId)}>
      分享媒体
    </button>
  );
}
async function start(channel = 'general', projectReturn?: SharedArtifactOpenOptions['projectReturn']) {
  operation.mockReset();
  operation.mockImplementation(async () => mediaProjection());
  returned.mockClear();
  shared.mockClear();
  window.history.replaceState({}, '', `/?hostOrigin=${encodeURIComponent(origin)}`);
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => root.render(<Harness channel={channel} projectReturn={projectReturn} />));
  const message = async (data: unknown, from = origin, source: MessageEventSource | null = window.parent) => {
    await act(async () => window.dispatchEvent(new MessageEvent('message', { data, origin: from, source })));
  };
  await message({
    type: 'collective:host-context-init',
    bridgeId: 'bridge_12345678',
    serviceInstanceId: mediaArtifact.serviceInstanceId,
    collectiveId: mediaArtifact.collectiveId,
    connectionId: 'con_12345678',
    humanId: snapshot.me?.human.humanId,
    authorityStatus: 'connected',
  });
  return { post, message };
}
const openMessage = (post: Awaited<ReturnType<typeof start>>['post']) =>
  post.mock.calls.find(
    ([body]) =>
      typeof body === 'object' && body !== null && 'type' in body && body.type === 'collective:client-media-surface',
  )?.[0];

it('keeps project media readable by a strict old Host before the new owner-backed capability is acknowledged', async () => {
  const f = await start('general', { roadmapId: 'project-a', channelId: 'general' });
  const ref = openMessage(f.post).ref;
  const oldHostRef = collectiveMediaSurfaceRefV1Schema.omit({ projectReturn: true });
  expect(oldHostRef.parse(ref)).toEqual(ref);
  await f.message({ type: 'collective:host-media-return', ref });
  expect(returned).toHaveBeenCalledOnce();
});

it('binds project return coordinates after a new Host acknowledgement and updates them for the same original version', async () => {
  const firstProject = { roadmapId: 'project-a', channelId: 'general' };
  const f = await start('general', firstProject);
  const ready = f.post.mock.calls.find(([body]) => body.type === 'collective:client-document-ready')![0];
  await f.message({ ...collectiveDocumentBridgeSchema.strip().parse(ready), type: 'collective:host-document-ready' });
  const lastRef = () =>
    f.post.mock.calls.filter(([body]) => body.type === 'collective:client-media-surface').at(-1)![0].ref;
  expect(lastRef().projectReturn).toEqual(firstProject);
  const secondProject = { roadmapId: 'project-b', channelId: 'general' };
  await act(async () => root.render(<Harness projectReturn={secondProject} />));
  expect(lastRef().projectReturn).toEqual(secondProject);
});

it('publishes a media ref only after the actual source channel context advances, and preserves the strict base message', async () => {
  const f = await start('other');
  expect(openMessage(f.post)).toBeUndefined();
  await act(async () => root.render(<Harness />));
  const opened = openMessage(f.post);
  expect(opened).toMatchObject({
    ref: { channelId: 'general', artifactId: mediaArtifact.artifactId, ownerRevision: 1 },
  });
  const context = f.post.mock.calls.filter(([body]) => body.type === 'collective:client-context').at(-1)?.[0];
  expect(opened.ref.contextRevision).toBe(context.revision);
  expect(context).not.toHaveProperty('mediaRef');
});

it('serves metadata with the original iframe Human transport and refuses forged, foreign or stale Host requests', async () => {
  const f = await start(),
    opened = openMessage(f.post);
  const request = {
    type: 'collective:host-media-request',
    ref: opened.ref,
    requestId: crypto.randomUUID(),
    operation: { kind: 'read', page: {} },
  };
  await f.message(request, 'https://foreign.example');
  await f.message(request, origin, null);
  await f.message({ ...request, ref: { ...request.ref, contextRevision: 0 } });
  expect(operation).not.toHaveBeenCalled();
  await f.message(request);
  expect(operation).toHaveBeenCalledOnce();
  const response = f.post.mock.calls.find(
    ([body]) => body.type === 'collective:client-media-result' && body.requestId === request.requestId,
  )?.[0];
  expect(response).toMatchObject({
    type: 'collective:client-media-result',
    ref: opened.ref,
    requestId: request.requestId,
    result: { kind: 'read', value: { contentRef: mediaArtifact.contentRef } },
  });
  expect(JSON.stringify(f.post.mock.calls)).not.toMatch(/ownerUserId|sourcePublication|credential|bearer/);
  await f.message({ type: 'collective:host-media-return', ref: opened.ref });
  expect(returned).toHaveBeenCalledOnce();
  await f.message(request);
  expect(operation).toHaveBeenCalledOnce();
});

it('does not disclose a slow old read after channel/context change', async () => {
  const f = await start(),
    opened = openMessage(f.post);
  let finish!: (value: ReturnType<typeof mediaProjection>) => void;
  operation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.message({
    type: 'collective:host-media-request',
    ref: opened.ref,
    requestId: crypto.randomUUID(),
    operation: { kind: 'read', page: {} },
  });
  await act(async () => root.render(<Harness channel="other" />));
  await act(async () => finish(mediaProjection()));
  expect(f.post.mock.calls.filter(([body]) => body.type === 'collective:client-media-result')).toHaveLength(0);
});

it('bounds transient Host metadata requests and does not start another owner read for a duplicate request', async () => {
  const f = await start(),
    opened = openMessage(f.post);
  const finish: Array<(value: ReturnType<typeof mediaProjection>) => void> = [];
  operation.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const input = {
    type: 'collective:host-media-request',
    ref: opened.ref,
    requestId: crypto.randomUUID(),
    operation: { kind: 'read', page: {} },
  };
  await f.message(input);
  await f.message(input);
  expect(operation).toHaveBeenCalledOnce();
  for (let index = 0; index < 8; index++) await f.message({ ...input, requestId: crypto.randomUUID() });
  expect(operation).toHaveBeenCalledTimes(8);
  expect(
    f.post.mock.calls.filter(([body]) => body.type === 'collective:client-media-result').at(-1)?.[0],
  ).toMatchObject({ result: { kind: 'error', code: 'unavailable' } });
  await act(async () => {
    for (const resolve of finish) resolve(mediaProjection());
  });
});

it('invalidates the previous media ref when a new Host initialization does not match this authenticated Human', async () => {
  const f = await start(),
    opened = openMessage(f.post);
  await f.message({
    type: 'collective:host-context-init',
    bridgeId: 'bridge_other123',
    serviceInstanceId: mediaArtifact.serviceInstanceId,
    collectiveId: mediaArtifact.collectiveId,
    connectionId: 'con_12345678',
    humanId: 'human_87654321',
    authorityStatus: 'connected',
  });
  await f.message({
    type: 'collective:host-media-request',
    ref: opened.ref,
    requestId: crypto.randomUUID(),
    operation: { kind: 'read', page: {} },
  });
  expect(operation).not.toHaveBeenCalled();
});

it('opens a separate public share ref and consumes only the exact live Host result once', async () => {
  const f = await start();
  await act(async () => container.querySelector('button')?.click());
  const opened = f.post.mock.calls.find(([body]) => body.type === 'collective:client-media-share')?.[0];
  expect(opened.ref).toMatchObject({ sourceEventId: mediaArtifact.sourceEventId, channelId: 'general', v: 1 });
  expect(opened.ref).not.toHaveProperty('artifactId');
  expect(opened.ref).not.toHaveProperty('contentRef');
  const response = { type: 'collective:host-media-shared', ref: opened.ref, artifact: mediaArtifact };
  await f.message(response, 'https://foreign.example');
  await f.message(response, origin, null);
  await f.message({ ...response, ref: { ...opened.ref, contextRevision: opened.ref.contextRevision + 1 } });
  expect(shared).not.toHaveBeenCalled();
  await f.message(response);
  await f.message(response);
  expect(shared).toHaveBeenCalledExactlyOnceWith(mediaArtifact);
});

it('never consumes a retained share result after the authenticated Human bridge has been replaced', async () => {
  const f = await start();
  await act(async () => container.querySelector('button')?.click());
  const opened = f.post.mock.calls.find(([body]) => body.type === 'collective:client-media-share')?.[0];
  await f.message({
    type: 'collective:host-context-init',
    bridgeId: opened.ref.bridgeId,
    serviceInstanceId: opened.ref.serviceInstanceId,
    collectiveId: opened.ref.collectiveId,
    connectionId: opened.ref.connectionId,
    humanId: 'human_87654321',
    authorityStatus: 'connected',
  });
  await act(async () => root.render(<Harness channel="other" />));
  await f.message({ type: 'collective:host-media-shared', ref: opened.ref, artifact: mediaArtifact });
  expect(shared).not.toHaveBeenCalled();
});
