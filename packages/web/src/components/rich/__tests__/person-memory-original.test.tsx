import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalRow, okRead, visibleApproval } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { ApprovalDecisionReceipt } from '@/components/shell/mailbox/ApprovalDecisionReceipt';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '@/components/shell/mailbox/MailboxRow';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '../../ApprovalHost';
import { ApprovalItemCard } from '../../ApprovalItemCard';
import { PersonMemoryProposalCard } from '../PersonMemoryProposalCard';
import { PersonMemoryRetainedReceipt } from '../PersonMemoryRetainedReceipt';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, item: ApprovalHubItem, block: RichCardBlock;
let status: string, remaining: string[], wrongAnchor: boolean, deleted: boolean, owner: string;
let decisionId: string | null, undone: boolean, retainedWrites: boolean;
const coordinate = { threadId: 'thread_people', messageId: 'person-card-original' };
function snapshot() {
  return {
    proposalId: item.proposalId,
    status,
    hasRetainedWrites: retainedWrites,
    remainingDraftIds: remaining,
    publicationState: 'anchored',
    approvalCardMessageId: wrongAnchor ? 'foreign-card' : coordinate.messageId,
    ...(decisionId
      ? {
          decisionReceipt: {
            decisionId,
            materializedClaimIds: ['person_claim_1'],
            materializedRelationshipIds: [],
            materializedEventIds: [],
          },
        }
      : {}),
    ...(undone
      ? {
          undoApplied: status === 'withdrawn',
          undoReceipt: {
            requestId: 'undo-original',
            verdict: 'undone',
            candidateId: item.proposalId,
            candidateState: status === 'withdrawn' ? 'withdrawn' : 'pending_approval',
          },
        }
      : {}),
  };
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  status = 'pending_approval';
  remaining = ['person_draft_1', 'person_draft_2'];
  wrongAnchor = false;
  deleted = false;
  owner = 'owner-1';
  decisionId = null;
  undone = false;
  retainedWrites = false;
  item = {
    proposalId: 'person_candidate_original',
    sourceFeatureId: 'F276',
    ownerUserId: owner,
    requesterCatId: 'codex61-sol',
    summary: '记住人物：林',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: 100,
    inlineApprovable: true,
    decisionMode: 'claim-select',
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: coordinate.threadId, messageId: 'owner-source' },
      approvalCardRef: coordinate,
    },
    detail: {
      displayName: '林',
      candidateState: status,
      remainingDraftIds: remaining,
      drafts: remaining.map((draftId, index) => ({
        draftId,
        claimKind: 'reported_fact',
        normalizedDraft: index === 0 ? '林喜欢爬山' : '林住在杭州',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: index === 0 ? '他说喜欢爬山' : '他说住在杭州',
      })),
    },
  };
  block = {
    id: `person-memory-${item.proposalId}`,
    kind: 'card',
    v: 1,
    title: '要把 林 记下来吗？',
    bodyMarkdown: '林喜欢爬山；林住在杭州',
    actions: [
      { label: '去审批', action: 'person-memory:open-approval-hub', payload: { candidateId: item.proposalId } },
    ],
    meta: {
      kind: 'person_memory_proposal',
      candidateId: item.proposalId,
      envelopeRef: `approval:F276:${item.proposalId}`,
      decisionSurface: 'approval_hub',
      status: 'pending_approval',
      subjectDisplayName: '林',
      approval: { producerId: 'F276', canonicalProposalId: item.proposalId },
    },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (url === '/api/session') return Response.json({ userId: owner });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/approve')) {
        remaining = remaining.filter((id) => !body.selectedDraftIds.includes(id));
        status = remaining.length ? 'partially_materialized' : 'materialized';
        decisionId = body.decisionId;
        undone = false;
        return Response.json({ ...snapshot(), ...snapshot().decisionReceipt });
      }
      if (url.endsWith('/undo')) {
        status = status === 'materialized' ? 'withdrawn' : 'pending_approval';
        if (status === 'pending_approval') remaining = ['person_draft_1', 'person_draft_2'];
        undone = true;
        return Response.json({ ...snapshot(), verdict: 'undone' });
      }
      if (url.endsWith('/not-now')) {
        status = 'not_now';
        return Response.json(snapshot());
      }
      if (url.endsWith('/reject')) {
        status = 'rejected';
        return Response.json(snapshot());
      }
    }
    if (url.startsWith('/api/messages?'))
      return Response.json({
        messages: deleted
          ? []
          : [
              {
                id: coordinate.messageId,
                catId: item.requesterCatId,
                timestamp: 100,
                extra: { rich: { blocks: [block] } },
              },
            ],
        hasMore: false,
      });
    if (url.includes('/approval-hub/pending')) {
      const items = ['pending_approval', 'partially_materialized', 'not_now'].includes(status)
        ? [{ ...item, detail: { ...item.detail, remainingDraftIds: remaining, candidateState: status } }]
        : [];
      return Response.json({ items, count: items.length });
    }
    if (url.includes('/person-memory-proposals/')) return Response.json(snapshot());
    return Response.json({});
  });
  useApprovalHubStore.setState({
    items: [],
    count: 0,
    pendingReadAvailable: false,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
    error: null,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
async function render(entrance: 'Chat' | 'Inbox') {
  await act(async () =>
    root.render(
      entrance === 'Chat' ? (
        <PersonMemoryProposalCard block={block} messageId={coordinate.messageId} coordinate={coordinate} />
      ) : (
        <ApprovalItemCard item={item} />
      ),
    ),
  );
}
async function click(testId: string) {
  if (testId === 'person-memory-undo' && !container.querySelector(`[data-testid="${testId}"]`)) {
    const disclosure = container.querySelector<HTMLButtonElement>(
      '[data-testid="decision-result-row"] button[aria-expanded="false"]',
    );
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure?.click());
  }
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click());
}
for (const entrance of ['Chat', 'Inbox'] as const) {
  it(`${entrance}: picks only selected drafts through original writer and retains exact undo`, async () => {
    await render(entrance);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).not.toContain('为什么找你');
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
    await click('person-memory-approve-selected');
    const approve = vi
      .mocked(apiFetch)
      .mock.calls.find(([url, init]) => String(url).endsWith('/approve') && init?.method === 'POST');
    expect(approve).toBeDefined();
    expect(JSON.parse(String(approve?.[1]?.body)).selectedDraftIds).toEqual(['person_draft_1']);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
    await click('person-memory-approve-selected');
    expect(status).toBe('materialized');
    await click('person-memory-undo');
    const undo = vi
      .mocked(apiFetch)
      .mock.calls.find(([url, init]) => String(url).endsWith('/undo') && init?.method === 'POST');
    expect(JSON.parse(String(undo?.[1]?.body)).decisionId).toBe(decisionId);
    expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain('已撤销本次写入');
    expect(container.querySelector('[data-testid=person-memory-result]')).toBeNull();
    expect(container.querySelector('[data-testid="person-memory-undo"]')).toBeNull();
  });
  it(`${entrance}: refuses a changed publication immediately before writing`, async () => {
    await render(entrance);
    deleted = true;
    await click('person-memory-approve-selected');
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
}
it('fails closed on foreign anchored status', async () => {
  wrongAnchor = true;
  await render('Chat');
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
});
it('cold reads materialized receipt and undoes it without a pending list item', async () => {
  status = 'materialized';
  remaining = [];
  decisionId = 'durable-original-decision';
  await render('Chat');
  expect(container.textContent).toContain('已写入');
  expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="decision-result-row"] button[aria-expanded="false"]')
      ?.click(),
  );
  expect(container.querySelector('h3')?.textContent).toContain('林');
  await click('person-memory-undo');
  expect(status).toBe('withdrawn');
});
it('not-now stays readable without materializing and can resume a selected decision', async () => {
  await render('Chat');
  await click('person-memory-not-now');
  expect(status).toBe('not_now');
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(decisionId).toBeNull();
});

