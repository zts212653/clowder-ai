import {
  type CollectiveClientContext,
  type CollectiveDocumentRequest,
  collectiveDocumentTargetSchema,
} from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCollectiveDocumentSurface,
  resolveCollectiveDocumentTarget,
} from '../../workbench/collective-document-surface';
import type { CollectiveConnectionProjection } from '../collective-client';
import { findCollectiveDocumentPort } from '../collective-document-port';
import { documentBridgeMatches, useCollectiveDocumentBridge } from '../use-collective-document-bridge';

const target = collectiveDocumentTargetSchema.parse({
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  connectionId: 'connection',
  humanId: 'human',
  artifactId: 'artifact',
  sourceEventId: 'source',
  channelId: 'general',
  ownerRevision: 2,
  projectReturn: { roadmapId: 'project-a', referenceId: 'reference-a', channelId: 'project-channel' },
});
const ref = { ...target, bridgeId: 'bridge-123', contextId: 'context-123', contextRevision: 1 };
const context: CollectiveClientContext = {
  type: 'collective:client-context',
  bridgeId: ref.bridgeId,
  contextId: ref.contextId,
  revision: 1,
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  humanId: 'human',
  channelId: 'general',
  channelIds: ['general'],
  openCafe: false,
};
const connection = {
  ...target,
  authorizedHumanId: 'human',
  authorityStatus: 'connected',
  serviceUrl: 'https://collective.example',
} as unknown as CollectiveConnectionProjection;
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

it('stores only a real owner locator in the common Workspace tab and rejects forged native-file identities', () => {
  const surface = createCollectiveDocumentSurface({ target, hostKey: 'host' });
  expect(surface.renderer).toBe('file-preview');
  expect(resolveCollectiveDocumentTarget(surface)).toEqual({ target, hostKey: 'host' });
  expect(JSON.stringify(surface)).not.toContain('OWNER-BYTES');
  expect(resolveCollectiveDocumentTarget({ ...surface, objectRef: { kind: 'file', id: 'fake-worktree' } })).toBeNull();
  expect(
    resolveCollectiveDocumentTarget({
      ...surface,
      resultTargetRef: { owner: 'f063-workspace-file', key: surface.ownerStateRef.key },
    }),
  ).toBeNull();
});

it('accepts only the current human, connection, channel and bridge generation', () => {
  expect(documentBridgeMatches(ref, context, connection)).toBe(true);
  for (const changed of [
    { humanId: 'other' },
    { connectionId: 'other' },
    { bridgeId: 'old-bridge' },
    { contextRevision: 2 },
    { channelId: 'private' },
    { collectiveId: 'other' },
  ])
    expect(documentBridgeMatches({ ...ref, ...changed }, context, connection)).toBe(false);
  expect(documentBridgeMatches(ref, context, { ...connection, authorityStatus: 'revoked' })).toBe(false);
});

it('binds the exact iframe, rejects stale responses and resolves pending calls as denied when authority changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onOpen = vi.fn(),
    onReturn = vi.fn();
  function Harness({ revision = 1 }) {
    const iframe = useRef<HTMLIFrameElement>(null);
    useCollectiveDocumentBridge({ iframe, connection, context: { ...context, revision }, onOpen, onReturn });
    return <iframe ref={iframe} title="Collective" />;
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  const frame = container.querySelector('iframe')!.contentWindow!,
    post = vi.spyOn(frame, 'postMessage');
  const message = async (data: unknown, origin = connection.serviceUrl, source: MessageEventSource | null = frame) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    });
  const ready = {
    bridgeId: ref.bridgeId,
    contextId: ref.contextId,
    contextRevision: ref.contextRevision,
    serviceInstanceId: ref.serviceInstanceId,
    collectiveId: ref.collectiveId,
    connectionId: ref.connectionId,
    humanId: ref.humanId,
  };
  await message({ type: 'collective:client-document-ready', ...ready }, 'https://foreign.example');
  expect(post).not.toHaveBeenCalled();
  await message({ type: 'collective:client-document-ready', ...ready, unrecognizedAuthority: true });
  expect(post).not.toHaveBeenCalled();
  await message({ type: 'collective:client-document-ready', ...ready });
  const hostKey = JSON.stringify([
    'collective',
    target.serviceInstanceId,
    target.collectiveId,
    target.connectionId,
    target.humanId,
  ]);
  const port = findCollectiveDocumentPort(hostKey, target)!;
  expect(port).toBeTruthy();
  await message({ type: 'collective:client-document-open', ref }, connection.serviceUrl, null);
  expect(onOpen).not.toHaveBeenCalled();
  await message({ type: 'collective:client-document-open', ref });
  expect(onOpen).toHaveBeenCalledWith(target, hostKey);
  const pending = port.request(target, { kind: 'read', ownerRevision: 2 });
  const request = post.mock.calls
    .map((call) => call[0] as CollectiveDocumentRequest)
    .find((value) => value.type === 'collective:host-document-request')!;
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await message({
    type: 'collective:client-document-result',
    requestId: request.requestId,
    ref: { ...ref, humanId: 'other' },
    result: { kind: 'error', code: 'unavailable' },
  });
  expect(settled).toBe(false);
  await act(async () => root!.render(<Harness revision={2} />));
  expect(await pending).toEqual({ kind: 'error', code: 'access_denied' });
  expect(findCollectiveDocumentPort(hostKey, target)).toBeUndefined();
});
