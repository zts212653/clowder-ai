import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { writeShellLanguage } from '../../shell-language';
import { INITIAL_RECONCILE } from '../approval-reconcile';
import { createApprovalSessions } from '../approval-sessions';
import { RetainedResult } from '../RetainedResults';
import { okRead, storeItem, visibleApproval } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => Response.json({})) }));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useApprovalHubStore.setState({ decisionAttempts: {} });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  writeShellLanguage('zh');
  vi.unstubAllGlobals();
});
for (const language of ['zh', 'en'] as const)
  it.each([
    ['F193', '派活', 'Work assignment'],
    ['F221', '品味', 'Taste'],
    ['F260', '实体', 'Entity'],
  ] as const)(`keeps the original %s kind and human facts in a ${language} retained result`, async (feature, zh, en) => {
    const item = storeItem({
      sourceFeatureId: feature,
      summary:
        feature === 'F221'
          ? 'Taste [cognitive-honesty]: Human fact'
          : feature === 'F260'
            ? 'Entity proposal: Human fact (concept)'
            : 'Work assignment: Human fact',
      detail: {
        content: 'Human fact',
        takeaway: 'Human fact',
        quote: 'Human fact',
        dimension: 'cognitive-honesty',
        canonicalName: 'Human fact',
        entityType: 'concept',
      },
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
      ownerUserId: item.ownerUserId,
      decisionRef: `approval:${item.proposalId}`,
      approval: visibleApproval(item),
    });
    session.model = {
      ...INITIAL_RECONCILE,
      state: { kind: 'decided', terminal: { resolution: 'rejected', decidedBy: item.ownerUserId } },
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    await act(async () => {
      writeShellLanguage(language);
      root.render(<RetainedResult session={session} sessions={sessions} />);
    });
    expect(container.textContent).toContain(language === 'zh' ? zh : en);
    expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
    expect(container.textContent).toContain('Human fact');
    expect(container.textContent).not.toContain('cognitive-honesty');
    expect(container.textContent).not.toContain('(concept)');
  });
