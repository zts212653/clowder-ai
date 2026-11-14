import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { writeShellLanguage } from '../../shell-language';
import { writeShellPresentation } from '../../shell-presentation';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { HandledApprovalRow } from '../HandledApprovalRow';
import { createHandledHistoryRead } from '../handled-history-read';
import { MailboxHandledHistory } from '../MailboxHandledHistory';
import { PersonProposalForgetRecovery } from '../PersonProposalForgetRecovery';
import { readPendingProposalForgets, savePendingProposalForget } from '../proposal-forget-recovery';
import type { SettledResultItem } from '../settled-results-source';
import { useMailboxPersonalPreferences } from '../use-mailbox-personal-preferences';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/use-approval-result', () => ({ useApprovalResult: () => ({ value: undefined }) }));
const item: SettledResultItem = {
  sourceFeatureId: 'F276',
  proposalId: 'person_candidate_sample',
  ownerUserId: 'owner',
  requesterCatId: 'codex61-sol',
  summary: '人物提案（内容已清除）',
  detail: {},
  navigation: { state: 'legacy_unanchored' },
  createdAt: 100,
  decidedAt: 200,
  decidedBy: 'owner',
  resolution: 'rejected',
  materialization: { state: 'not_started' },
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('zh');
  writeShellPresentation('v2');
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(apiFetch).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  observeApiSessionOwner(null);
});
const find = (text: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === text);
const render = async (current = item) => {
  await act(async () =>
    root.render(
      <ul>
        <HandledApprovalRow item={current} reread={vi.fn()} authorizeOpen={() => true} onOpenPlace={vi.fn()} />
      </ul>,
    ),
  );
};

it('keeps the confirmed owner request recoverable when an unrelated unified mailbox read fails', async () => {
  observeApiSessionOwner('owner');
  const command = {
    proposalId: item.proposalId,
    proposalIds: [item.proposalId],
    requestId: `person_forget_${'c'.repeat(32)}`,
    expectedRevision: `sha256:${'b'.repeat(64)}`,
  };
  savePendingProposalForget('owner', command);
  const view: UnifiedAttentionView = {
    result: { kind: 'failed', reason: 'unavailable' },
    staleRead: null,
    refetch: vi.fn(),
    readsStarted: () => 1,
    resultGeneration: 1,
  };
  const read = createHandledHistoryRead(async () => null);
  read.setOwner('owner');
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      outcome: 'purged',
      receipt: { requestId: command.requestId, purgedSurfaceCounts: { candidates: 1 } },
    }),
  );
  function History() {
    const personal = useMailboxPersonalPreferences(view);
    return (
      <MailboxHandledHistory
        section="history"
        view={view}
        personal={personal}
        snapshot={{ ...read.getSnapshot(), items: [], status: 'unavailable' }}
        read={read}
        onOpenPlace={vi.fn()}
        verifyCurrent={() => true}
      />
    );
  }
  await act(async () => root.render(<History />));
  const recovery = host.querySelector('[data-testid=person-proposal-forget-recovery]');
  expect(recovery?.textContent).toContain('还没确认是否已忘掉');
  await act(async () => observeApiSessionOwner('other-owner'));
  expect(recovery?.textContent).not.toContain('还没确认是否已忘掉');
  await act(async () => observeApiSessionOwner('owner'));
  expect(recovery?.textContent).toContain('还没确认是否已忘掉');
  await act(async () => recovery?.querySelector<HTMLButtonElement>('button')?.click());
  expect(readPendingProposalForgets('owner')).toEqual([]);
  expect(host.textContent).toContain('已忘掉 · 1 条提议记录');
  read.dispose();
});

it('keeps the proven approval status when a published old record has no original card', async () => {
  await render({
    ...item,
    resolution: 'accepted',
    materialization: { state: 'succeeded', effectProofRef: 'person-memory-decision:decision_sample' },
  });
  expect(host.querySelector('[data-testid=decision-result-label]')?.textContent).toBe('已同意');
  expect(find('忘掉这条提议')).toBeUndefined();
});

it('lets a published closure without a card inspect exact scope before explicitly confirming deletion', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST'
      ? Response.json({
          outcome: 'purged',
          receipt: { requestId: JSON.parse(String(init.body)).requestId, purgedSurfaceCounts: { candidates: 2 } },
        })
      : Response.json({
          outcome: 'eligible',
          count: 2,
          revision: `sha256:${'a'.repeat(64)}`,
          proposalIds: [item.proposalId, 'person_candidate_next'],
        }),
  );
  await render();
  // The action belongs to disclosure of this exact handled row, never To-do.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
  expect(find('忘掉这条提议')).toBeDefined();
  await act(async () => find('忘掉这条提议')?.click());
  expect(host.textContent).toContain('将永久删除 2 条提议');
  expect(find('确认永久遗忘')?.disabled).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await act(async () => find('确认永久遗忘')?.click());
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST');
  expect(String(post?.[0])).toContain(`/api/person-memory-proposals/${item.proposalId}/forget`);
  expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
    confirmed: true,
    expectedRevision: `sha256:${'a'.repeat(64)}`,
  });
});

it('keeps the same confirmed request after a lost response and reload without the deleted row', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method !== 'POST')
      return Response.json({
        outcome: 'eligible',
        count: 1,
        revision: `sha256:${'b'.repeat(64)}`,
        proposalIds: [item.proposalId],
      });
    const command = JSON.parse(String(init.body));
    posts.push(command);
    expect(readPendingProposalForgets('owner')[0].requestId).toBe(command.requestId);
    if (posts.length === 1) throw new TypeError('response lost after commit');
    return Response.json({
      outcome: 'purged',
      receipt: { requestId: command.requestId, purgedSurfaceCounts: { candidates: 1 } },
    });
  });
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
  await act(async () => find('忘掉这条提议')?.click());
  await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await act(async () => find('确认永久遗忘')?.click());
  expect(posts).toHaveLength(1);
  const onForgotten = vi.fn();
  await act(async () => root.render(<PersonProposalForgetRecovery owner="other-owner" onForgotten={onForgotten} />));
  expect(host.textContent).not.toContain('还没确认是否已忘掉');
  await act(async () => root.render(<PersonProposalForgetRecovery owner="owner" onForgotten={onForgotten} />));
  expect(host.textContent).toContain('还没确认是否已忘掉');
  expect(posts).toHaveLength(1);
  await act(async () => find('再试一次')?.click());
  expect(posts[1]).toEqual(posts[0]);
  expect(onForgotten).toHaveBeenCalledWith([item.proposalId], 1);
  expect(readPendingProposalForgets('owner')).toEqual([]);
});
