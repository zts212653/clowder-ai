import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cardRef, record as pending } from '@/components/rich/__tests__/runtime-conversation-test-fixtures';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell-language';
import { writeShellPresentation } from '../../shell-presentation';
import { MailboxSettledResults } from '../MailboxSettledResults';
import { parseSettledResults, type SettledResultItem } from '../settled-results-source';
import { settledRuntimeRecord } from '../settled-runtime-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, record: RuntimeInteractionRecord, item: SettledResultItem, owner: string;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  writeShellPresentation('v2');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  owner = 'owner';
  record = {
    ...structuredClone(pending),
    status: 'answered',
    revision: 6,
    updatedAt: 10000,
    terminal: {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 10000,
      response: { kind: 'selection', selectedIds: ['alpha'] },
    },
  };
  item = {
    sourceFeatureId: 'F306',
    proposalId: record.request.interactionId,
    ownerUserId: owner,
    requesterCatId: record.request.owner.catId,
    summary: record.request.title,
    createdAt: record.request.createdAt,
    decidedAt: 10000,
    decidedBy: owner,
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    navigation: {
      state: 'anchored',
      approvalCardRef: cardRef,
      originRef: { kind: 'message', ...cardRef },
    },
    detail: {
      runtimeKind: record.request.kind,
      runtimeReason: 'answered',
      runtimeSelectedLabels: ['Alpha'],
      runtimeRevision: 6,
      runtimeUpdatedAt: 10000,
      runtimeCardRef: record.cardRef,
      runtimeSource: record.source,
      runtimeReturnBinding: record.returnBinding,
    },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path) === '/api/session') return Response.json({ userId: owner });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [item] });
    if (String(path).includes('/runtime-interactions/')) return Response.json({ interaction: record });
    return Response.json({ error: 'not found' }, { status: 404 });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});
