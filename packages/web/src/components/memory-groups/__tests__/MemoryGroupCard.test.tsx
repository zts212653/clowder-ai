import type { RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RichBlocks } from '@/components/rich/RichBlocks';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { memoryGroupPreviewFixture } from '../dev-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ApprovalProvenanceLinks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  jumpToApprovalAnchor: vi.fn(),
}));
let host: HTMLDivElement, root: Root, fixture: ReturnType<typeof memoryGroupPreviewFixture>;
let sourceReadable: boolean, proofAvailable: boolean;
function unifiedRead() {
  if (proofAvailable) return fixture.unified;
  return {
    ...fixture.unified,
    items: fixture.unified.items.map((row) => ({ ...row, originalApprovalCard: undefined })),
  };
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = memoryGroupPreviewFixture();
  sourceReadable = true;
  proofAvailable = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (init?.method === 'POST')
      return Response.json({ proposalId: 'p-1', status: 'approved', entityId: 'concept:guardrail' });
    if (url === '/api/session') return Response.json({ userId: 'owner-1' });
    if (url.startsWith('/api/messages?'))
      return sourceReadable
        ? Response.json({ messages: [fixture.message], hasMore: false })
        : Response.json({ error: 'unavailable' }, { status: 503 });
    if (url.includes('/approval-hub/pending')) return Response.json({ items: [fixture.item], count: 1 });
    if (url.includes('/approval-hub/settled')) return Response.json({ items: [] });
    if (url.includes('/concierge/')) return Response.json(unifiedRead());
    return Response.json({ title: '合成来源' });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
  useApprovalHubStore.setState({
    items: [],
    pendingReadAvailable: false,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
  });
  useChatStore.getState().setPendingChatInsert(null);
});
async function render(block: RichCardBlock = fixture.group) {
  await act(async () =>
    root.render(
      <RichBlocks
        blocks={[block]}
        publication={{ threadId: 'group-preview', messageId: 'group-message', messageRevision: '2000' }}
      />,
    ),
  );
}

it('hosts the real original entity card and invokes only its original approve endpoint', async () => {
  await render();
  expect(host.querySelectorAll('[data-memory-group-id]')).toHaveLength(1);
  expect(host.querySelectorAll('[data-memory-group-row]')).toHaveLength(4);
  const row = host.querySelector('[data-memory-group-row="entity"]');
  const approve = row?.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(approve?.disabled).toBe(false);
  expect(row?.querySelector('[data-testid="reject-btn"]')).not.toBeNull();
  for (const id of ['matter', 'abstain', 'refused'])
    expect(host.querySelector(`[data-memory-group-row="${id}"] button`)).toBeNull();
  await act(async () => approve?.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0][0]).toBe('/api/entity-proposals/p-1/approve');
});

it('rehydrates the same persisted group and original card after remount without submitting a command', async () => {
  await render();
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(structuredClone(fixture.group));
  expect(host.querySelector('[data-memory-group-id]')?.getAttribute('data-memory-group-id')).toBe('remember-preview');
  expect(host.querySelector('[data-memory-group-row="entity"]')?.textContent).toContain('护栏');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('keeps original source failures retryable without offering a new approval or reconstruction', async () => {
  sourceReadable = false;
  await render();
  expect(host.textContent).toContain('原提案暂时无法读取');
  expect(host.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(host.textContent).toContain('这次不记');
  sourceReadable = true;
  const reread = [...host.querySelectorAll('button')].find((button) => button.textContent === '重新读取');
  await act(async () => reread?.click());
  expect(host.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not bypass the original card owner read when its canonical publication is missing', async () => {
  proofAvailable = false;
  await render();
  expect(host.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled).not.toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('offers modification suggestions through the original conversation draft without editing or approving memory', async () => {
  await render();
  useChatStore.getState().setPendingChatInsert({ threadId: 'group-preview', text: '未发送的想法' });
  const change = [...host.querySelectorAll('button')].find((button) => button.textContent === '修改建议');
  expect(change).toBeDefined();
  await act(async () => change?.click());
  const queued = useChatStore.getState().pendingChatInsert;
  expect(queued?.threadId).toBe('group-preview');
  expect(queued?.contextAttachments?.[0]).toMatchObject({
    kind: 'quote',
    source: { kind: 'message', threadId: 'group-preview', messageId: 'original-message' },
  });
  expect(queued?.text).toContain('修改');
  expect(queued?.text).toContain('未发送的想法');
  expect(queued?.waitForDraft).toBe(true);
  expect(host.textContent).toContain('草稿');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
