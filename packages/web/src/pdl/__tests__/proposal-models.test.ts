import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalResultRead } from '@/lib/approval-result-read';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import {
  decideProposal,
  type ProposalBinding,
  proposalTarget,
  proposalView,
  readProposal,
  recheckProposal,
  requestProposalRevision,
} from '../proposal-models';

const transport = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/approval-producer-read', () => ({ readApprovalProducerBody: transport.read }));
vi.mock('@/utils/api-client', () => ({ apiFetch: transport.post }));
const target = {
  feature: 'F128' as const,
  id: 'proposal-1',
  threadId: 'thread-1',
  mid: 'message-1',
  blockId: 'block-1',
};
const record = () => ({
  proposalId: target.id,
  status: 'pending',
  sourceThreadId: target.threadId,
  sourceCatId: 'codex',
  sourceInvocationId: 'turn-1',
  cardMessageId: target.mid,
  title: '新对话',
  reason: '拆分任务',
  parentThreadId: target.threadId,
  preferredCats: ['codex'],
  projectPath: '/project',
  createdBy: 'owner-1',
  createdAt: 1,
});
beforeEach(() => {
  vi.clearAllMocks();
  approvalResultRead.clear();
  observeApiSessionOwner('owner-1');
  transport.read.mockResolvedValue({ proposal: record() });
  transport.post.mockResolvedValue({ ok: true, json: async () => ({ threadId: 'created-thread' }) });
});