async function render(shownOwner = 'owner', excludedKeys: string[] = []) {
  await act(async () =>
    root.render(
      <MailboxSettledResults
        ownerUserId={shownOwner}
        generation={1}
        excludedKeys={excludedKeys}
        verifyCurrent={() => true}
      />,
    ),
  );
}
async function expand() {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
}
it('does not fan out collapsed history into per-row runtime detail reads', async () => {
  await render();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('/runtime-interactions/')),
  ).toHaveLength(0);
  await expand();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('/runtime-interactions/')),
  ).toHaveLength(1);
});
it('does not reread all-producer history for unchanged attention generations', async () => {
  await render();
  await act(async () =>
    root.render(
      <MailboxSettledResults ownerUserId="owner" generation={2} excludedKeys={[]} verifyCurrent={() => true} />,
    ),
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('/approval-hub/settled')),
  ).toHaveLength(1);
});
it('keeps fifty collapsed rows to one history read and no eager detail reads', async () => {
  const rows = [item, ...Array.from({ length: 49 }, (_, index) => ({ ...item, proposalId: `other-${index}` }))];
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/session' ? Response.json({ userId: owner }) : Response.json({ items: rows }),
  );
  await render();
  expect(container.querySelectorAll('[data-testid="mailbox-settled-result"]')).toHaveLength(50);
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(2);
});
it('continues bounded history preparation without presenting an empty success or retrying ordinary failures', async () => {
  vi.useFakeTimers();
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/session'
      ? Response.json({ userId: owner })
      : ++reads === 1
        ? Response.json({ code: 'APPROVAL_HISTORY_PREPARING' }, { status: 503 })
        : Response.json({ items: [item] }),
  );
  try {
    await render();
    expect(container.textContent).toContain('Preparing handled results');
    expect(container.textContent).not.toContain('unavailable');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain('Chose “Alpha”');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
it.each([
  'accepted',
  'rejected',
  'closed_without_decision',
] as const)('cold-restores %s person memory claims/evidence without a decision writer', async (resolution) => {
  item = {
    ...item,
    proposalId: 'person_candidate_original',
    sourceFeatureId: 'F276',
    resolution,
    materialization: { state: resolution === 'accepted' ? 'outcome_unknown' : 'not_started' },
    ...(resolution === 'closed_without_decision' ? { closedReason: 'withdrawn' as const } : {}),
    detail: {
      displayName: 'Alice',
      ...(resolution === 'accepted' ? { materialized: { claims: 1, relationships: 0, events: 0 } } : {}),
      ...(resolution === 'closed_without_decision' ? { undoApplied: true } : {}),
    },
  };
  const original = {
    kind: 'card',
    v: 1,
    id: 'person-memory-person_candidate_original',
    title: 'Original proposal',
    bodyMarkdown: '**Claim Alpha**\n\nOriginal evidence quote.',
    actions: [{ label: 'Approve', action: 'writer' }],
    meta: { candidateId: item.proposalId, approval: { producerId: 'F276', canonicalProposalId: item.proposalId } },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path) === '/api/session') return Response.json({ userId: owner });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [item] });
    if (String(path).startsWith('/api/messages?'))
      return Response.json({
        messages: [
          {
            id: cardRef.messageId,
            threadId: cardRef.threadId,
            userId: owner,
            catId: item.requesterCatId,
            extra: { rich: { blocks: [original] } },
          },
        ],
        hasMore: false,
      });
    if (String(path).startsWith('/api/person-memory-proposals/'))
      return Response.json({
        proposalId: item.proposalId,
        publicationState: 'anchored',
        approvalCardMessageId: cardRef.messageId,
        status: resolution === 'accepted' ? 'materialized' : resolution === 'rejected' ? 'rejected' : 'withdrawn',
        ...(resolution === 'closed_without_decision'
          ? {
              undoApplied: true,
              undoReceipt: {
                requestId: 'exact-undo',
                verdict: 'undone',
                undoneAt: 10000,
                candidateId: item.proposalId,
                candidateState: 'withdrawn',
              },
            }
          : {}),
        ...(resolution === 'accepted'
          ? {
              decisionReceipt: {
                decisionId: 'exact-decision',
                materializedClaimIds: ['claim'],
                materializedRelationshipIds: [],
                materializedEventIds: [],
              },
            }
          : {}),
      });
    return Response.json({}, { status: 404 });
  });
  await render();
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(2);
  const line = container.querySelector('[data-testid=decision-result-label]')?.textContent;
  expect(line).toContain('Person memory');
  expect(line).toContain('Alice');
  expect(line).toContain(
    resolution === 'accepted' ? 'Written to memory' : resolution === 'rejected' ? 'Declined' : 'This write was undone',
  );
  await expand();
  expect(container.textContent).toContain('Claim Alpha');
  expect(container.textContent).toContain('Original evidence quote.');
  expect(container.querySelectorAll('form, input, select, textarea')).toHaveLength(0);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  expect(container.querySelector('[data-testid="person-memory-undo"]') !== null).toBe(resolution === 'accepted');
});
it('keeps an accepted person-memory effect unknown when no materialization evidence is available', async () => {
  item = { ...item, sourceFeatureId: 'F276', detail: { displayName: 'Alice' } };
  await render();
  const line = container.querySelector('[data-testid=decision-result-label]')?.textContent;
  expect(line).toContain('Person memory');
  expect(line).toContain('Alice');
  expect(line).toContain('Result not yet confirmed');
  expect(line).not.toContain('Written to memory');
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(2);
});

