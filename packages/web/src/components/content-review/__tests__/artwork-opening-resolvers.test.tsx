import { act, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactFileSourceResolver } from '@/components/workbench/ArtifactFileSourceResolver';
import { MessagePublicationLandingResolver } from '@/components/workbench/MessagePublicationLandingResolver';
import { createMessagePublicationSurface } from '@/components/workbench/message-publication-surface';
import {
  contentContextSelectionKey,
  PublicationLandingResolver,
} from '@/components/workbench/PublicationLandingResolver';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { ArtworkOpeningPreview } from '../ArtworkOpeningPreview';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args) }));
const target = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 1 };
const surface = createPublicationSurface({ ...target, title: '原图' });
const context = {
  reviewId: `review-${'b'.repeat(64)}`,
  round: 1,
  taskId: 'task',
  threadId: 'thread',
  title: '原图',
  taskTitle: '原委托',
  threadTitle: '原对话',
  targetCatId: 'codex-sol',
  targetName: '砚砚',
};
const connection = {
  kind: 'connection-required',
  ownerUserId: 'operator',
  root: '/original',
  name: '原目录',
  path: 'original.jpg',
  expectedEpoch: 0,
  connectionProof: 'original-proof',
};
const operation = {
  operationId: 'original-operation',
  root: connection.root,
  expectedEpoch: 0,
  expectedUserId: 'operator',
};
const connectionKey = `cat-cafe:workspace-root-connection:${JSON.stringify(['operator', connection.root])}`;
const response = (value: unknown) => new Response(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let host: HTMLDivElement, root: Root, enter: ReturnType<typeof deferred<void>>;
const resolved = vi.fn();
const preview = () => host.querySelector('[data-testid="artwork-chat-preview"]');
function Journey({ entry }: { entry: (open: () => void) => ReactNode }) {
  const [owner, setOwner] = useState(false);
  return (
    <ArtworkOpeningPreview
      work={{ url: 'http://api.test/chat.jpg', title: '原图', alt: '原图', mediaType: 'image', surface }}
    >
      {owner ? (
        <img src="http://api.test/original.jpg" alt="original" data-testid="workspace-content-review-media" />
      ) : (
        entry(() => {
          resolved();
          // Rendering the resolved owner can take another turn; it never requires a user choice.
          void enter.promise.then(() => setOwner(true));
        })
      )}
    </ArtworkOpeningPreview>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  api.mockReset();
  resolved.mockReset();
  enter = deferred<void>();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function presentedOwner() {
  expect(resolved).toHaveBeenCalledOnce();
  expect(preview(), 'automatic resolution must keep the preview while the final owner is being mounted').not.toBeNull();
  await act(async () => enter.resolve());
  const image = host.querySelector<HTMLImageElement>('img[alt="original"]')!;
  const decoded = deferred<void>();
  Object.defineProperties(image, {
    currentSrc: { value: image.src },
    complete: { value: true },
    naturalWidth: { value: 1440 },
    naturalHeight: { value: 900 },
    decode: { value: () => decoded.promise },
  });
  await act(async () => image.dispatchEvent(new Event('load')));
  expect(preview(), 'the final owner still has no decoded pixels').not.toBeNull();
  await act(async () => decoded.resolve());
  expect(preview()).toBeNull();
}
function publication(open: () => void) {
  return (
    <PublicationLandingResolver sourceSurface={surface} target={target} onResolved={open} onBack={() => {}}>
      <p>原作品</p>
    </PublicationLandingResolver>
  );
}
function file(open: () => void) {
  return <ArtifactFileSourceResolver path="original.jpg" title="原图" onResolved={open} onBack={() => {}} />;
}

it.each([
  'getItem',
  'setItem',
] as const)('keeps a publication preview through non-blocking storage %s failure and final decode', async (method) => {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new Error('browser storage unavailable');
  });
  api.mockImplementation(async () => response({ ownerUserId: 'operator', contexts: [context] }));
  await act(async () => root.render(<Journey entry={publication} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    method === 'getItem' ? '本次仍可继续打开' : '选择尚未保存',
  );
  await presentedOwner();
});

it('exposes a genuine publication choice instead of waiting for media that cannot load yet', async () => {
  api.mockImplementation(async () =>
    response({ ownerUserId: 'operator', contexts: [context, { ...context, reviewId: `review-${'c'.repeat(64)}` }] }),
  );
  await act(async () => root.render(<Journey entry={publication} />));
  expect(preview()).toBeNull();
  expect(host.querySelector('[aria-label="作品讨论上下文"]')).not.toBeNull();
  expect(resolved).not.toHaveBeenCalled();
});

it('exposes the original publication read refusal and retry action', async () => {
  api.mockRejectedValue(new Error('需要重新读取原讨论'));
  await act(async () => root.render(<Journey entry={publication} />));
  expect(preview()).toBeNull();
  expect(host.textContent).toContain('需要重新读取原讨论');
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === '重新读取')).toBe(true);
});

