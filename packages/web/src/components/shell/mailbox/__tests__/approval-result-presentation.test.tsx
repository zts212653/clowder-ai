import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell-language';
import { describeReconcile, INITIAL_RECONCILE, type ReconcileState } from '../approval-reconcile';
import { createApprovalSessions } from '../approval-sessions';
import { RetainedResult } from '../RetainedResults';
import { approvalRow, okRead, storeItem, visibleApproval } from './mailbox-fixtures';

vi.mock('../approval-heading', () => ({
  useApprovalHeading: () => ({ lead: 'New conversation', title: '**A real result**' }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(apiFetch).mockReset();
});
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});

it.each([
  ['zh', '已拒绝 · 你'],
  ['en', 'Rejected · You'],
] as const)('formats the authenticated owner in %s without changing canonical metadata', (language, expected) => {
  const state: ReconcileState = { kind: 'decided', terminal: { resolution: 'rejected', decidedBy: 'default-user' } };
  expect(describeReconcile(state, { ownerUserId: 'default-user', language })).toEqual({
    line: expected,
    actions: 'gone',
    canReread: false,
  });
  expect(state.terminal.decidedBy).toBe('default-user');
});

it('does not present an unverified opaque decider address as a name', () => {
  const view = describeReconcile(
    { kind: 'decided', terminal: { resolution: 'accepted', decidedBy: 'other-owner-731' } },
    { ownerUserId: 'default-user', language: 'en' },
  );
  expect(view.line).not.toContain('other-owner-731');
  expect(view.line).not.toContain('You');
  expect(view.actions).toBe('gone');
});

it('keeps an accepted decision with unknown materialization distinct from an unconfirmed decision', () => {
  const view = describeReconcile(
    { kind: 'decided', terminal: { resolution: 'accepted', effectUnknown: true } },
    { language: 'en' },
  );
  expect(view.line).toBe('Approved · Effect not yet confirmed');
  expect(view).toMatchObject({ actions: 'gone', canReread: true });
});

it('English wording retains the same 503 unknown-result lock and reread boundary', () => {
  const view = describeReconcile(
    { kind: 'still_open', write: { outcome: 'errored', status: 503 } },
    { language: 'en' },
  );
  expect(view.line).toBe('The request returned an error; rereading still shows a pending decision');
  expect(view).toMatchObject({ actions: 'held', canReread: true });
});

it('the actual retained-result consumer supplies its verified owner and live shell language', async () => {
  const item = storeItem({ ownerUserId: 'default-user' });
  const row = approvalRow(item);
  const read = okRead([row], { identity: { ownerUserId: 'default-user' } });
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: vi.fn(),
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: read, generation: 1 }),
    now: () => 1_000_000,
  });
  const session = sessions.open({
    ownerUserId: 'default-user',
    decisionRef: row.decisionRef,
    approval: visibleApproval(item),
  });
  session.model = {
    ...INITIAL_RECONCILE,
    state: {
      kind: 'decided',
      terminal: {
        resolution: 'rejected',
        decidedBy: 'default-user',
        decidedAt: new Date(2026, 9, 22, 5, 44).getTime(),
      },
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    writeShellLanguage('en');
    root.render(<RetainedResult session={session} sessions={sessions} />);
  });
  expect(container.querySelector('[data-testid="proposal-result-label"]')?.textContent).toBe('Declined · 05:44');
  expect(container.querySelector('[data-testid="proposal-result-details"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="thread-proposal-result"] button')?.click(),
  );
  expect(container.textContent).not.toContain('default-user');
  expect(container.querySelector('[data-testid="mailbox-retained-dismiss"]')?.textContent).toBe('Got it');
  expect(container.textContent).not.toContain('**A real result**');
  expect(container.querySelector('strong')?.textContent).toBe('A real result');
  await act(async () => {
    session.model = { ...INITIAL_RECONCILE, state: { kind: 'unconfirmed', why: 'left_the_list' } };
    root.render(<RetainedResult session={session} sessions={sessions} />);
  });
  expect(container.querySelector('[data-testid="mailbox-retained-reread"]')?.textContent).toBe('Read again');
});

async function domainResult(kind: 'F225' | 'F231', body: unknown, ok = true, effectUnknown = true) {
  vi.mocked(apiFetch).mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => body } as Response);
  const item = storeItem({
    sourceFeatureId: kind,
    proposalId: 'owned-result',
    detail: { sourceSessionId: 'original-session' },
  });
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: vi.fn(),
    refreshStore: async () => {},
    storeItems: () => [],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([]), generation: 1 }),
    now: Date.now,
  });
  const session = sessions.open({
    ownerUserId: 'owner-1',
    decisionRef: 'approval:owned-result',
    approval: visibleApproval(item),
  });
  session.model = {
    ...INITIAL_RECONCILE,
    state: {
      kind: 'decided',
      terminal: { resolution: 'accepted', ...(effectUnknown ? { effectUnknown: true } : {}), decidedBy: 'owner-1' },
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    writeShellLanguage('en');
    root.render(<RetainedResult session={session} sessions={sessions} />);
  });
  return { container, session };
}

