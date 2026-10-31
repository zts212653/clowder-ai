import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { applyHomeCommand } from '../home-action-bridge';
import { isHomePublicationVisible } from '../home-work-publication';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const source = {
  kind: 'message' as const,
  threadId: 'source',
  messageId: 'original',
  messageRevision: '1',
  expectedUrl: '/uploads/original.png',
  item: { kind: 'content-block' as const, index: 0 },
};
const artifact = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 1 };
const asset = {
  ...artifact,
  blobDigest: `sha256:${'b'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 20, height: 20 },
  ownerReceiptRef: 'receipt',
  sourcePublication: { artifactRef: source.expectedUrl, sourceRef: 'message:source:original', revision: '1' },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ports = () => ({
  token: '33333333-3333-4333-8333-333333333333',
  clientId: '11111111-1111-4111-8111-111111111111',
  clientToken: '22222222-2222-4222-8222-222222222222',
  signal: new AbortController().signal,
  navigate: vi.fn(),
  captureBeforeSettings: vi.fn(),
});
let ownerResponse: () => Promise<Response>;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  window.history.replaceState({}, '', '/thread/source');
  document.body.innerHTML = '<main data-thread-id="source"></main>';
  useChatStore.setState({
    currentThreadId: 'source',
    pendingChatInsert: null,
    workspaceOpenRequest: null,
    workspaceOpenRevision: 0,
  });
  ownerResponse = async () => response({ status: 'resolved', ownerUserId: 'owner', asset });
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (path) =>
      path.startsWith('/api/concierge/home/commands/')
        ? response({
            kind: 'navigate',
            clientId: ports().clientId,
            baseRoute: '/thread/source',
            expiresAt: Date.now() + 100,
            action: { kind: 'publication', source, artifact },
          })
        : ownerResponse(),
    );
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});
async function settle() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(16);
}

it('resolves the original item and exact version into F307 while a descriptor without owner-ready DOM stays unconfirmed', async () => {
  const result = applyHomeCommand(ports());
  await settle();
  expect((await result).status).toBe('unconfirmed');
  const request = vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/content-publications/resolve');
  expect(request).toBeDefined();
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ source, operationId: ports().token, selection: artifact });
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'publication',
    ...artifact,
    messagePublicationSource: source,
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes('/messages'))).toBe(false);
});
it('the original publication owner refusal prevents any Workspace open', async () => {
  ownerResponse = async () => response({ error: 'withdrawn' }, 403);
  expect((await applyHomeCommand(ports())).status).toBe('blocked');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});
it('a different returned version is not displayed in place of the selected original version', async () => {
  ownerResponse = async () =>
    response({ status: 'resolved', ownerUserId: 'owner', asset: { ...asset, ownerRevision: 2 } });
  expect((await applyHomeCommand(ports())).status).toBe('blocked');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});
it('a route change during the owner read cannot steal the new foreground', async () => {
  ownerResponse = async () => {
    window.history.pushState({}, '', '/thread/new-intent');
    return response({ status: 'resolved', ownerUserId: 'owner', asset });
  };
  expect((await applyHomeCommand(ports())).status).toBe('blocked');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});
it('ambiguous publications stay unconfirmed without choosing a sibling work', async () => {
  ownerResponse = async () => response({ status: 'choice-required', ownerUserId: 'owner', choices: [] });
  expect((await applyHomeCommand(ports())).status).toBe('unconfirmed');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});

it('the read-only F309 DOM seam requires every exact coordinate and removes loading, stale and hidden observations', () => {
  const node = document.createElement('section');
  node.dataset.testid = 'workspace-content-review-surface';
  node.dataset.contentRef = artifact.contentRef;
  node.dataset.ownerRevision = '1';
  document.body.append(node);
  vi.spyOn(node, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(false);
  node.dataset.contentReady = 'true';
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(true);
  expect(isHomePublicationVisible(artifact.contentRef, 2)).toBe(false);
  node.style.display = 'none';
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(false);
  node.style.display = '';
  delete node.dataset.ownerRevision;
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(false);
});
it('a comparison-hidden original image or metadata-only video cannot produce the exact-version display ACK', () => {
  const node = document.createElement('section');
  node.dataset.testid = 'workspace-content-review-surface';
  node.dataset.contentRef = artifact.contentRef;
  node.dataset.ownerRevision = '1';
  node.dataset.contentReady = 'true';
  document.body.append(node);
  vi.spyOn(node, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  const layer = document.createElement('div'),
    image = document.createElement('img');
  image.dataset.testid = 'workspace-content-review-media';
  layer.append(image);
  node.append(layer);
  vi.spyOn(image, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  Object.defineProperties(image, {
    complete: { value: true },
    naturalWidth: { value: 20 },
    naturalHeight: { value: 20 },
  });
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(true);
  layer.style.display = 'none';
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(false);
  layer.remove();
  const video = document.createElement('video');
  video.dataset.testid = 'workspace-content-review-media';
  node.append(video);
  vi.spyOn(video, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
  Object.defineProperties(video, { readyState: { value: 1 }, videoWidth: { value: 20 }, videoHeight: { value: 20 } });
  expect(isHomePublicationVisible(artifact.contentRef, 1)).toBe(false);
});
