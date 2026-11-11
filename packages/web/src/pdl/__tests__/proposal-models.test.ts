import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import {
  decideProposal,
  proposalTarget,
  proposalView,
  readProposal,
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
