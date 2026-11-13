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
import { ArtworkChromeProvider, useArtworkChrome } from '../ArtworkChrome';
import { ArtworkOpeningPreview } from '../ArtworkOpeningPreview';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: (...args: unknown[]) => api(...args) }));
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

function ChromeActionsSlot() {
  const chrome = useArtworkChrome();
  return <div ref={chrome?.setActions} data-testid="test-header-actions" />;
}

function worktreeFile(open: () => void) {
  return (
    <ArtifactFileSourceResolver
      worktreeId="active-wt"
      path="original.jpg"
      title="原图"
      onResolved={open}
      onBack={() => {}}
    />
  );
}

it.each([
  {
    status: 404,
    body: { error: { code: 'not_found' } },
    expectedText: '尚未登记',
  },
  {
    status: 409,
    body: { error: { code: 'directory_inventory_unavailable', locations: [{ label: 'gone-worktree' }] } },
    expectedText: 'gone-worktree',
  },
  {
    status: 503,
    body: { error: { code: 'source_resolution_unavailable' } },
    expectedText: '暂时无法核验',
  },
])('keeps the readable preview, download action, and retry recovery on non-auth file source failure ($status) while current workspace read remains 200', async ({
  status,
  body,
  expectedText,
}) => {
  let healthy = false;
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?')) return response({ path: 'original.jpg', mime: 'image/jpeg' });
    return healthy
      ? response({ kind: 'file', worktreeId: 'root', path: 'original.jpg' })
      : new Response(JSON.stringify(body), { status });
  });
  await act(async () =>
    root.render(
      <ArtworkChromeProvider>
        <ChromeActionsSlot />
        <Journey entry={worktreeFile} />
      </ArtworkChromeProvider>,
    ),
  );
  expect(preview(), 'non-auth file source failure must not blank a readable preview').not.toBeNull();
  expect(preview()?.querySelector('img')?.getAttribute('src')).toBe('http://api.test/chat.jpg');
  expect(host.querySelector('button[aria-label="下载"]'), 'download action must remain available').not.toBeNull();
  const fallback = host.querySelector('[data-testid="artwork-preview-fallback"]');
  expect(fallback?.textContent).toContain('无法批注');
  expect(fallback?.textContent).toContain(expectedText);
  expect(preview()?.textContent).not.toContain('正在读取作品版本');

  healthy = true;
  const retry = fallback?.querySelector('button');
  expect(retry?.textContent).toBe('重试');
  await act(async () => retry?.click());
  await presentedOwner();
});

it.each([
  {
    label: 'revoked directory 404',
    sourceStatus: 404,
    sourceBody: { error: { code: 'not_found' } },
    fileStatus: 404,
  },
  {
    label: 'inventory 409 after directory grant revoked',
    sourceStatus: 409,
    sourceBody: { error: { code: 'directory_inventory_unavailable', locations: [{ label: 'other-root' }] } },
    fileStatus: 404,
  },
])('removes a cached preview without waiting for img onError when current workspace read is refused ($label)', async ({
  sourceStatus,
  sourceBody,
  fileStatus,
}) => {
  api.mockImplementation(async (url: string) =>
    url.startsWith('/api/workspace/file?')
      ? new Response(JSON.stringify({ error: 'Unknown worktreeId: linked_review' }), { status: fileStatus })
      : new Response(JSON.stringify(sourceBody), { status: sourceStatus }),
  );
  await act(async () =>
    root.render(
      <ArtworkChromeProvider>
        <ChromeActionsSlot />
        <Journey
          entry={(open) => (
            <ArtifactFileSourceResolver
              worktreeId="linked_review"
              path="original.jpg"
              title="原图"
              onResolved={open}
              onBack={() => {}}
            />
          )}
        />
      </ArtworkChromeProvider>,
    ),
  );
  expect(preview(), 'revoked directory grant must immediately unmount cached preview').toBeNull();
  expect(host.querySelector('button[aria-label="下载"]')).toBeNull();
  expect(resolved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('[aria-hidden="false"]')?.inert).toBe(false);
});

it.each([
  [401, 'identity_required'],
  [403, 'access_denied'],
  [409, 'identity_changed'],
] as const)('removes the preview on genuine authorization or identity refusal (%s %s)', async (status, code) => {
  api.mockResolvedValue(new Response(JSON.stringify({ error: { code } }), { status }));
  await act(async () => root.render(<Journey entry={file} />));
  expect(preview(), 'genuine authorization/identity refusal must not leave cached preview visible').toBeNull();
  expect(resolved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('[aria-hidden="false"]')?.inert).toBe(false);
});

it('falls back to the owner error panel if the Chat preview image itself fails to load', async () => {
  api.mockImplementation(async (url: string) =>
    url.startsWith('/api/workspace/file?')
      ? response({ path: 'original.jpg', mime: 'image/jpeg' })
      : new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
  );
  await act(async () => root.render(<Journey entry={worktreeFile} />));
  const previewImg = preview()?.querySelector('img');
  expect(previewImg).not.toBeNull();
  await act(async () => previewImg!.dispatchEvent(new Event('error')));
  expect(preview()).toBeNull();
  expect(host.querySelector<HTMLElement>('[aria-hidden="false"]')?.inert).toBe(false);
});