it.each([
  'replacement',
  'rejected',
  'withdrawn',
] as const)('keeps %s after lazy disclosure instead of replaying a historical partial Undo', async (kind) => {
  const expected = kind === 'replacement' ? 'Closed' : kind === 'rejected' ? 'Declined' : 'Withdrawn';
  item = {
    ...item,
    proposalId: 'person_candidate_original',
    sourceFeatureId: 'F276',
    resolution: kind === 'rejected' ? 'rejected' : 'closed_without_decision',
    ...(kind === 'withdrawn' ? { closedReason: 'withdrawn' as const } : {}),
    materialization: { state: 'not_started' },
    detail: kind === 'replacement' ? { replacedByProposalId: 'person_candidate_replacement' } : {},
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path) === '/api/session') return Response.json({ userId: owner });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [item] });
    if (String(path).startsWith('/api/person-memory-proposals/'))
      return Response.json({
        proposalId: item.proposalId,
        publicationState: 'anchored',
        approvalCardMessageId: cardRef.messageId,
        status: kind === 'rejected' ? 'rejected' : 'withdrawn',
        ...(kind === 'replacement' ? { replacedByProposalId: 'person_candidate_replacement' } : {}),
        undoReceipt: {
          requestId: 'prior-partial-undo',
          candidateId: item.proposalId,
          candidateState: 'pending_approval',
          decisionId: 'prior-partial-decision',
          verdict: 'undone',
        },
      });
    return Response.json({}, { status: 404 });
  });
  await render();
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain(expected);
  await expand();
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain(expected);
  expect(container.textContent).not.toContain('This write was undone');
  if (kind === 'replacement') expect(container.textContent).not.toContain('Withdrawn');
  expect(container.querySelector('[data-testid=person-memory-undo]')).toBeNull();
  expect(container.querySelector('[data-testid=person-memory-undo-result]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it.each([
  true,
  false,
])('keeps prior writes and the final rejection explicit; complete quantity proof=%s', async (complete) => {
  item = {
    ...item,
    proposalId: 'person_candidate_original',
    sourceFeatureId: 'F276',
    resolution: 'rejected',
    materialization: { state: 'not_started' },
    detail: {
      hasRetainedWrites: true,
      ...(complete ? { materialized: { claims: 1, relationships: 0, events: 0 } } : {}),
    },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path) === '/api/session') return Response.json({ userId: owner });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [item] });
    if (String(path).startsWith('/api/person-memory-proposals/'))
      return Response.json({
        proposalId: item.proposalId,
        publicationState: 'anchored',
        approvalCardMessageId: cardRef.messageId,
        status: 'rejected',
        hasRetainedWrites: true,
        ...(complete ? { materialized: { claims: 1, relationships: 0, events: 0 } } : {}),
        decisionReceipt: {
          decisionId: 'earlier-partial',
          materializedClaimIds: ['claim'],
          materializedRelationshipIds: [],
          materializedEventIds: [],
        },
      });
    return Response.json({}, { status: 404 });
  });
  await render();
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain(
    complete ? 'Wrote 1 · rest declined' : 'Earlier writes remain · rest declined',
  );
  expect(container.querySelector('[data-testid=decision-result-dot]')?.getAttribute('data-status')).toBe('approved');
  await expand();
  expect(container.querySelector('[data-testid=decision-result-label]')?.textContent).toContain(
    complete ? 'Wrote 1 · rest declined' : 'Earlier writes remain · rest declined',
  );
  expect(container.querySelector('[data-testid=person-memory-undo]')).toBeNull();
});