it('a new selected write after partial undo cannot replay the undone decision', async () => {
  await render('Chat');
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
  await click('person-memory-approve-selected');
  const first = decisionId;
  await click('person-memory-undo');
  expect(status).toBe('pending_approval');
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
  await click('person-memory-approve-selected');
  expect(decisionId).not.toBe(first);
});

it('refuses a changed undo epoch before submitting the selected drafts', async () => {
  await render('Chat');
  undone = true;
  await click('person-memory-approve-selected');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('keeps an edited subset through an unavailable reread and locks producer buttons', async () => {
  await render('Chat');
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '重新读取')?.click(),
  );
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((c) => c.checked)).toEqual([
    true,
    false,
  ]);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="person-memory-approve-selected"]')?.disabled).toBe(
    true,
  );
});
it('does not undo a newer decision that replaced the displayed receipt', async () => {
  status = 'materialized';
  remaining = [];
  decisionId = 'first';
  await render('Chat');
  decisionId = 'newer';
  await click('person-memory-undo');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(container.textContent).toContain('撤销失败');
});
it('foreign owner cannot hydrate the pending selector', async () => {
  owner = 'different-owner';
  await render('Chat');
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
});
it('changed published content cannot submit from the old display', async () => {
  await render('Chat');
  block = { ...block, title: 'A different request' };
  await click('person-memory-approve-selected');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('a late older hydration cannot replace a fresh canonical socket reread', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let release!: (value: Response) => void,
    blocked = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    if (String(path).includes('/person-memory-proposals/') && !init?.method && !blocked) {
      blocked = true;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return original(path, init, options);
  });
  await render('Chat');
  const older = snapshot();
  status = 'materialized';
  remaining = [];
  decisionId = 'fresh-durable';
  await act(async () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: item.proposalId } })),
  );
  expect(container.textContent).toContain('已写入');
  await act(async () => release(Response.json(older)));
  expect(container.textContent).toContain('已写入');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="decision-result-row"] button[aria-expanded="false"]')
      ?.click(),
  );
  expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
});

