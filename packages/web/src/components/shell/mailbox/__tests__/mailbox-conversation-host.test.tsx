import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { binding, block, cardRef, record, request } from '../../../rich/__tests__/runtime-conversation-test-fixtures';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { okRead } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳' }));
let root: Root, container: HTMLDivElement, starts: number;
const item: UnifiedAttentionItemV1 = {
  decisionRef: `f306.runtime_interaction:${binding.interactionId}`,
  kind: 'judgment',
  summary: request.title,
  linkedNeedsMe: [],
  runtimeInteraction: {
    interactionId: binding.interactionId,
    revision: 5,
    sourceKind: 'conversation_decision',
    kind: 'conversation_decision',
    requesterCatId: request.owner.catId,
    createdAt: request.createdAt,
    title: request.title,
    cardRef,
    presentation: block,
    allowTextResponse: true,
  },
};
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  starts = 1;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url === '/api/session') return json({ userId: 'owner' });
    if (options?.method === 'POST')
      return json({
        interaction: {
          ...record,
          status: 'answered',
          revision: 7,
          terminal: {
            status: 'answered',
            reasonCode: 'answered',
            settledAt: 10000,
            response: { kind: 'selection', selectedIds: ['alpha'] },
            responseMessageId: 'answer-one',
            operationId: JSON.parse(String(options.body)).operationId,
          },
        },
      });
    return json({ interaction: record });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
async function render() {
  const sessions = createApprovalSessions({
    readsStarted: () => starts,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([item], { identity: { ownerUserId: 'owner' } }), generation: 1 }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      <MailboxRow
        item={item}
        rowKey="original-conversation"
        stale={false}
        expanded={false}
        onToggle={() => {}}
        onOpen={() => {}}
        hosted={{ sessions, ownerUserId: 'owner' }}
      />,
    ),
  );
}
const button = (text: string) => {
  const b = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!b) throw new Error(text);
  return b;
};
it('keeps the original conversation choices actionable in the collapsed row and retains the canonical local result', async () => {
  await render();
  expect(container.querySelector('[data-testid=runtime-conversation-card]')).not.toBeNull();
  expect(container.textContent?.split(request.title).length).toBe(2);
  await act(async () => button('Alpha').click());
  await act(async () => button('确认选择').click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, o]) => o?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0][1]?.body)).expectedRevision).toBe(5);
  expect(container.querySelector('[data-testid=conversation-decision-result]')?.textContent).toContain('已选「Alpha」');
});
it('a newer pending read closes the writer before React has committed its stale row', async () => {
  await render();
  starts = 2;
  await act(async () => button('Alpha').click());
  await act(async () => button('确认选择').click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
