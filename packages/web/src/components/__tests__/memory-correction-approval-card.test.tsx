import type { ApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalRow, okRead, storeItem } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '@/components/shell/mailbox/MailboxRow';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '../ApprovalHost';
import { ApprovalItemCard } from '../ApprovalItemCard';
import { RichBlocks } from '../rich/RichBlocks';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { createCorrectionItem, installCorrectionApi } from './memory-correction-approval.fixture';

let container: HTMLDivElement, root: Root, item: ApprovalHubItem;
let pending: boolean, owner: string, changed: boolean, terminal: boolean, approveOnPost: boolean;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  pending = true;
  owner = 'owner-1';
  changed = false;
  terminal = false;
  approveOnPost = false;
  item = createCorrectionItem();
  installCorrectionApi(
    () => ({ pending, owner, changed, terminal, approveOnPost }),
    () => item,
    () => {
      pending = false;
      terminal = true;
    },
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
  useApprovalHubStore.setState({
    items: [],
    pendingReadAvailable: false,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
  });
});
const accept = () => [...container.querySelectorAll('button')].find((b) => b.textContent === '接受这条建议');
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');

it('hosts the original correction with the complete before/after memory and its own accept writer', async () => {
  await act(async () => root.render(<ApprovalItemCard item={item} />));
  expect(container.textContent).toContain('改的是哪件事: 原来的解释。');
  expect(container.textContent).toContain('原来的解释。');
  expect(container.textContent).toContain('后来核实的解释。');
  expect(container.textContent).not.toContain('outdated');
  expect(container.textContent).not.toContain('scope_correction');
  expect(accept()?.disabled).toBe(false);
  await act(async () => accept()?.click());
  expect(posts()[0]?.[0]).toBe('/api/event-memory-corrections/correction-a/approve');
});

it('keeps the original memory readable but sends nothing after its displayed revision changes', async () => {
  await act(async () => root.render(<ApprovalItemCard item={item} />));
  expect(accept()).toBeDefined();
  changed = true;
  await act(async () => accept()?.click());
  expect(posts()).toEqual([]);
  expect(container.textContent).toContain('记忆或建议已变更');
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '重读事件')?.click());
  const reject = [...container.querySelectorAll('button')].find((b) => b.textContent === '拒绝这条建议');
  expect(reject?.disabled).toBe(false);
  expect(accept()?.disabled).toBe(true);
});

it('does not host a foreign owner memory record', async () => {
  owner = 'other-owner';
  await act(async () => root.render(<ApprovalItemCard item={item} />));
  expect(accept()).toBeUndefined();
  expect(container.textContent).toContain('暂时不能处理');
});

it('keeps the current host read fence immediately before the original producer request', async () => {
  let allowed = true;
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider value={{ ...PERMISSIVE_APPROVAL_HOST, authorizeWrite: () => allowed }}>
        <ApprovalItemCard item={item} />
      </ApprovalHostContext.Provider>,
    ),
  );
  expect(accept()).toBeDefined();
  allowed = false;
  await act(async () => accept()?.click());
  expect(posts()).toEqual([]);
});

it('sends nothing when the card closes during its preflight owner read', async () => {
  await act(async () => root.render(<ApprovalItemCard item={item} />));
  const previous = vi.mocked(apiFetch).getMockImplementation();
  let release: (() => void) | undefined;
  const pendingRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    if (String(path).includes('/approval-hub/pending')) await pendingRead;
    return previous?.(path, init, options) ?? Response.json({});
  });
  act(() => accept()?.click());
  await act(async () => {
    root.unmount();
    release?.();
  });
  expect(posts()).toEqual([]);
});

it('uses the original correction on the stamped Chat publication, without a generic callback action', async () => {
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '原卡',
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  expect(accept()?.disabled).toBe(false);
  await act(async () => accept()?.click());
  expect(posts()[0]?.[0]).toBe('/api/event-memory-corrections/correction-a/approve');
});

it('does not authorize a copied Chat card on a different publication', async () => {
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'copy-card', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '副本',
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  expect(accept()).toBeUndefined();
  expect(posts()).toEqual([]);
});

it('shows the original memory effect only after exact canonical history and the finalized applied revision', async () => {
  approveOnPost = true;
  await act(async () => root.render(<ApprovalItemCard item={item} />));
  await act(async () => accept()?.click());
  expect(container.textContent).toContain('原记忆已更正');
  expect(accept()).toBeUndefined();
});

it('does not turn missing pending membership into a cold Chat result', async () => {
  pending = false;
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '原卡',
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  expect(accept()).toBeUndefined();
  expect(container.textContent).not.toMatch(/已接受|已拒绝/);
});

it('finds an ignored-pending original correction beyond the first canonical page', async () => {
  const previous = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    if (!String(path).includes('/concierge/')) return previous?.(path, init, options) ?? Response.json({});
    const offset = Number(new URL(String(path), 'http://private.test').searchParams.get('offset'));
    const rows =
      offset === 0
        ? Array.from({ length: 20 }, (_, i) => approvalRow(storeItem({ proposalId: `other-${i}` })))
        : [approvalRow(item)];
    const state = okRead(rows, { page: { offset, limit: 20, hasMore: offset === 0, scope: 'known_rows' } });
    return Response.json(state.kind === 'ok' ? state.read : null);
  });
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '原卡',
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  expect(accept()?.disabled).toBe(false);
  const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
  expect(paths.some((path) => path.includes('offset=20'))).toBe(true);
  expect(paths.some((path) => path.includes('personalView'))).toBe(false);
});

it('keeps an injected-action correction copy readonly instead of sending a generic callback', async () => {
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '原卡',
            actions: [],
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  expect(accept()).toBeUndefined();
  expect(posts()).toEqual([]);
});

it('places the original correction on the closed first layer instead of requiring a generic row toggle', async () => {
  const row = approvalRow(item),
    read = okRead([row]);
  const sessions = createApprovalSessions({
    latestRead: () => ({ result: read, generation: 1 }),
    readsStarted: () => 1,
    storeItems: () => [item],
    attempts: () => ({}),
    refetch: vi.fn(),
    refreshStore: vi.fn().mockResolvedValue(undefined),
    lookupSettled: async () => ({ kind: 'not_found' }),
    now: () => Date.now(),
  });
  await act(async () =>
    root.render(
      <MailboxRow
        item={row}
        rowKey="memory-a"
        stale={false}
        expanded={false}
        readCurrent
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        hosted={{ ownerUserId: 'owner-1', sessions }}
      />,
    ),
  );
  expect(accept()?.disabled).toBe(false);
  expect(container.querySelector('[data-testid="mailbox-item-toggle"]')).toBeNull();
  expect(container.textContent).not.toContain('Event correction: event-a');
});
