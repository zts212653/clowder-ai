import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ApprovalHost, useApprovalHost } from '@/components/ApprovalHost';
import { approvalResultRead } from '@/lib/approval-result-read';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { storeItem } from '../../shell/mailbox/__tests__/mailbox-fixtures';
import { retainSettledResult } from '../../shell/mailbox/approval-history-page-source';
import { useThreadProposalRead } from '../../shell/mailbox/thread-proposal-read';
import { ProposalCardChat } from '../ProposalCardChat';

const network = vi.hoisted(() => vi.fn());
let producerHost: ApprovalHost;
vi.mock('@/utils/api-client', () => ({ apiFetch: network }));
vi.mock('../ProposalCardProducer', () => ({
  ProposalCardProducer: ({ proposal }: { proposal: { status: string } }) => {
    producerHost = useApprovalHost();
    return <output data-testid="producer-result">{proposal.status}</output>;
  },
}));
const proposal = {
  proposalId: 'same',
  createdBy: 'owner',
  createdAt: 1,
  sourceThreadId: 'source',
  sourceCatId: 'codex61-sol',
  title: 'Actual proposal',
  reason: 'Need a discussion',
  parentThreadId: 'source',
  projectPath: '/isolated',
  preferredCats: ['codex61-sol'],
  status: 'pending',
  cardMessageId: 'card',
};
const block = {
  kind: 'card' as const,
  v: 1 as const,
  id: 'proposal:same',
  title: 'Original',
  actions: [{ label: 'Agree', action: 'propose:approve', payload: { proposalId: 'same' } }],
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  approvalResultRead.clear();
  observeApiSessionOwner('owner');
  network.mockReset();
  network.mockResolvedValue(Response.json({ proposal }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  approvalResultRead.clear();
  observeApiSessionOwner(null);
});
const card = () => <ProposalCardChat block={block} messageId="card" />;
const mailboxItem = () =>
  storeItem({
    ownerUserId: 'owner',
    requesterCatId: proposal.sourceCatId,
    proposalId: 'same',
    sourceFeatureId: 'F128',
    createdAt: 1,
    detail: proposal,
  });
function MailboxReader() {
  const read = useThreadProposalRead(mailboxItem());
  return <output data-testid="mailbox-proposal-read">{read.proposal ? 'pending' : 'closed'}</output>;
}
const observeRejected = () =>
  retainSettledResult({
    ...mailboxItem(),
    resolution: 'rejected',
    decidedAt: 2,
    decidedBy: 'owner',
    materialization: { state: 'not_started' },
  });

it('a mounted mailbox withdraws its pending writer from a new canonical terminal without another native GET', async () => {
  await act(async () => root.render(<MailboxReader />));
  expect(host.textContent).toBe('pending');
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => observeRejected());
  expect(host.textContent).toBe('closed');
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  await act(async () => root.render(<MailboxReader />));
  expect(network).toHaveBeenCalledTimes(1);
});

it('unmount/remount keeps the result and issues one proposal GET', async () => {
  await act(async () => root.render(card()));
  expect(host.textContent).toBe('pending');
  await act(async () => root.render(null));
  await act(async () => root.render(card()));
  expect(network).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe('pending');
  expect(host.textContent).not.toContain('正在核对');
});

it('joins an event refresh already started by the original writer instead of starting a second end-of-write GET', async () => {
  await act(async () => root.render(card()));
  const answers: Array<(value: Response) => void> = [];
  network.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
  await act(async () => {
    producerHost.reportRequest({ phase: 'start', kind: 'producer-card' });
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: 'same' } }));
    await Promise.resolve();
    producerHost.reportRequest({ phase: 'end', kind: 'producer-card', outcome: 'settled' });
  });
  expect(network).toHaveBeenCalledTimes(2);
  await act(async () =>
    answers.forEach((resolve) => resolve(Response.json({ proposal: { ...proposal, status: 'rejected' } }))),
  );
});
it('N cards for one proposal share one request, including one coalesced event refresh', async () => {
  await act(async () => root.render(Array.from({ length: 8 }, (_, i) => <span key={i}>{card()}</span>)));
  expect(network).toHaveBeenCalledTimes(1);
  let resolve!: (response: Response) => void;
  network.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  await act(async () => {
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: 'same' } }));
  });
  expect(network).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('[data-testid="producer-result"]')).toHaveLength(8);
  expect(host.textContent).not.toContain('正在核对');
  await act(async () => resolve(Response.json({ proposal: { ...proposal, status: 'rejected' } })));
  expect(host.textContent).toBe('rejected'.repeat(8));
});
it.each([
  'rejected',
  'withdrawn',
  'approved',
])('an already observed %s result issues zero mount requests', async (status) => {
  approvalResultRead.seed({ owner: 'owner', producer: 'F128', proposalId: 'same' }, 'native', {
    proposal: { ...proposal, status, ...(status === 'approved' ? { createdThreadId: 'child' } : {}) },
  });
  await act(async () => root.render(card()));
  expect(network).not.toHaveBeenCalled();
  expect(host.textContent).toBe(status);
});
it('an owner change withdraws the old result and refuses its late response', async () => {
  let resolve!: (value: Response) => void;
  network.mockImplementation(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  await act(async () => root.render(card()));
  const old = resolve;
  await act(async () => observeApiSessionOwner('other'));
  await act(async () => old(Response.json({ proposal: { ...proposal, status: 'approved' } })));
  expect(host.textContent).not.toContain('approved');
  expect(
    approvalResultRead.snapshot({ owner: 'owner', producer: 'F128', proposalId: 'same' }, 'native').value,
  ).toBeUndefined();
});