describe('producer-specific proposal bindings', () => {
  it('reads the native profile proposal and submits its decision to the original writer', async () => {
    const block = {
      v: 1 as const,
      kind: 'card' as const,
      id: 'profile-update-profile-1',
      title: 'Profile',
      meta: { approval: { producerId: 'F231', canonicalProposalId: 'profile-1' } },
    };
    const profile = proposalTarget(block, 'thread-1', 'message-1')!;
    transport.read.mockResolvedValue({
      proposal: {
        ...record(),
        proposalId: 'profile-1',
        targetLayer: 'relationship',
        targetPath: 'primer.md',
        beforeContent: 'before',
        afterContent: 'after',
        rationale: 'owner change',
      },
    });
    const original = await readProposal(profile),
      refresh = vi.fn();
    const binding = { target: profile, record: original, current: true, refresh };
    expect(proposalView(binding, false, true, {})).toMatchObject({
      canEditInPlace: false,
      canRequestChange: true,
      asking: true,
    });
    const send = vi.fn(async () => true);
    await requestProposalRevision(binding, '请修正这段画像', send);
    expect(send).toHaveBeenCalledWith('codex', '请修正这段画像');
    expect(transport.post).not.toHaveBeenCalled();
    await decideProposal({ target: profile, record: original, current: true, refresh }, 'approve');
    expect(transport.post).toHaveBeenLastCalledWith(
      '/api/profile-updates/profile-1/approve',
      expect.objectContaining({ body: '{}' }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('reads and verifies the owner and original publication before enabling writes', async () => {
    expect((await readProposal(target)).proposalId).toBe(target.id);
    transport.read.mockResolvedValue({ proposal: { ...record(), createdBy: 'other-owner' } });
    await expect(readProposal(target)).rejects.toThrow('来源');
    transport.read.mockResolvedValue({ proposal: { ...record(), cardMessageId: 'other-message' } });
    await expect(readProposal(target)).rejects.toThrow('来源');
    expect(transport.post).not.toHaveBeenCalled();
  });
  it('refuses a stale decision and does not infer a terminal result from a missing pending item', async () => {
    const original = await readProposal(target);
    transport.read.mockResolvedValue({ proposal: { ...record(), status: 'withdrawn' } });
    await expect(
      decideProposal({ target, record: original, current: true, refresh: vi.fn() }, 'approve'),
    ).rejects.toThrow('已变化');
    expect(transport.post).not.toHaveBeenCalled();
  });
  it('uses F128 overrides on its actual endpoint and re-reads after success', async () => {
    const original = await readProposal(target),
      refresh = vi.fn();
    await decideProposal({ target, record: original, current: true, refresh }, 'approve', {
      title: '调整后',
      parentThreadId: 'thread-1',
      preferredCats: 'codex, sol',
      projectPath: '/project',
      initialMessage: '开始',
      reportingMode: 'final-only',
      declaredWorkMode: 'subtask',
    });
    const [url, init] = transport.post.mock.calls[0];
    expect(url).toBe('/api/proposals/proposal-1/approve');
    expect(JSON.parse(init.body)).toMatchObject({
      preferredCats: ['codex', 'sol'],
      title: '调整后',
      initialMessage: '开始',
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('recognizes Session handoff as a different producer and never sends it to the thread proposal writer', async () => {
    const block = {
      id: 'handoff-block',
      v: 1 as const,
      kind: 'card' as const,
      title: '接力',
      actions: [{ label: '同意', action: 'handoff:approve', payload: { proposalId: 'handoff-1' } }],
    };
    const handoff = proposalTarget(block, 'thread-1', 'message-1')!;
    transport.read.mockResolvedValue({
      proposal: {
        proposalId: 'handoff-1',
        kind: 'session_handoff',
        sourceThreadId: 'thread-1',
        cardMessageId: 'message-1',
        userId: 'owner-1',
        status: 'pending',
        note: {},
        createdAt: 1,
      },
    });
    await decideProposal(
      { target: handoff, record: await readProposal(handoff), current: true, refresh: vi.fn() },
      'reject',
    );
    expect(transport.post.mock.calls[0][0]).toBe('/api/session-handoff/handoff-1/reject');
  });
});

describe('uncertain proposal approval recovery', () => {
  it.each([
    'network',
    'body',
    'server',
  ] as const)('blocks all hosts after an unknown %s response until explicit pending readback', async (loss) => {
    const binding: ProposalBinding = { target, record: await readProposal(target), current: true, refresh: vi.fn() };
    if (loss === 'network') transport.post.mockRejectedValueOnce(new Error('lost'));
    else
      transport.post.mockResolvedValueOnce({
        ok: loss !== 'server',
        json: async () => {
          if (loss === 'body') throw new Error('lost body');
          return { error: 'unknown commit' };
        },
      });
    const invalidated = vi.fn();
    window.addEventListener('cat-cafe:thread-attention-invalidated', invalidated);
    try {
      await expect(decideProposal(binding, 'approve')).rejects.toThrow();
      expect(invalidated).toHaveBeenCalledOnce();
      const otherHost: ProposalBinding = { target, record: binding.record, current: true, refresh: vi.fn() };
      expect(proposalView(otherHost, true, true, {})).toMatchObject({
        canApprove: false,
        rejectable: false,
        canRequestChange: false,
        editing: false,
        recovery: 'uncertain',
        canReadback: true,
      });
      await expect(decideProposal(otherHost, 'approve')).rejects.toThrow('proposalRecovery.blocked');
      await expect(requestProposalRevision(otherHost, 'change')).rejects.toThrow('proposalRecovery.blocked');
      await recheckProposal(otherHost, false);
      await expect(decideProposal(otherHost, 'approve')).rejects.toThrow('proposalRecovery.blocked');
      expect(transport.post).toHaveBeenCalledOnce();
      await recheckProposal(otherHost);
      expect(proposalView(otherHost, false, false, {})).toMatchObject({ recovery: 'retryable', canApprove: true });
      await decideProposal(otherHost, 'approve');
      expect(transport.post).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('cat-cafe:thread-attention-invalidated', invalidated);
    }
  });
  it('keeps unknown/approving reads blocked and publishes canonical approved status, created thread and Group readback', async () => {
    const binding: ProposalBinding = { target, record: await readProposal(target), current: true, refresh: vi.fn() };
    transport.post.mockRejectedValueOnce(new Error('lost'));
    await expect(decideProposal(binding, 'approve')).rejects.toThrow();
    transport.read.mockResolvedValueOnce({ proposal: { ...record(), status: 'approving' } });
    await recheckProposal(binding);
    expect(proposalView(binding, false, false, {})?.canApprove).toBe(false);
    const placement = vi.fn(),
      update = vi.fn();
    window.addEventListener('cat-cafe:proposal-updated', placement);
    window.addEventListener('cat-cafe:proposal-updated', update);
    try {
      transport.read.mockResolvedValue({
        proposal: { ...record(), status: 'approved', createdThreadId: 'created', attentionGroupId: 'group' },
      });
      await recheckProposal(binding);
      expect(update.mock.calls[0][0].detail).toEqual({
        proposalId: target.id,
        status: 'approved',
        createdThreadId: 'created',
      });
      expect(placement).toHaveBeenCalledOnce();
      expect(proposalView(binding, false, false, {})).toMatchObject({
        recovery: 'placement',
        canApprove: false,
        canReadback: true,
      });
      await recheckProposal(binding);
      expect(placement).toHaveBeenCalledTimes(2);
      expect(transport.post).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('cat-cafe:proposal-updated', placement);
      window.removeEventListener('cat-cafe:proposal-updated', update);
    }
  });
  it('fences a readback that crosses identity changes and keeps writes blocked during the read', async () => {
    const binding: ProposalBinding = { target, record: await readProposal(target), current: true, refresh: vi.fn() };
    transport.post.mockRejectedValueOnce(new Error('lost'));
    await expect(decideProposal(binding, 'approve')).rejects.toThrow();
    let finish!: (value: unknown) => void;
    transport.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = recheckProposal(binding);
    await expect(decideProposal(binding, 'approve')).rejects.toThrow('proposalRecovery.blocked');
    observeApiSessionOwner('other-owner');
    finish({ proposal: { ...record(), createdBy: 'other-owner' } });
    await pending;
    expect(binding.recovery?.phase).toBe('uncertain');
    await expect(decideProposal(binding, 'approve')).rejects.toThrow('proposalRecovery.blocked');
    expect(transport.post).toHaveBeenCalledOnce();
  });
  it('carries a successful approval into sidebar placement without requiring a second write', async () => {
    const binding: ProposalBinding = { target, record: await readProposal(target), current: true, refresh: vi.fn() };
    const update = vi.fn();
    window.addEventListener('cat-cafe:proposal-updated', update);
    try {
      await decideProposal(binding, 'approve');
      expect(update.mock.calls[0][0].detail).toEqual({
        proposalId: target.id,
        status: 'approved',
        createdThreadId: 'created-thread',
      });
      expect(proposalView(binding, false, false, {})).toMatchObject({ recovery: 'placement', canApprove: false });
    } finally {
      window.removeEventListener('cat-cafe:proposal-updated', update);
    }
  });
});
