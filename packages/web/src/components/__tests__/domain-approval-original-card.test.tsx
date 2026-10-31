import type { ApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { apiFetch } from '@/utils/api-client';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '../ApprovalHost';
import { ApprovalItemCard } from '../ApprovalItemCard';
import { writeShellLanguage } from '../shell/shell-language';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const actions = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn(), resolve: vi.fn() }));
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({
      close: vi.fn(),
      approveProposal: actions.approve,
      rejectProposal: actions.reject,
      resolveEntityConflict: actions.resolve,
      deciding: {},
      error: null,
    }),
}));
vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: (id: string) => ({
    currentThread: { id, title: id === 'source-thread' ? 'Research discussion' : 'Implementation discussion' },
  }),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ proposalId: 'owned-domain-proposal', status: 'pending' }),
  } as Response);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
it('only resumes an approving taste operation through the original approve writer', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ proposalId: 'owned-domain-proposal', status: 'approving' }),
  } as Response);
  await act(async () =>
    root.render(
      <ApprovalItemCard
        item={{
          ...item('F221'),
          resolution: 'accepted',
          inlineApprovable: false,
          materialization: { state: 'outcome_unknown' },
        }}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="reject-btn"]')).toBeNull();
  const resume = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(resume?.textContent).toBe('Continue writing');
  await act(async () => resume?.click());
  expect(actions.approve).toHaveBeenCalledWith('owned-domain-proposal');
});
it('rechecks taste status before a decision and refuses a stale pending button', async () => {
  await render('F221');
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ proposalId: 'owned-domain-proposal', status: 'approved' }),
  } as Response);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.click());
  expect(actions.approve).not.toHaveBeenCalled();
});
it('renders the canonical entity taxonomy rather than invented type or stance values', async () => {
  const value = item('F260');
  await act(async () =>
    root.render(
      <ApprovalItemCard
        item={{ ...value, detail: { ...value.detail, entityType: 'cat', stance: 'critique_target' } }}
      />,
    ),
  );
  expect(container.textContent).toContain('Cat');
  expect(container.textContent).toContain('Under critique');
  expect(container.textContent).not.toContain('Unavailable');
});
it('shows the original lifecycle result in the selected English language', async () => {
  await act(async () =>
    root.render(
      <ApprovalItemCard
        item={{
          ...item('F260'),
          resolution: 'accepted',
          inlineApprovable: false,
          materialization: { state: 'outcome_unknown' },
        }}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="approval-lifecycle-badge"]')?.textContent).toBe(
    'Approved · result unconfirmed',
  );
});
function item(feature: 'F193' | 'F221' | 'F260'): ApprovalHubItem {
  return {
    sourceFeatureId: feature,
    proposalId: 'owned-domain-proposal',
    requesterCatId: 'codex61-sol',
    ownerUserId: 'owner-1',
    resolution: 'open',
    materialization: { state: 'not_started' },
    navigation: anchoredApprovalNavigation('source-thread'),
    createdAt: Date.now(),
    inlineApprovable: true,
    summary: 'Canonical original proposal',
    detail:
      feature === 'F193'
        ? {
            targetThreadId: 'target-thread',
            targetCats: ['codex61-sol'],
            content: 'Verify the original domain journey.',
            effectClass: 'assign_work',
            terminalPredicate: { kind: 'task_done' },
          }
        : feature === 'F221'
          ? {
              takeaway: 'Start with concrete evidence.',
              scene: 'When explaining completed work',
              quote: 'The original long quote.',
              dimension: 'cognitive-honesty',
              tags: ['evidence'],
              privacy: 'sensitive',
            }
          : {
              entityId: 'concept:opaque-address',
              entityType: 'concept',
              canonicalName: 'Evidence first',
              aliases: ['Evidence before claims'],
              stance: 'endorsed',
              rationale: 'Repeated explicit preference.',
            },
  };
}
async function render(feature: 'F193' | 'F221' | 'F260', locked = false) {
  await act(async () =>
    root.render(
      <ApprovalHostContext.Provider
        value={{
          ...PERMISSIVE_APPROVAL_HOST,
          presentation: 'mailbox',
          writesLocked: locked,
          authorizeWrite: () => !locked,
        }}
      >
        <ApprovalItemCard item={item(feature)} />
      </ApprovalHostContext.Provider>,
    ),
  );
}
it.each([
  'F193',
  'F221',
  'F260',
] as const)('shows original %s facts with folded long content instead of the four generic questions', async (feature) => {
  await render(feature);
  expect(container.textContent).not.toContain('原提议未说明原因');
  const details = container.querySelector('details');
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  if (feature === 'F193') {
    expect(container.textContent).toContain('Research discussion');
    expect(container.textContent).toContain('Implementation discussion');
    expect(container.textContent).not.toContain('target-thread');
  }
  if (feature === 'F221') {
    expect(container.textContent).toContain('Start with concrete evidence.');
    expect(container.textContent).toContain('When explaining completed work');
    expect(container.textContent).toContain('Sensitive');
    expect(details?.textContent).toContain('The original long quote.');
  }
  if (feature === 'F260') {
    expect(container.textContent).toContain('Evidence before claims');
    expect(container.textContent).toContain('Endorsed');
    const identity = container.querySelector<HTMLDetailsElement>('[data-testid="entity-proposal-identity"]');
    expect(identity?.open).toBe(false);
    expect(identity?.textContent).toContain('concept:opaque-address');
  }
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(button?.style.background).toBe('var(--shell-primary)');
  await act(async () => button?.click());
  expect(actions.approve).toHaveBeenCalledWith('owned-domain-proposal');
});
it.each(['F193', 'F221', 'F260'] as const)('keeps the original %s writer behind its host lock', async (feature) => {
  await render(feature, true);
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(actions.approve).not.toHaveBeenCalled();
});