it('the first Inbox layer shows the person and two draft choices without opening a generic explanation', async () => {
  const row = approvalRow(item),
    sessions = createApprovalSessions({
      readsStarted: () => 1,
      refetch: () => {},
      refreshStore: () => useApprovalHubStore.getState().fetchPending(),
      storeItems: () => useApprovalHubStore.getState().items,
      attempts: () => useApprovalHubStore.getState().decisionAttempts,
      latestRead: () => ({ result: okRead([row]), generation: 1 }),
      now: Date.now,
    });
  await act(async () =>
    root.render(
      <MailboxRow
        item={row}
        rowKey={row.decisionRef}
        expanded={false}
        stale={false}
        onToggle={() => {}}
        onOpen={() => {}}
        hosted={{ ownerUserId: 'owner-1', sessions }}
      />,
    ),
  );
  expect(container.querySelectorAll('[data-testid="mailbox-open-original"]')).toHaveLength(1);
  expect(container.textContent).toContain('关于 林 · 2 条草稿');
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(container.textContent).not.toContain('为什么找你');
});
it('the retained Inbox result exposes the exact undo after its pending card has retired', async () => {
  status = 'materialized';
  remaining = [];
  decisionId = 'retained-decision';
  await act(async () => root.render(<PersonMemoryRetainedReceipt approval={visibleApproval(item)} />));
  expect(container.textContent).toContain('已写入');
  await click('person-memory-undo');
  expect(status).toBe('withdrawn');
  expect(container.textContent).toContain('已撤销本次写入');
});

it.each([
  'Chat',
  'Inbox',
] as const)('%s cold rejection distinguishes retained writes from declined remaining drafts', async (entrance) => {
  status = 'rejected';
  remaining = [];
  decisionId = 'earlier-materialized-partial';
  retainedWrites = true;
  await render(entrance);
  const label = container.querySelector('[data-testid=decision-result-label]')?.textContent;
  expect(label).toContain('此前已写入');
  expect(label).toContain('其余没写');
  expect(container.querySelector('[data-testid=decision-result-dot]')?.getAttribute('data-status')).toBe('approved');
  expect(container.querySelector('[data-testid=person-memory-undo]')).toBeNull();
});

