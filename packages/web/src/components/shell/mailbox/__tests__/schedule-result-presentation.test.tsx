import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { coordinate, ok, scheduleItem, scheduleProposal } from '@/components/rich/__tests__/schedule-approval.fixture';
import { apiFetch } from '@/utils/api-client';
import { INITIAL_RECONCILE } from '../approval-reconcile';
import { createApprovalSessions } from '../approval-sessions';
import { RetainedResult } from '../RetainedResults';
import { okRead, visibleApproval } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
it.each([
  { matches: true, kind: 'create' },
  { matches: false, kind: 'create' },
  { matches: true, kind: 'update' },
  { matches: false, kind: 'update' },
])('retained scheduled-task effect uses exact private owner/publication: $kind match=$matches', async ({
  matches,
  kind,
}) => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const p = scheduleProposal('approved');
  if (kind === 'update' && p.mutation.kind === 'create') {
    const taskSnapshot = { ...p.mutation.task, trigger: { type: 'interval' as const, ms: 60_000 } };
    p.mutation = {
      kind: 'update',
      taskId: taskSnapshot.id,
      taskSnapshot,
      expectedFingerprint: 'before',
      params: { text: 'updated' },
    };
    p.effectCheckpoint = {
      kind: 'update',
      taskId: taskSnapshot.id,
      expectedFingerprint: 'before',
      resultingFingerprint: 'after',
      appliedAt: 1900,
    };
  }
  const item = scheduleItem(p);
  if (!matches && p.publication.state === 'anchored')
    p.publication.envelope.approvalCardRef = { ...coordinate, messageId: 'foreign-card' };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/session'
      ? ok({ userId: 'owner-1' })
      : String(path).startsWith('/api/schedule-proposals/')
        ? ok({ proposal: p })
        : ok({ items: [] }),
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
    decisionRef: 'approval:schedule-1',
    approval: visibleApproval(item),
  });
  session.model = {
    ...INITIAL_RECONCILE,
    state: { kind: 'decided', terminal: { resolution: 'accepted', decidedBy: 'owner-1', decidedAt: 2000 } },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RetainedResult session={session} sessions={sessions} />));
    const line = container.querySelector('[data-testid="mailbox-retained-line"]')?.textContent;
    expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    if (matches) expect(line).toContain(kind === 'update' ? '定时任务参数已更新' : '定时任务已创建并注册');
    else {
      expect(line).toContain('效果暂未确认');
      expect(container.querySelector('[data-testid="mailbox-retained-reread"]')).not.toBeNull();
    }
    expect(container.textContent).not.toContain('owner-1');
    expect(container.textContent).toContain('定时任务: Read the evidence');
    expect(container.textContent).not.toMatch(/(?:Create|Delete|Update) schedule:/);
    expect(session.model.state.kind === 'decided' ? session.model.state.terminal.effectUnknown : true).toBeUndefined();
    expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