it.each([
  'F225',
  'F231',
] as const)('confirms the retained %s effect with its original owner status route without rewriting generic lifecycle', async (kind) => {
  const body =
    kind === 'F225'
      ? { proposal: { proposalId: 'owned-result', status: 'approved', sealedSessionId: 'original-session' } }
      : { proposalId: 'owned-result', status: 'approved' };
  const { container, session } = await domainResult(kind, body);
  const line = container.querySelector('[data-testid="mailbox-retained-line"]')?.textContent;
  expect(line).toContain(kind === 'F225' ? 'Handoff started' : 'Profile written');
  expect(line).not.toContain('not yet confirmed');
  expect(line).toContain('You');
  expect(session.model.state).toMatchObject({ kind: 'decided', terminal: { effectUnknown: true } });
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(
    `/api/${kind === 'F225' ? 'session-handoff' : 'profile-updates'}/owned-result`,
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it.each([
  'F225',
  'F231',
] as const)('reads the original %s effect when canonical history omits the generic unknown flag', async (kind) => {
  const body =
    kind === 'F225'
      ? { proposal: { proposalId: 'owned-result', status: 'approved', sealedSessionId: 'original-session' } }
      : { proposalId: 'owned-result', status: 'approved' };
  const { container, session } = await domainResult(kind, body, true, false);
  expect(container.querySelector('[data-testid="mailbox-retained-line"]')?.textContent).toContain(
    kind === 'F225' ? 'Handoff started' : 'Profile written',
  );
  expect(container.textContent).toContain(kind === 'F225' ? 'Session handoff' : 'Profile update');
  expect(container.textContent).not.toContain('A real result');
  expect(session.model.state).toMatchObject({ kind: 'decided', terminal: { resolution: 'accepted' } });
  if (session.model.state.kind === 'decided') expect(session.model.state.terminal?.effectUnknown).toBeUndefined();
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it.each([
  ['F225', { proposal: { proposalId: 'foreign', status: 'approved', sealedSessionId: 'original-session' } }, true],
  ['F225', { proposal: { proposalId: 'owned-result', status: 'approved', sealedSessionId: 'foreign-session' } }, true],
  ['F225', { proposal: { proposalId: 'owned-result', status: 'pending' } }, true],
  ['F231', { proposalId: 'foreign', status: 'approved' }, true],
  ['F231', { proposalId: 'owned-result', status: 'approving' }, true],
  ['F231', { error: 'unavailable' }, false],
] as const)('does not invent a retained effect for %s from a missing or contradictory original receipt', async (kind, body, ok) => {
  const { container } = await domainResult(kind, body, ok);
  expect(container.querySelector('[data-testid="mailbox-retained-line"]')?.textContent).toBe(
    'Approved · Effect not yet confirmed · You',
  );
  expect(container.querySelector('[data-testid="mailbox-retained-reread"]')).not.toBeNull();
});

it('the retained person-memory result names the exact person after the pending card retires', async () => {
  const item = storeItem({
    sourceFeatureId: 'F276',
    proposalId: 'person_candidate_result',
    decisionMode: 'claim-select',
    detail: { displayName: 'Lin original' },
  });
  if (item.navigation.state !== 'anchored') throw new Error('fixture must be anchored');
  const messageId = item.navigation.approvalCardRef.messageId;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(
      String(path) === '/api/session'
        ? { userId: 'owner-1' }
        : {
            proposalId: item.proposalId,
            status: 'materialized',
            remainingDraftIds: [],
            publicationState: 'anchored',
            approvalCardMessageId: messageId,
            decisionReceipt: {
              decisionId: 'exact-write',
              materializedClaimIds: ['claim-1'],
              materializedRelationshipIds: [],
              materializedEventIds: [],
            },
          },
    ),
  );
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([]), generation: 1 }),
    now: Date.now,
  });
  const session = sessions.open({
    ownerUserId: 'owner-1',
    decisionRef: 'approval:person-result',
    approval: visibleApproval(item),
  });
  session.model = {
    ...INITIAL_RECONCILE,
    state: { kind: 'decided', terminal: { resolution: 'accepted', decidedBy: 'owner-1' } },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    writeShellLanguage('en');
    root.render(<RetainedResult session={session} sessions={sessions} />);
  });
  expect(container.querySelector('[data-testid="mailbox-retained-result"]>div')?.textContent).toContain('Lin original');
  expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
});
