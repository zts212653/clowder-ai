import type { SettledApprovalHubItem } from '@cat-cafe/shared';
import { act, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { MailboxPanel } from '../../MailboxPanel';
import { writeShellLanguage } from '../../shell-language';
import { deriveMailboxPanelState } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import type { MailboxSection } from '../mailbox-navigation';
import { useApprovalSessions } from '../use-approval-sessions';
import { OWNER, okRead, storeItem } from './mailbox-fixtures';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));

const settled = (id: string, resolution: 'accepted' | 'rejected', owner = OWNER): SettledApprovalHubItem => ({
  ...storeItem({ proposalId: id, sourceFeatureId: 'F128', summary: `Traceable proposal ${id}`, detail: {} }),
  ownerUserId: owner,
  resolution,
  decidedAt: Date.now() - 1000,
  decidedBy: owner,
  materialization: { state: 'not_started' },
});
const records = [
  { ...settled('accepted', 'accepted'), decidedAt: 1793100000001 },
  { ...settled('rejected', 'rejected'), decidedAt: 1793100000000 },
];
const view: UnifiedAttentionView = {
  result: okRead([]),
  staleRead: null,
  refetch: vi.fn(),
  resultGeneration: 1,
  readsStarted: () => 1,
};
function Wrapper() {
  const [section, setSection] = useState<MailboxSection>('pending');
  const sessions = useApprovalSessions(view);
  return (
    <MailboxPanel
      anchor={createRef()}
      state={deriveMailboxPanelState(view.result)}
      view={view}
      sessions={sessions}
      section={section}
      onSectionChange={setSection}
      onOpenPlace={vi.fn()}
      onClose={vi.fn()}
    />
  );
}
let host: HTMLDivElement;
let root: Root;
const click = (testId: string) =>
  act(async () => {
    document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useApprovalHubStore.setState({
    items: [],
    count: 0,
    isLoading: false,
    pendingReadAvailable: true,
    settledItems: [],
    settledIsLoading: false,
    settledError: null,
    selectedIds: new Set(),
    decisionAttempts: {},
  });
  mocks.fetch.mockImplementation(async (url: string) =>
    url === '/api/session'
      ? Response.json({ userId: OWNER })
      : url.startsWith('/api/approval-hub/settled/page?')
        ? Response.json({
            items: records,
            count: records.length,
            identity: { ownerUserId: OWNER },
            manifest: [{ id: 'F128' }],
            page: { limit: 30, nextCursor: null, hasMore: false },
            coverage: { state: 'complete', orderVersion: 1, sources: ['F128'] },
          })
        : Response.json({ items: [], count: 0 }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  mocks.fetch.mockReset();
  vi.unstubAllGlobals();
});

it.each(['zh', 'en'] as const)('keeps long-lived history out of the pending page (%s)', async (language) => {
  writeShellLanguage(language);
  await act(async () => root.render(<Wrapper />));
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/approval-hub/settled'))).toHaveLength(0);
  expect(document.querySelector('[data-testid="mailbox-settled-results"]')).toBeNull();
  expect(document.querySelector('[data-testid="mailbox-records"]')).toBeNull();
  expect(document.querySelector('[data-testid="mailbox-open-ignored"]')).toBeNull();
  expect(document.querySelector('[data-testid="mailbox-history"]')?.textContent).toContain(
    language === 'en' ? 'Handled' : '已处理的',
  );
});

it.each([
  'zh',
  'en',
] as const)('opens one on-demand history with recognizable subjects and no old approval UI (%s)', async (language) => {
  writeShellLanguage(language);
  await act(async () => root.render(<Wrapper />));
  await click('mailbox-history');
  expect(document.querySelector('[data-testid="mailbox-handled-history"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="approval-panel"]')).toBeNull();
  expect(document.querySelector('[data-testid="approval-tab-pending"]')).toBeNull();
  const rows = document.querySelectorAll('[data-testid="mailbox-history-row"]');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Traceable proposal accepted');
  expect(rows[1]?.textContent).toContain('Traceable proposal rejected');
  const reads = mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/approval-hub/settled'));
  expect(reads).toHaveLength(1);
  expect(String(reads[0][0])).toContain('limit=30');
  expect(document.querySelector('[data-testid="mailbox-panel"]')?.textContent).not.toContain('default-user');
  const resultFilter = document.querySelector<HTMLButtonElement>('[role="combobox"]');
  expect(resultFilter).not.toBeNull();
  await act(async () => resultFilter?.click());
  const accepted = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent?.trim() === (language === 'en' ? 'Approved' : '已同意'),
  );
  expect(accepted).toBeDefined();
  await act(async () => accepted?.click());
  expect(document.querySelectorAll('[data-testid="mailbox-history-row"]')).toHaveLength(1);
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/approval-hub/settled'))).toHaveLength(1);
  expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0);
});

it('keeps canonical descending tie order and names both visible filters', async () => {
  writeShellLanguage('zh');
  const old = mocks.fetch.getMockImplementation();
  const tied = ['z-newest-key', 'a-older-key'].map((id) => ({
    ...settled(id, 'rejected'),
    decidedAt: 1793100000000,
    detail: {
      rejectionReason: '缺少原始证据',
      reason: '保留原始依据，展开后才读长内容。',
      projectPath: '/private/history-project',
      parentThreadId: 'source-thread',
      title: 'Traceable proposal',
      preferredCats: ['codex61-sol'],
    },
  }));
  mocks.fetch.mockImplementation(async (url: string, ...args: unknown[]) =>
    url.startsWith('/api/approval-hub/settled/page?')
      ? Response.json({
          items: tied,
          count: 2,
          identity: { ownerUserId: OWNER },
          manifest: [{ id: 'F128' }],
          page: { limit: 30, nextCursor: null, hasMore: false },
          coverage: { state: 'complete', orderVersion: 1, sources: ['F128'] },
        })
      : old?.(url, ...args),
  );
  await act(async () => root.render(<Wrapper />));
  await click('mailbox-history');
  expect(
    [...document.querySelectorAll('[data-testid="mailbox-history-row"]')].map((row) =>
      row.getAttribute('data-proposal-id'),
    ),
  ).toEqual(['z-newest-key', 'a-older-key']);
  expect([...document.querySelectorAll('[role="combobox"]')].map((button) => button.textContent)).toEqual([
    '结果 ⌄',
    '种类 ⌄',
  ]);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid="mailbox-history-row"] button')?.click(),
  );
  expect(document.querySelector('[data-testid="mailbox-panel"]')?.textContent).toContain('理由：缺少原始证据');
  const technical = document.querySelector<HTMLDetailsElement>('[data-testid="handled-technical-details"]');
  expect(technical).not.toBeNull();
  expect(technical?.open).toBe(false);
  expect(technical?.textContent).toContain('history-project');
  const reason = document.querySelector<HTMLDetailsElement>('[data-testid="handled-reason"]');
  expect(reason?.open).toBe(false);
  expect(reason?.textContent).toContain('保留原始依据');
  await act(async () => {
    if (technical) technical.open = true;
  });
  expect(technical?.open).toBe(true);
});
