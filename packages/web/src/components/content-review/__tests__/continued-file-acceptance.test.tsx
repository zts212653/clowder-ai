import type { ContentModificationDetailView, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('a publication continuation exposes the inherited file accept and keeps its confirmed base through an unknown response', async () => {
  const source: ContentModificationRequest['source'] = {
    kind: 'publication',
    contentRef: 'prepared-media:' + 'a'.repeat(64),
    ownerRevision: 2,
    ledgerRef: 'ledger-two',
    expectedLedgerRevision: 1,
  };
  const base = 'sha256:' + 'b'.repeat(64),
    result = 'sha256:' + 'c'.repeat(64),
    requestId = 'f309-modification-' + 'd'.repeat(64);
  const view: ContentModificationDetailView = {
    stage: 'queued',
    record: {
      requestId,
      ownerUserId: 'operator',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: {
        operationId: crypto.randomUUID(),
        source,
        targetCatId: 'codex-astra',
        threadId: 'execution',
        intent: { body: '再改背景' },
      },
    },
    writeback: {
      originRequestId: 'original-file-request',
      locator: { worktreeId: 'work', path: 'original.png' },
      baseRevision: base,
      writable: true,
    },
    candidates: [
      {
        kind: 'media',
        candidateRef: 'candidate-three',
        authorCatId: 'codex-astra',
        responses: [],
        asset: {
          contentRef: source.contentRef,
          ownerRevision: 3,
          blobDigest: result,
          mediaType: 'image/png',
          media: { kind: 'image', width: 160, height: 100 },
          ownerReceiptRef: 'candidate-three',
          sourcePublication: {
            artifactRef: '/uploads/three.png',
            sourceRef: 'message:execution:return',
            revision: '1',
          },
        },
      },
    ],
    acceptances: [],
  };
  const writes: Record<string, string>[] = [];
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const reply = (value: unknown) => new Response(JSON.stringify(value));
    if (url.endsWith('/choices'))
      return reply({
        cats: [{ catId: 'codex-astra', name: '小星星', mcpSupport: true, restrictions: [] }],
        threads: [{ threadId: 'execution', title: '修改封面' }],
      });
    if (url.endsWith(requestId)) return reply(view);
    if (url === '/api/workspace/edit-session') return reply({ token: 'temporary' });
    if (url.endsWith('/accept')) {
      const command = JSON.parse(String(init?.body)) as Record<string, string>;
      writes.push(command);
      if (writes.length === 1) throw new Error('lost request response');
      return reply({});
    }
    throw new Error(url);
  });
  await act(async () => {
    root.render(
      <ContentModificationPanel
        title="original.png"
        source={source}
        ownerUserId="operator"
        initialRequest={view.record}
        contextKey={requestId}
        completionRule="file-writeback-applied"
        onClose={vi.fn()}
      />,
    );
  });
  const accept = () => container.querySelector<HTMLButtonElement>('[data-testid="content-modification-accept"]');
  expect(accept()).not.toBeNull();
  await act(async () => accept()?.click());
  expect(writes[0]?.baseRevision).toBe(base);
  if (view.writeback) view.writeback.baseRevision = 'sha256:' + 'e'.repeat(64);
  await act(async () => accept()?.click());
  expect(writes).toHaveLength(2);
  expect(writes[1]?.acceptOperationId).toBe(writes[0]?.acceptOperationId);
  expect(writes[1]?.baseRevision).toBe(base);
  expect(Object.values(localStorage).join('')).not.toContain('temporary');
});