it.each([
  'unavailable',
  'foreign-anchor',
  'reopened',
  'foreign-owner',
] as const)('keeps an exact retained result neutral and collapsed when producer truth is %s', async (kind) => {
  status = kind === 'reopened' ? 'pending_approval' : 'materialized';
  decisionId = 'exact-previous-decision';
  wrongAnchor = kind === 'foreign-anchor';
  if (kind === 'foreign-owner') owner = 'foreign-owner';
  if (kind === 'unavailable') {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, init, options) =>
      String(path).includes('/person-memory-proposals/')
        ? Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }))
        : original(path, init, options),
    );
  }
  await act(async () =>
    root.render(
      <ApprovalDecisionReceipt
        session={{ approval: visibleApproval(item), ownerUserId: 'owner-1', originalBlock: block }}
        terminal={{ resolution: 'accepted', decidedAt: 200, decidedBy: 'owner-1' }}
        line="已同意 · 效果待确认"
      />,
    ),
  );
  expect(container.querySelector('[data-testid="decision-result-row"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe('closed');
  expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
  expect(container.querySelector('[data-testid="person-memory-undo"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
  expect(container.querySelector('[data-testid="person-memory-undo"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled ?? true).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('recovers a neutral retained receipt through a fresh owner read without reinstalling decision controls', async () => {
  status = 'materialized';
  remaining = [];
  decisionId = 'recover-exact-decision';
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  let unavailable = true;
  vi.mocked(apiFetch).mockImplementation((path, init, options) =>
    unavailable && String(path).includes('/person-memory-proposals/')
      ? Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }))
      : original(path, init, options),
  );
  await act(async () =>
    root.render(
      <ApprovalDecisionReceipt
        session={{ approval: visibleApproval(item), ownerUserId: 'owner-1', originalBlock: block }}
        terminal={{ resolution: 'accepted', decidedAt: 200, decidedBy: 'owner-1' }}
        line="已同意 · 效果待确认"
      />,
    ),
  );
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe('closed');
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
  unavailable = false;
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === '重新读取');
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe('approved');
  expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled ?? true).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('reports the actual Undo HTTP response so an Inbox host can distinguish a confirmed pending continuation', async () => {
  status = 'partially_materialized';
  decisionId = 'partial-decision';
  remaining = ['person_draft_2'];
  const reportRequest = vi.fn();
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider value={{ ...PERMISSIVE_APPROVAL_HOST, reportRequest }}>
        <ApprovalItemCard item={item} />
      </ApprovalHostContext.Provider>,
    ),
  );
  await click('person-memory-undo');
  expect(reportRequest).toHaveBeenCalledWith({
    phase: 'end',
    kind: 'person-memory-undo',
    outcome: 'settled',
    status: 200,
  });
});

it('a cold Chat replacement has the same closed meaning in its row and expanded original', async () => {
  status = 'withdrawn';
  remaining = [];
  undone = true;
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((path, init, options) =>
    String(path).startsWith('/api/person-memory-proposals/')
      ? Promise.resolve(
          Response.json({
            ...snapshot(),
            replacedByProposalId: 'person_candidate_replacement',
            undoApplied: false,
            undoReceipt: {
              requestId: 'historical-partial-undo',
              verdict: 'undone',
              candidateId: item.proposalId,
              candidateState: 'pending_approval',
            },
          }),
        )
      : original(path, init, options),
  );
  await render('Chat');
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain('已关闭');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid=decision-result-row] button[aria-expanded="false"]')
      ?.click(),
  );
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain('已关闭');
  expect(container.querySelector('[data-testid=person-memory-result]')).toBeNull();
  expect(container.textContent).not.toContain('已撤回');
  expect(container.textContent).not.toContain('已撤销本次写入');
  expect(container.querySelector('[data-testid=person-memory-undo]')).toBeNull();
  expect(container.querySelector('[data-testid=person-memory-approve-selected]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