it('cold-loads the canonical choice into a collapsed receipt, without a session or response writer', async () => {
  await render();
  expect(container.textContent).toContain('Chose “Alpha”');
  expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
  await expand();
  expect(container.textContent).toContain('Which environment?');
  expect(container.querySelectorAll('form, input, select, textarea, a[href]')).toHaveLength(0);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain('Chose “Alpha”');
  expect(container.querySelector('[data-testid="decision-result-details"]')).toBeNull();
});
it.each([
  'owner',
  'revision',
  'source',
  'card',
  'reopened',
] as const)('keeps a %s mismatch neutral without resurrecting response controls', async (kind) => {
  if (kind === 'owner')
    record = { ...record, request: { ...record.request, owner: { ...record.request.owner, userId: 'foreign' } } };
  if (kind === 'revision') record = { ...record, revision: 7 };
  if (kind === 'source')
    record = {
      ...record,
      source: { ...record.source, requesterInvocationId: 'foreign' } as RuntimeInteractionRecord['source'],
    };
  if (kind === 'card') record = { ...record, cardRef: { ...record.cardRef!, messageId: 'foreign' } };
  if (kind === 'reopened') record = { ...record, status: 'pending', terminal: undefined };
  await render();
  await expand();
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe('closed');
  expect(container.textContent).toContain('Result not yet confirmed');
  expect(container.querySelectorAll('form, input, select, textarea')).toHaveLength(0);
  expect(container.textContent).not.toContain('Chose “Alpha”');
});
it('does not duplicate an already mounted pending or retained decision', async () => {
  await render('owner', [JSON.stringify(['F306', item.proposalId])]);
  expect(container.querySelector('[data-testid="mailbox-settled-result"]')).toBeNull();
});
it('refuses foreign owners, duplicate identities, invalid closure reasons and fabricated successful effects', () => {
  expect(parseSettledResults({ items: [item] }, 'foreign')).toBeNull();
  expect(parseSettledResults({ items: [item, item] }, 'owner')).toBeNull();
  expect(parseSettledResults({ items: [{ ...item, closedReason: 'withdrawn' }] }, 'owner')).toBeNull();
  expect(
    parseSettledResults(
      { items: [{ ...item, resolution: 'rejected', materialization: { state: 'succeeded', effectProofRef: 'fake' } }] },
      'owner',
    ),
  ).toBeNull();
});
it('hides previous owner results immediately on a principal mismatch', async () => {
  await render();
  expect(container.textContent).toContain('Chose “Alpha”');
  owner = 'different-owner';
  await render('different-owner');
  expect(container.textContent).not.toContain('Chose “Alpha”');
  expect(container.textContent).toContain('Handled results are unavailable');
});
it('rejects a changed current principal after the settled read', async () => {
  owner = 'different-owner';
  await render();
  expect(container.textContent).not.toContain('Chose “Alpha”');
  expect(container.textContent).toContain('Handled results are unavailable');
});
it('strips private response text rather than replaying it into a restored receipt', () => {
  const raw = {
    ...record,
    terminal: {
      ...record.terminal,
      response: { kind: 'selection', selectedIds: ['alpha'], customInput: 'PRIVATE_TEXT' },
    },
  };
  const read = settledRuntimeRecord(raw, item);
  expect(read).not.toBeNull();
  expect(JSON.stringify(read?.terminal)).not.toContain('PRIVATE_TEXT');
});

it('keeps expanded read-only detail during a same-owner background refresh', async () => {
  await render();
  await expand();
  expect(container.querySelector('[data-testid="decision-result-details"]')).not.toBeNull();
  await act(async () =>
    root.render(
      <MailboxSettledResults ownerUserId="owner" generation={null} excludedKeys={[]} verifyCurrent={() => false} />,
    ),
  );
  expect(container.querySelector('[data-testid="decision-result-details"]')).not.toBeNull();
  expect(container.textContent).toContain('Refreshing handled results');
  expect(container.querySelectorAll('form, input, select, textarea')).toHaveLength(0);
});

it.each([
  ['F193', 'Original message delivered'],
  ['F260', 'Entity written'],
] as const)('cold %s Inbox states the proven effect before disclosure without eager GETs', async (feature, label) => {
  const proof = 'canonical-effect';
  item = {
    ...item,
    sourceFeatureId: feature,
    detail: { canonicalEffectProofRef: proof },
    materialization: { state: 'succeeded', effectProofRef: proof },
  };
  await render();
  expect(container.querySelector('[data-testid="decision-result-label"]')?.textContent).toContain(label);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([path]) => String(path).includes('/approval-hub/settled') || String(path) === '/api/session'),
  ).toBe(true);
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
});
