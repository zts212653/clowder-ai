import type { ApprovalHubItem, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import { readCorrectionMemory, readPublishedCorrection } from '@/components/memory/page/read-correction-approval';
import { readDomainApprovalSource } from '@/components/rich/read-domain-approval-source';
import { readEvalRepairPending, readEvalRepairResult } from '@/components/rich/read-eval-repair';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import {
  decideMemoryMessage,
  memoryMessageView,
  readMemoryMessage,
  resolveMemoryEntity,
} from '../memory-message-proposals';
import { messageCards } from '../message-cards';
import { fixtureData } from './chat-fixture';

vi.mock('@/components/memory/page/read-correction-approval', async (original) => ({
  ...(await original<object>()),
  readPublishedCorrection: vi.fn(),
  readCorrectionMemory: vi.fn(),
}));
vi.mock('@/components/rich/read-domain-approval-source', async (original) => ({
  ...(await original<object>()),
  readDomainApprovalSource: vi.fn(),
}));
vi.mock('@/lib/approval-producer-read', () => ({ readApprovalProducerBody: vi.fn() }));
vi.mock('@/components/rich/read-eval-repair', () => ({
  readEvalRepairPending: vi.fn(),
  readEvalRepairResult: vi.fn(),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it.each([
  'polysemy',
  'correct',
  'transfer',
])('submits %s with the reread fingerprint and all required names, then waits for the native resolution receipt', async (action) => {
  const block = {
    v: 1 as const,
    kind: 'card' as const,
    id: 'entity-block',
    title: 'Entity',
    meta: { approval: { producerId: 'F260', canonicalProposalId: 'entity-1' } },
  };
  const conflict = {
    version: 1 as const,
    reason: 'existing-entity-change' as const,
    fingerprint: 'b'.repeat(64),
    incoming: {
      entityId: 'concept:new',
      canonicalName: 'Name',
      aliases: [],
      stance: 'endorsed',
      visibilityScope: 'private',
      status: 'active',
    },
    candidates: ['first', 'second'].map((key) => ({
      entityId: 'concept:' + key,
      canonicalName: key,
      aliases: [],
      stance: 'endorsed',
      visibilityScope: 'private',
      status: 'active',
    })),
    conflictingSurfaces: [],
    canonicalReplacementRequiredFor: ['concept:first', 'concept:second'],
    allowedActions: ['polysemy' as const, 'correct' as const, 'transfer' as const, 'reject' as const],
  };
  const item: ApprovalHubItem = {
    proposalId: 'entity-1',
    sourceFeatureId: 'F260',
    ownerUserId: 'owner',
    summary: 'Entity conflict',
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'pdl-test', messageId: 'user-1' },
      approvalCardRef: { threadId: 'pdl-test', messageId: 'reply-1' },
    },
    requesterCatId: 'codex',
    resolution: 'open',
    inlineApprovable: true,
    detail: { conflict },
    materialization: { state: 'not_started' },
    createdAt: 1,
  };
  const row: UnifiedAttentionItemV1 = {
    decisionRef: 'entity-decision',
    kind: 'approval',
    summary: item.summary,
    approval: item,
    linkedNeedsMe: [],
  };
  vi.mocked(readDomainApprovalSource).mockResolvedValue({ ownerUserId: 'owner', item, row });
  useApprovalHubStore.setState({ items: [item], count: 1, error: null, decisionAttempts: {}, deciding: {} });
  const target = { feature: 'F260' as const, id: 'entity-1', threadId: 'pdl-test', mid: 'reply-1', block },
    refresh = vi.fn();
  const read = await readMemoryMessage(target, new AbortController().signal);
  const names = { 'concept:first': 'First renamed', 'concept:second': 'Second renamed' };
  const view = memoryMessageView(
    { target, read, current: true, refresh },
    {
      'entity-action-reply-1': action,
      'entity-name-reply-1-concept:first': names['concept:first'],
      'entity-name-reply-1-concept:second': names['concept:second'],
    },
  );
  expect(view.conflict?.replacements).toEqual(
    action === 'polysemy'
      ? []
      : conflict.candidates.map((c) => ({
          key: c.entityId,
          id: 'entity-name-reply-1-' + c.entityId,
          mid: 'reply-1',
          label: c.canonicalName,
          value: names[c.entityId as keyof typeof names],
        })),
  );
  const request = {
    fingerprint: conflict.fingerprint,
    action,
    ...(action === 'polysemy' ? {} : { replacementCanonicalNames: names }),
  };
  let acknowledge!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const pending = resolveMemoryEntity({ target, read, current: true, refresh }, request);
  await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect(apiFetch).toHaveBeenLastCalledWith('/api/entity-proposals/entity-1/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(refresh).not.toHaveBeenCalled();
  acknowledge(Response.json({ proposalId: 'entity-1', entityId: 'concept:new' }));
  await pending;
  expect(refresh).toHaveBeenCalledOnce();
});
it('reads an evaluation repair from its exact publication and shows a result only after the canonical result owner confirms it', async () => {
  const data = fixtureData(),
    id = 'repair-1';
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          kind: 'card',
          id: 'eval-repair-proposal-' + id,
          title: 'Repair',
          meta: { approval: { producerId: 'F266', canonicalProposalId: id } },
          actions: [
            { label: '批准', action: 'eval-repair:approve', payload: { proposalId: id } },
            { label: '拒绝', action: 'eval-repair:reject', payload: { proposalId: id } },
          ],
        },
      ],
    },
  };
  const target = messageCards(data.messages, data.threadId, 'memory')[0].target;
  vi.mocked(readEvalRepairPending).mockResolvedValue(null);
  vi.mocked(readEvalRepairResult).mockResolvedValue(null);
  expect(await readMemoryMessage(target, new AbortController().signal)).toBeNull();
  vi.mocked(readEvalRepairResult).mockResolvedValue({
    ownerUserId: 'owner',
    terminal: { resolution: 'accepted' },
    effect: 'repair-started',
  });
  const read = await readMemoryMessage(target, new AbortController().signal, true);
  expect(memoryMessageView({ target, read, current: true, refresh: vi.fn() })).toMatchObject({
    decided: true,
    result: { status: 'approved', reason: 'approved' },
  });
  expect(readEvalRepairPending).toHaveBeenLastCalledWith(
    id,
    { threadId: data.threadId, messageId: 'reply-1' },
    undefined,
    target.block,
    true,
  );
});
it('uses the original dispatch writer and retains its exact delivery witness for the subsequent canonical result read', async () => {
  const data = fixtureData();
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          id: 'dispatch-dispatch-1',
          kind: 'card',
          title: 'Assignment',
          meta: { approval: { producerId: 'F193', canonicalProposalId: 'dispatch-1' } },
        },
      ],
    },
  };
  const target = messageCards(data.messages, data.threadId, 'memory')[0].target;
  const item: ApprovalHubItem = {
    proposalId: 'dispatch-1',
    sourceFeatureId: 'F193',
    ownerUserId: 'owner',
    summary: 'Assignment',
    requesterCatId: 'codex',
    resolution: 'open',
    inlineApprovable: true,
    materialization: { state: 'not_started' },
    detail: { targetThreadId: 'target-thread' },
    createdAt: 1,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: data.threadId, messageId: 'user-1' },
      approvalCardRef: { threadId: data.threadId, messageId: 'reply-1' },
    },
  };
  const row: UnifiedAttentionItemV1 = {
    decisionRef: 'dispatch-decision',
    kind: 'approval',
    summary: item.summary,
    approval: item,
    linkedNeedsMe: [],
  };
  useApprovalHubStore.setState({ items: [item], count: 1, error: null, decisionAttempts: {}, deciding: {} });
  vi.mocked(readDomainApprovalSource).mockResolvedValue({
    ownerUserId: 'owner',
    item,
    row,
  });
  const read = await readMemoryMessage(target, new AbortController().signal),
    refresh = vi.fn();
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      proposal: {
        proposalId: 'dispatch-1',
        ownerUserId: 'owner',
        targetThreadId: 'target-thread',
        status: 'approved',
        deliveredMessageId: 'delivered-1',
      },
    }),
  );
  await decideMemoryMessage({ target, read, current: true, refresh }, 'approve');
  expect(apiFetch).toHaveBeenLastCalledWith('/api/dispatch-proposals/dispatch-1/approve', { method: 'POST' });
  expect(useApprovalHubStore.getState().decisionAttempts['dispatch-1'].state).toMatchObject({
    phase: 'response_received',
    ok: true,
    domainEffect: 'dispatch-delivered',
  });
  expect(refresh).toHaveBeenCalledOnce();
  const conflict = { ...target, feature: 'F260' as const };
  expect(
    memoryMessageView({
      target: conflict,
      read: {
        item: {
          ...item,
          detail: {
            conflict: {
              version: 1,
              reason: 'existing-entity-change',
              fingerprint: 'a'.repeat(64),
              incoming: { entityId: 'concept:new', canonicalName: 'New', aliases: [], stance: 'endorsed' },
              candidates: [],
              allowedActions: ['replace', 'reject'],
              conflictingSurfaces: [],
              canonicalReplacementRequiredFor: [],
            },
          },
        },
        status: 'pending',
        evidence: row,
        effect: false,
      },
      current: true,
      refresh,
    }),
  ).toMatchObject({ decided: true, rejectable: true, conflict: { options: [{ v: 'replace' }] } });
});
it('keeps an event correction tied to its published source and exact owner revision until the real writer settles', async () => {
  const data = fixtureData(),
    id = 'correction-1';
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          id: 'event-memory-correction-' + id,
          kind: 'card',
          title: 'Correct event',
          meta: { approval: { producerId: 'F321', canonicalProposalId: id } },
        },
      ],
    },
  };
  const target = messageCards(data.messages, data.threadId, 'memory')[0].target;
  const item = { ownerUserId: 'owner', proposalId: id, inlineApprovable: true } as Awaited<
    ReturnType<typeof readPublishedCorrection>
  >;
  const memory = {
    event: { revision: 'sha256:' + 'a'.repeat(64) },
    proposal: { proposalId: id, status: 'pending', expectedRevision: 'sha256:' + 'a'.repeat(64) },
  } as Awaited<ReturnType<typeof readCorrectionMemory>>;
  vi.mocked(readPublishedCorrection).mockResolvedValue(item);
  vi.mocked(readCorrectionMemory).mockResolvedValue(memory);
  const read = await readMemoryMessage(target, new AbortController().signal),
    refresh = vi.fn();
  let acknowledge!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const pending = decideMemoryMessage({ target, read, current: true, refresh }, 'approve');
  await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  expect(refresh).not.toHaveBeenCalled();
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/event-memory-corrections/correction-1/approve',
    expect.objectContaining({ method: 'POST', body: '{}' }),
    undefined,
  );
  acknowledge(Response.json({ proposalId: id, status: 'approved', appliedRevision: 'sha256:' + 'b'.repeat(64) }));
  await pending;
  expect(refresh).toHaveBeenCalledOnce();
  expect(memoryMessageView({ target, read, current: true, refresh })).toMatchObject({
    decided: false,
    rejectable: true,
    canEditInPlace: false,
  });
});
it('reads Taste from its own producer and refuses to submit after that owner changes', async () => {
  const data = fixtureData();
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          id: 'taste-proposal-taste-1',
          kind: 'card',
          title: 'Taste',
          meta: { approval: { producerId: 'F221', canonicalProposalId: 'taste-1' } },
        },
      ],
    },
  };
  const target = messageCards(data.messages, data.threadId, 'memory')[0].target;
  vi.mocked(readDomainApprovalSource).mockResolvedValue({
    ownerUserId: 'owner',
    item: { proposalId: 'taste-1' },
  } as Awaited<ReturnType<typeof readDomainApprovalSource>>);
  const proposal = { id: 'taste-1', userId: 'owner', threadId: data.threadId, status: 'pending', scene: 'real scene' };
  vi.mocked(readApprovalProducerBody).mockResolvedValue({ proposal });
  const read = await readMemoryMessage(target, new AbortController().signal);
  vi.mocked(readApprovalProducerBody).mockResolvedValue({ proposal: { ...proposal, scene: 'changed by owner' } });
  await expect(decideMemoryMessage({ target, read, current: true, refresh: vi.fn() }, 'reject')).rejects.toThrow(
    '已变化',
  );
  expect(apiFetch).not.toHaveBeenCalled();
});