it('keeps the preview through the real file resolver, saved root receipt recovery, and final decode', async () => {
  localStorage.setItem(connectionKey, JSON.stringify(operation));
  const receipt = deferred<Response>();
  let connected = false;
  api.mockImplementation(async (url: string) =>
    url.startsWith('/api/workspace/root-connections')
      ? receipt.promise
      : response(connected ? { kind: 'file', worktreeId: 'root', path: 'original.jpg' } : connection),
  );
  await act(async () => root.render(<Journey entry={file} />));
  expect(host.querySelector('[data-testid="workspace-root-connection"]')).not.toBeNull();
  expect(preview(), 'a root receipt is still being checked, without a user action').not.toBeNull();
  await act(async () => {
    connected = true;
    receipt.resolve(
      response({
        receiptRef: 'original-receipt',
        connected: true,
        root: connection.root,
        ownerUserId: 'operator',
        operationId: operation.operationId,
        currentEpoch: 0,
      }),
    );
  });
  await presentedOwner();
  expect(api.mock.calls.filter(([url]) => url === '/api/workspace/root-connections')).toHaveLength(0);
});

it.each([
  false,
  true,
])('exposes a root connection needing consent after recovery is settled (removed: %s)', async (removed) => {
  if (removed) localStorage.setItem(connectionKey, JSON.stringify(operation));
  api.mockImplementation(async (url: string) =>
    response(
      url.startsWith('/api/workspace/root-connections')
        ? {
            receiptRef: 'old-receipt',
            connected: false,
            root: connection.root,
            ownerUserId: 'operator',
            operationId: operation.operationId,
            currentEpoch: 1,
          }
        : connection,
    ),
  );
  await act(async () => root.render(<Journey entry={file} />));
  expect(preview()).toBeNull();
  expect(host.textContent).toContain('共享目录列表');
  expect([...host.querySelectorAll('button')].some((node) => node.textContent?.startsWith('连接 原目录'))).toBe(true);
  expect(resolved).not.toHaveBeenCalled();
});

it('keeps a remembered message-publication choice hidden while the exact saved owner is revalidated', async () => {
  const source = {
    kind: 'message' as const,
    threadId: 'source-thread',
    messageId: 'm',
    messageRevision: '1',
    expectedUrl: '/uploads/a.png',
    item: { kind: 'content-block' as const, index: 0 },
  };
  const asset = {
    ...target,
    blobDigest: `sha256:${'d'.repeat(64)}`,
    mediaType: 'image/png',
    media: { kind: 'image', width: 20, height: 20 },
    ownerReceiptRef: 'receipt',
    sourcePublication: { artifactRef: source.expectedUrl, sourceRef: 'message:source-thread:m', revision: '1' },
  };
  localStorage.setItem(`cat-cafe:message-publication:operator:${JSON.stringify(source)}`, JSON.stringify(target));
  localStorage.setItem(contentContextSelectionKey('operator', target.contentRef), context.reviewId);
  const revalidated = deferred<Response>();
  api.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === '/api/content-reviews/resolve') return response({ ownerUserId: 'operator', contexts: [context] });
    if (JSON.parse(String(init.body)).selection) return revalidated.promise;
    return response({
      status: 'choice-required',
      ownerUserId: 'operator',
      choices: [{ asset, title: '原图', threadTitle: '原对话', match: 'legacy-ambiguous' }],
    });
  });
  await act(async () =>
    root.render(
      <Journey
        entry={(open) => (
          <MessagePublicationLandingResolver
            source={source}
            surface={createMessagePublicationSurface(source, '原图')}
            onResolved={open}
            onBack={() => {}}
          />
        )}
      />,
    ),
  );
  expect(preview(), 'a remembered choice is being revalidated automatically').not.toBeNull();
  expect(resolved).not.toHaveBeenCalled();
  await act(async () => revalidated.resolve(response({ status: 'resolved', ownerUserId: 'operator', asset })));
  await presentedOwner();
});
